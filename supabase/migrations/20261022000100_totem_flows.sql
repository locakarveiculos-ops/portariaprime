-- =============================================================================
-- PORTARIA PRIME — totem da equipe: recebimento com conferência do destinatário
-- e guarda confirmada; entrega com assinatura + foto do item obrigatórias,
-- idempotente. Incremental: não remove dados.
-- =============================================================================

-- Hierarquia física: Portaria (concierge_locations) > Estante > Prateleira.
alter table public.storage_locations
  add column if not exists rack text check (rack is null or length(btrim(rack)) between 1 and 40),
  add column if not exists shelf text check (shelf is null or length(btrim(shelf)) between 1 and 40),
  add column if not exists notes text check (notes is null or length(notes) <= 300);
grant insert (rack, shelf, notes), update (rack, shelf, notes) on public.storage_locations to authenticated;

alter table public.packages
  add column if not exists storage_confirmed_at timestamptz,
  add column if not exists pickup_request_id uuid,
  add column if not exists picked_up_relation text check (picked_up_relation in ('morador', 'autorizado')),
  add column if not exists label_sha256 text check (label_sha256 is null or label_sha256 ~ '^[0-9a-f]{64}$');
create unique index if not exists packages_pickup_request_uq on public.packages (tenant_id, pickup_request_id)
  where pickup_request_id is not null;
-- Mesma foto não registra duas encomendas pendentes.
create unique index if not exists packages_label_sha_pending_uq on public.packages (tenant_id, label_sha256)
  where label_sha256 is not null and status in ('RECEBIDA', 'ARMAZENADA');

-- Deduplicação do outbox inclui o condomínio: (tenant, evento, versão=ref_id, destinatário, canal).
alter table public.notification_jobs drop constraint if exists notification_jobs_event_channel_recipient_ref_id_key;
create unique index if not exists notification_jobs_dedup_uq
  on public.notification_jobs (tenant_id, event, ref_id, recipient, channel);

create or replace function app.package_json(p public.packages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(p) || jsonb_build_object(
    'unit_block', u.block, 'unit_label', u.label, 'storage_code', sl.code,
    'storage_rack', sl.rack, 'storage_shelf', sl.shelf, 'concierge_name', c.name)
  from (select 1) x
  left join public.units u on u.id = p.unit_id
  left join public.storage_locations sl on sl.id = p.storage_location_id
  left join public.concierge_locations c on c.id = p.concierge_location_id
$$;

-- -----------------------------------------------------------------------------
-- Correspondência do destinatário lido pelo OCR com o cadastro do PRÓPRIO
-- condomínio. Nada vai para a IA; nada é criado. Sempre exige confirmação humana.
-- -----------------------------------------------------------------------------
create or replace function app.norm_text(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(regexp_replace(upper(translate(coalesce(p, ''),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇáàâãäéèêëíìîïóòôõöúùûüç',
    'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc')), '[^A-Z0-9 ]', ' ', 'g'), ' +', ' ', 'g')), '')
$$;
-- 12B, 0101, Casa 12 → sem prefixos e sem espaços.
create or replace function app.norm_unit(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(replace(regexp_replace(coalesce(app.norm_text(p), ''),
    '^(APARTAMENTO|APTO|APT|AP|UNIDADE|UN|SALA|CASA|LOJA) ?', ''), ' ', ''), '')
$$;
create or replace function app.norm_block(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(replace(regexp_replace(coalesce(app.norm_text(p), ''),
    '^(BLOCO|BL|TORRE|TR|EDIFICIO|ED) ?', ''), ' ', ''), '')
$$;
-- Fração de tokens coincidentes (inicial abrevia token). Primeiro nome diferente
-- divide a nota por 2; um único token nunca chega a 0,75.
create or replace function app.name_score(p_read text, p_known text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare a text[]; b text[]; hit int := 0; t text; stop text[] := array['DE','DA','DO','DAS','DOS','E'];
  same_first boolean;
begin
  a := array(select x from unnest(string_to_array(app.norm_text(p_read), ' ')) x where not x = any(stop));
  b := array(select x from unnest(string_to_array(app.norm_text(p_known), ' ')) x where not x = any(stop));
  if coalesce(cardinality(a), 0) = 0 or coalesce(cardinality(b), 0) = 0 then return 0; end if;
  foreach t in array a loop
    if exists(select 1 from unnest(b) y where y = t or (length(y) = 1 and left(t, 1) = y) or (length(t) = 1 and left(y, 1) = t)) then
      hit := hit + 1;
    end if;
  end loop;
  same_first := a[1] = b[1] or (length(a[1]) = 1 and left(b[1], 1) = a[1]) or (length(b[1]) = 1 and left(a[1], 1) = b[1]);
  return round(least(1, hit::numeric / greatest(least(cardinality(a), cardinality(b)), 2)) * case when same_first then 1 else 0.5 end, 3);
end $$;

create or replace function public.match_recipient(p_tenant uuid, p_name text, p_block text, p_unit text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare nb text := app.norm_block(p_block); nu text := app.norm_unit(p_unit);
  v_units jsonb; v_people jsonb; n_units int; strong_units uuid[]; v_status text; v_unit uuid; v_alerts text[] := '{}';
begin
  perform app.require(app.is_staff(p_tenant));
  if length(coalesce(p_name, '')) > 200 or length(coalesce(p_block, '')) > 60 or length(coalesce(p_unit, '')) > 60 then
    raise exception 'Leitura muito longa.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', u.id, 'block', u.block, 'label', u.label) order by u.block, u.label), '[]'), count(*)
    into v_units, n_units
    from public.units u
   where u.tenant_id = p_tenant and u.active and nu is not null and app.norm_unit(u.label) = nu
     and (nb is null or app.norm_block(u.block) = nb);
  -- Pessoas ativas da unidade (cadastro e contatos), uma linha por pessoa+unidade.
  with people as (
    select distinct um.unit_id, u.block, u.label, n.name, app.name_score(p_name, n.name) score
      from public.unit_memberships um
      join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
      join public.units u on u.tenant_id = um.tenant_id and u.id = um.unit_id and u.active
      left join public.profiles p on p.id = um.user_id
      cross join lateral (select p.full_name name union
        select c.name from public.resident_contacts c
         where c.tenant_id = um.tenant_id and c.unit_id = um.unit_id and c.user_id = um.user_id and c.active) n
     where um.tenant_id = p_tenant and um.status = 'active' and n.name is not null and app.norm_text(p_name) is not null
  ), best as (
    select distinct on (unit_id, name) * from people where score >= 0.5 order by unit_id, name, score desc limit 20
  )
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', unit_id, 'block', block, 'label', label, 'name', name, 'score', score)
           order by score desc, name), '[]'),
         array(select distinct unit_id from best where score >= 0.75)
    into v_people, strong_units from best;

  if n_units = 1 then
    v_unit := (v_units->0->>'unit_id')::uuid;
    if v_unit = any(strong_units) then v_status := 'matched';
    elsif cardinality(strong_units) > 0 then v_status := 'conflict'; v_alerts := array_append(v_alerts, 'O nome lido pertence a outra unidade.');
    else v_status := 'unit_only'; v_alerts := array_append(v_alerts, 'Nome não confere com moradores ativos desta unidade.');
    end if;
    if cardinality(strong_units) > 1 then v_alerts := array_append(v_alerts, 'Há pessoa com nome semelhante em outra unidade.'); end if;
  elsif n_units > 1 then
    v_status := 'ambiguous'; v_alerts := array_append(v_alerts, 'Mais de uma unidade com esse número: confirme o bloco.');
  elsif cardinality(strong_units) = 1 then
    v_status := 'name_only'; v_unit := strong_units[1]; v_alerts := array_append(v_alerts, 'Unidade não lida: sugerida pelo nome. Confira.');
  elsif cardinality(strong_units) > 1 then
    v_status := 'ambiguous'; v_alerts := array_append(v_alerts, 'Nome igual em mais de uma unidade (homônimos).');
  else
    v_status := 'not_found'; v_alerts := array_append(v_alerts, 'Nenhum morador ativo corresponde à leitura.');
  end if;
  return jsonb_build_object('status', v_status, 'unit_id', v_unit, 'units', v_units, 'people', v_people, 'alerts', to_jsonb(v_alerts));
end $$;

-- Locais com vagas, na mesma ordem da escolha automática (contingência por último).
create or replace function public.storage_availability(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.is_staff(p_tenant) then coalesce(jsonb_agg(jsonb_build_object(
      'id', sl.id, 'code', sl.code, 'rack', sl.rack, 'shelf', sl.shelf, 'notes', sl.notes, 'concierge', c.name,
      'concierge_location_id', sl.concierge_location_id, 'capacity', sl.capacity, 'used', o.used,
      'free', sl.capacity - o.used, 'is_contingency', sl.is_contingency)
      order by sl.is_contingency, (o.used::numeric / sl.capacity), sl.sort_order, sl.code), '[]') end
  from public.storage_locations sl
  join public.concierge_locations c on c.id = sl.concierge_location_id and c.active
  cross join lateral (select count(*)::int used from public.packages p
                       where p.tenant_id = p_tenant and p.storage_location_id = sl.id and app.occupies_space(p.status)) o
  where sl.tenant_id = p_tenant and sl.active
$$;

-- Recebimento do totem: local escolhido e guarda física confirmada pelo operador
-- na mesma transação que grava e enfileira os avisos. Disputa da última vaga
-- serializada por app.pick_storage (FOR UPDATE).
create or replace function public.receive_and_store(
  p_tenant uuid, p_idempotency_key text, p_unit uuid, p_tracking text, p_carrier text,
  p_recipient text, p_notes text, p_storage_location uuid, p_label_sha256 text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_other uuid;
begin
  perform app.require(app.is_staff(p_tenant));
  if p_storage_location is null and exists(select 1 from public.storage_locations where tenant_id = p_tenant and active) then
    raise exception 'Escolha o local e confirme a guarda física antes de registrar.' using errcode = '22023';
  end if;
  if p_label_sha256 is not null and p_label_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Identificador da foto inválido.' using errcode = '22023';
  end if;
  select id into v_other from public.packages where tenant_id = p_tenant and label_sha256 = p_label_sha256
     and app.occupies_space(status) and idempotency_key <> p_idempotency_key;
  if found then raise exception 'Esta mesma foto já registrou uma encomenda que aguarda retirada.' using errcode = 'P0001'; end if;
  r := public.receive_package(p_tenant, p_idempotency_key, p_unit, p_tracking, p_carrier, p_recipient, p_notes, null, p_storage_location);
  if not (r->>'replayed')::boolean then
    update public.packages set storage_confirmed_at = app.now(), label_sha256 = p_label_sha256
     where tenant_id = p_tenant and id = (r->>'id')::uuid;
    insert into public.package_events (tenant_id, package_id, type, actor_id, data)
    values (p_tenant, (r->>'id')::uuid, 'storage_confirmed', auth.uid(), jsonb_build_object('storage_location_id', p_storage_location));
  end if;
  return r || jsonb_build_object('storage_confirmed', true);
exception when unique_violation then
  raise exception 'Esta mesma foto já registrou uma encomenda que aguarda retirada.' using errcode = 'P0001';
end $$;

-- -----------------------------------------------------------------------------
-- Avisos para TODA a unidade: contatos compartilhados recebem uma vez; push e
-- central interna por morador ativo. Retentativa não duplica.
-- -----------------------------------------------------------------------------
create or replace function app.enqueue_package_notifications(p_pkg public.packages, p_event text)
returns int language plpgsql security definer set search_path = '' as $$
declare s public.tenant_settings; n int := 0; c record; v_title text; v_body text; v_ref text := p_pkg.id::text;
begin
  select * into s from public.tenant_settings where tenant_id = p_pkg.tenant_id;
  if p_event = 'package_received' then
    v_title := 'Nova encomenda na portaria';
    v_body := 'Há uma encomenda (' || p_pkg.carrier || ') aguardando retirada. Abra o app para ver o QR Code.';
  else
    v_title := 'Encomenda retirada';
    v_body := 'Uma encomenda da sua unidade foi retirada. O comprovante está disponível no app.';
  end if;
  if coalesce(s.notify_whatsapp, true) and app.has_feature(p_pkg.tenant_id, 'whatsapp') then
    for c in select distinct phone from public.resident_contacts
              where tenant_id = p_pkg.tenant_id and unit_id = p_pkg.unit_id and active and notify_whatsapp and phone is not null loop
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'whatsapp', c.phone, v_ref, jsonb_build_object('package_id', p_pkg.id)) on conflict do nothing;
      if found then n := n + 1; end if;
    end loop;
  end if;
  if coalesce(s.notify_email, true) then
    for c in select distinct email from public.resident_contacts
              where tenant_id = p_pkg.tenant_id and unit_id = p_pkg.unit_id and active and notify_email and email is not null loop
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'email', c.email, v_ref, jsonb_build_object('package_id', p_pkg.id)) on conflict do nothing;
      if found then n := n + 1; end if;
    end loop;
  end if;
  for c in select distinct um.user_id from public.unit_memberships um
             join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
            where um.tenant_id = p_pkg.tenant_id and um.unit_id = p_pkg.unit_id and um.status = 'active' loop
    insert into public.notifications (tenant_id, user_id, kind, title, body, package_id)
    select p_pkg.tenant_id, c.user_id, p_event, v_title, v_body, p_pkg.id
     where not exists(select 1 from public.notifications where tenant_id = p_pkg.tenant_id and user_id = c.user_id
                       and package_id = p_pkg.id and kind = p_event);
    if coalesce(s.notify_push, true) then
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'push', c.user_id::text, v_ref, jsonb_build_object('package_id', p_pkg.id)) on conflict do nothing;
      if found then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- QR para entrega: consulta NÃO consome. Mostra o local ATUAL e a foto da etiqueta.
-- -----------------------------------------------------------------------------
create or replace function public.lookup_pickup_token(p_tenant uuid, p_qr text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.pickup_tokens; v public.packages;
begin
  perform app.require(app.is_staff(p_tenant));
  if coalesce(p_qr, '') !~ '^PP1\.[0-9a-f]{20,128}$' then
    raise exception 'Este não é um QR de retirada da Portaria Prime.' using errcode = 'P0001';
  end if;
  select * into t from public.pickup_tokens where token_hash = app.token_hash_from_qr(p_qr);
  if not found or t.tenant_id <> p_tenant then raise exception 'QR Code não reconhecido neste condomínio.' using errcode = 'P0001'; end if;
  if t.consumed_at is not null then raise exception 'QR Code já utilizado.' using errcode = 'P0001'; end if;
  if t.revoked_at is not null then raise exception 'QR Code substituído por um mais novo. Peça ao morador para atualizar o app.' using errcode = 'P0001'; end if;
  if t.expires_at <= app.now() then raise exception 'QR Code expirado. Peça ao morador para gerar um novo.' using errcode = 'P0001'; end if;
  select * into v from public.packages where tenant_id = p_tenant and id = t.package_id;
  if not app.occupies_space(v.status) then raise exception 'Encomenda indisponível para entrega (%).', v.status using errcode = 'P0001'; end if;
  return app.package_json(v) || jsonb_build_object(
    'label_photo_path', (select object_path from public.package_attachments
                          where tenant_id = p_tenant and package_id = v.id and kind = 'label_photo' order by created_at desc limit 1),
    'moved', exists(select 1 from public.package_events where tenant_id = p_tenant and package_id = v.id and type = 'moved'));
end $$;

-- -----------------------------------------------------------------------------
-- Entrega no totem. Assinatura E foto do item obrigatórias, enviadas pelo próprio
-- operador (owner do objeto) no caminho desta encomenda e ainda não usadas.
-- Idempotente por p_request: retry após timeout devolve o mesmo protocolo.
-- -----------------------------------------------------------------------------
create or replace function app.proof_ok(p_tenant uuid, p_package uuid, p_path text, p_prefix text, p_ext text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_path ~ ('^' || p_tenant::text || '/packages/' || p_package::text || '/' || p_prefix || '-[A-Za-z0-9-]{8,64}\.(' || p_ext || ')$')
     and exists(select 1 from storage.objects o where o.bucket_id = 'tenant-private' and o.name = p_path and o.owner = auth.uid())
     and not exists(select 1 from public.package_attachments a where a.object_path = p_path), false)
$$;

-- Mesma regra de 0600, com relação de quem retira e local no snapshot imutável.
create or replace function public.confirm_pickup(
  p_tenant uuid, p_package uuid, p_method text, p_qr text, p_picked_up_by text,
  p_signature_path text, p_handover_path text default null, p_manual_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.packages; t public.pickup_tokens; v_now timestamptz := app.now(); v_tz text;
  v_protocol text; v_receipt public.receipts; v_unit public.units; v_op text;
begin
  perform app.require(app.is_staff(p_tenant));
  if length(btrim(coalesce(p_picked_up_by, ''))) < 2 then
    raise exception 'Informe o nome de quem está retirando.' using errcode = '22023';
  end if;
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda não encontrada.' using errcode = 'P0002'; end if;
  if v.status = 'RETIRADA' then raise exception 'Esta encomenda já foi retirada.' using errcode = 'P0001'; end if;
  if not app.occupies_space(v.status) then
    raise exception 'Encomenda com status % não pode ser entregue.', v.status using errcode = 'P0001';
  end if;

  if p_method = 'qr' then
    select * into t from public.pickup_tokens where token_hash = app.token_hash_from_qr(p_qr) for update;
    if not found or t.tenant_id <> p_tenant or t.package_id <> p_package then
      raise exception 'QR Code não corresponde a esta encomenda.' using errcode = 'P0001';
    end if;
    if t.consumed_at is not null then raise exception 'QR Code já utilizado.' using errcode = 'P0001'; end if;
    if t.revoked_at is not null then raise exception 'QR Code substituído por um mais novo.' using errcode = 'P0001'; end if;
    if t.expires_at <= v_now then raise exception 'QR Code expirado.' using errcode = 'P0001'; end if;
    update public.pickup_tokens set consumed_at = v_now where id = t.id;
  elsif p_method = 'manual' then
    if length(btrim(coalesce(p_manual_reason, ''))) < 10 then
      raise exception 'Retirada sem QR exige justificativa (mín. 10 caracteres).' using errcode = '22023';
    end if;
  else
    raise exception 'Método de retirada inválido.' using errcode = '22023';
  end if;

  if p_signature_path is null or p_signature_path !~ ('^' || p_tenant::text || '/packages/' || p_package::text || '/signature-[A-Za-z0-9-]{8,64}\.png$')
     or not exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = p_signature_path) then
    raise exception 'Assinatura não recebida pelo servidor. Colete a assinatura e tente novamente.' using errcode = '22023';
  end if;
  insert into public.package_attachments (tenant_id, package_id, kind, object_path, created_by)
  values (p_tenant, p_package, 'signature', p_signature_path, auth.uid());
  if p_handover_path is not null then
    if p_handover_path !~ ('^' || p_tenant::text || '/packages/' || p_package::text || '/handover-[A-Za-z0-9-]{8,64}\.(jpg|png|webp)$')
       or not exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = p_handover_path) then
      raise exception 'Foto da entrega inválida.' using errcode = '22023';
    end if;
    insert into public.package_attachments (tenant_id, package_id, kind, object_path, created_by)
    values (p_tenant, p_package, 'handover_photo', p_handover_path, auth.uid());
  end if;

  update public.pickup_tokens set revoked_at = v_now
   where package_id = p_package and consumed_at is null and revoked_at is null;
  update public.packages set status = 'RETIRADA', picked_up_at = v_now, picked_up_by_name = btrim(p_picked_up_by),
    delivered_by = auth.uid(), pickup_method = p_method,
    manual_reason = case when p_method = 'manual' then btrim(p_manual_reason) end, updated_at = now()
  where id = p_package returning * into v;

  select timezone into v_tz from public.tenants where id = p_tenant;
  select * into v_unit from public.units where id = v.unit_id;
  select coalesce(full_name, 'Portaria') into v_op from public.profiles where id = auth.uid();
  v_protocol := 'PP-' || to_char(v_now at time zone v_tz, 'YYYYMMDD') || '-' || upper(substr(app.random_token(), 1, 8));
  insert into public.receipts (tenant_id, package_id, protocol, issued_at, snapshot)
  values (p_tenant, p_package, v_protocol, v_now, jsonb_build_object(
    'tracking_code', v.tracking_code, 'carrier', v.carrier, 'unit_block', v_unit.block, 'unit_label', v_unit.label,
    'received_at', v.received_at, 'picked_up_at', v.picked_up_at, 'picked_up_by', v.picked_up_by_name,
    'operator', coalesce(v_op, 'Portaria'), 'method', p_method, 'manual_reason', v.manual_reason,
    'signature_path', p_signature_path, 'handover_path', p_handover_path,
    'recipient_kind', v.picked_up_relation,
    'storage', (select concat_ws(' › ', c.name, coalesce(sl.rack, sl.code), sl.shelf) from public.storage_locations sl
                 join public.concierge_locations c on c.id = sl.concierge_location_id where sl.id = v.storage_location_id)))
  returning * into v_receipt;

  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, p_package, 'picked_up', auth.uid(), jsonb_build_object('method', p_method, 'protocol', v_protocol));
  if p_method = 'manual' then
    perform app.audit(p_tenant, 'package.manual_pickup', 'package', p_package::text, jsonb_build_object('reason', v.manual_reason));
  end if;
  perform app.enqueue_package_notifications(v, 'package_picked_up');
  return app.package_json(v) || jsonb_build_object('protocol', v_protocol, 'receipt_id', v_receipt.id);
end $$;

create or replace function public.deliver_package(
  p_tenant uuid, p_package uuid, p_request uuid, p_qr text, p_picked_up_by text, p_recipient_kind text,
  p_signature_path text, p_item_photo_path text, p_manual_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; r jsonb;
begin
  perform app.require(app.is_staff(p_tenant));
  if p_request is null then raise exception 'Identificador da operação obrigatório.' using errcode = '22023'; end if;
  if coalesce(p_recipient_kind, '') not in ('morador', 'autorizado') then
    raise exception 'Informe se quem retira é o morador ou um recebedor autorizado.' using errcode = '22023';
  end if;
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda não encontrada.' using errcode = 'P0002'; end if;
  if v.pickup_request_id = p_request then
    return app.package_json(v) || jsonb_build_object('replayed', true,
      'protocol', (select protocol from public.receipts where tenant_id = p_tenant and package_id = v.id));
  end if;
  if v.status = 'RETIRADA' then raise exception 'Esta encomenda já foi retirada.' using errcode = 'P0001'; end if;
  if not app.proof_ok(p_tenant, p_package, p_signature_path, 'signature', 'png') then
    raise exception 'Assinatura não recebida pelo servidor. Colete a assinatura e tente novamente.' using errcode = '22023';
  end if;
  if not app.proof_ok(p_tenant, p_package, p_item_photo_path, 'handover', 'jpg|png|webp') then
    raise exception 'Foto do item entregue é obrigatória. Fotografe e tente novamente.' using errcode = '22023';
  end if;
  update public.packages set picked_up_relation = p_recipient_kind where id = p_package;
  r := public.confirm_pickup(p_tenant, p_package, case when p_qr is null then 'manual' else 'qr' end, p_qr,
    p_picked_up_by, p_signature_path, p_item_photo_path, p_manual_reason);
  update public.packages set pickup_request_id = p_request where id = p_package;
  return r || jsonb_build_object('replayed', false, 'pickup_request_id', p_request);
end $$;

-- Retirada direta pelo cliente deixa de existir: só via deliver_package (provas obrigatórias).
revoke execute on function public.confirm_pickup(uuid, uuid, text, text, text, text, text, text) from authenticated;

revoke all on function app.norm_text(text), app.norm_unit(text), app.norm_block(text), app.name_score(text, text),
  app.proof_ok(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.match_recipient(uuid, text, text, text), public.storage_availability(uuid),
  public.receive_and_store(uuid, text, uuid, text, text, text, text, uuid, text),
  public.deliver_package(uuid, uuid, uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.match_recipient(uuid, text, text, text), public.storage_availability(uuid),
  public.receive_and_store(uuid, text, uuid, text, text, text, text, uuid, text),
  public.deliver_package(uuid, uuid, uuid, text, text, text, text, text, text), public.lookup_pickup_token(uuid, text)
  to authenticated, service_role;

-- Contexto da mensagem inclui o id da encomenda (link estável do comprovante).
create or replace function public.notification_context(p_job uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tenant_id', t.id, 'tenant_name', coalesce(b.display_name, t.name), 'tenant_slug', t.slug, 'timezone', t.timezone,
    'color_primary', b.color_primary,
    'whatsapp', (select jsonb_build_object('enabled', i.enabled, 'instance', i.config ->> 'instance')
                   from public.tenant_integrations i where i.tenant_id = t.id and i.provider = 'whatsapp_evolution'),
    'package', (select jsonb_build_object('id', p.id, 'carrier', p.carrier, 'tracking_code', p.tracking_code, 'received_at', p.received_at,
                  'picked_up_at', p.picked_up_at, 'picked_up_by', p.picked_up_by_name, 'storage_code', sl.code,
                  'unit', concat_ws(' ', u.block, u.label), 'protocol', r.protocol)
                from public.packages p
                left join public.units u on u.id = p.unit_id
                left join public.storage_locations sl on sl.id = p.storage_location_id
                left join public.receipts r on r.package_id = p.id
               where p.tenant_id = j.tenant_id and p.id = (j.payload ->> 'package_id')::uuid))
  from public.notification_jobs j
  join public.tenants t on t.id = j.tenant_id
  left join public.tenant_branding b on b.tenant_id = t.id
  where j.id = p_job
$$;
