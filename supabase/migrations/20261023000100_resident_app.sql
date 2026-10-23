-- =============================================================================
-- PORTARIA PRIME — app do morador: leitura mínima e autorizada no servidor.
-- Só unidades com vínculo ativo do próprio usuário; pré-registro nunca aparece;
-- local interno de guarda não é exposto; comprovante segue a regra de emissão
-- (morador ligado à unidade antes da entrega). Contatos de outros moradores
-- deixam de ser legíveis/alteráveis pelo morador (só a equipe).
-- =============================================================================

-- Mesma regra de public.receipt_pdf_access.
create function app.can_see_receipt(p_tenant uuid, p_unit uuid, p_issued timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_staff(p_tenant) or (app.is_unit_member(p_tenant, p_unit) and exists (
    select 1 from public.unit_memberships um where um.tenant_id = p_tenant and um.unit_id = p_unit
      and um.user_id = auth.uid() and um.status = 'active' and um.created_at <= p_issued))
$$;

-- Identificador amigável e estável (não é credencial): 6 primeiros hex do id.
create function app.package_ref(p_id uuid) returns text
language sql immutable set search_path = '' as $$ select upper(left(replace(p_id::text, '-', ''), 6)) $$;

create function app.resident_package_json(p public.packages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'ref', app.package_ref(p.id), 'status', p.status, 'carrier', p.carrier, 'tracking_code', p.tracking_code,
    'recipient_name', p.recipient_name, 'unit_id', p.unit_id, 'unit_block', u.block, 'unit_label', u.label,
    'received_at', p.received_at, 'stored_at', p.stored_at, 'picked_up_at', p.picked_up_at,
    'picked_up_by_name', p.picked_up_by_name, 'resolved_at', p.resolved_at, 'concierge_name', c.name,
    'receipt', (select jsonb_build_object('protocol', r.protocol, 'pdf_status', r.pdf_status)
                  from public.receipts r where r.tenant_id = p.tenant_id and r.package_id = p.id
                   and app.can_see_receipt(p.tenant_id, p.unit_id, r.issued_at)))
  from (select 1) x
  left join public.units u on u.id = p.unit_id
  left join public.concierge_locations c on c.id = p.concierge_location_id
$$;

create function app.resident_units(p_tenant uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(um.unit_id), '{}') from public.unit_memberships um
  where um.tenant_id = p_tenant and um.user_id = auth.uid() and um.status = 'active' and app.has_role(p_tenant, array['morador'])
$$;

-- Início: aguardando (mais antigas primeiro), recentes, canais e contagens coerentes.
create function public.resident_home(p_tenant uuid, p_unit uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_units uuid[]; v_sel uuid[]; s public.tenant_settings; c public.resident_contacts; v_wa boolean;
begin
  perform app.require(app.has_role(p_tenant, array['morador']));
  v_units := app.resident_units(p_tenant);
  v_sel := case when p_unit is null then v_units when p_unit = any (v_units) then array[p_unit] else '{}' end;
  select * into s from public.tenant_settings where tenant_id = p_tenant;
  select * into c from public.resident_contacts where tenant_id = p_tenant and user_id = auth.uid() and active
    and unit_id = any (v_units) order by created_at limit 1;
  v_wa := app.has_feature(p_tenant, 'whatsapp') and coalesce(s.notify_whatsapp, true);
  return jsonb_build_object(
    'name', (select nullif(btrim(full_name), '') from public.profiles where id = auth.uid()),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'block', u.block, 'label', u.label) order by u.block nulls first, u.label), '[]')
                from public.units u where u.id = any (v_units)),
    'waiting', (select coalesce(jsonb_agg(app.resident_package_json(p) order by p.received_at, p.id), '[]') from (
                  select * from public.packages where tenant_id = p_tenant and unit_id = any (v_sel) and app.occupies_space(status)
                  order by received_at, id limit 100) p),
    'recent', (select coalesce(jsonb_agg(app.resident_package_json(p) order by p.received_at desc, p.id desc), '[]') from (
                  select * from public.packages where tenant_id = p_tenant and unit_id = any (v_sel)
                    and status not in ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA')
                  order by received_at desc, id desc limit 3) p),
    'unread', (select count(*) from public.notifications where tenant_id = p_tenant and user_id = auth.uid() and read_at is null),
    -- Canais pelos quais ESTE usuário seria avisado (sem afirmar entrega).
    'channels', jsonb_build_object(
      'push_devices', case when coalesce(s.notify_push, true) then (select count(*) from public.push_subscriptions
                         where tenant_id = p_tenant and user_id = auth.uid()) else 0 end,
      'whatsapp', coalesce(v_wa and c.phone is not null and c.notify_whatsapp, false),
      'email', coalesce(coalesce(s.notify_email, true) and c.email is not null and c.notify_email, false),
      'push_enabled', coalesce(s.notify_push, true)));
end $$;

-- Histórico (fora de espera), keyset por (received_at, id) desc; busca por transportadora, rastreio e identificador.
create function public.resident_history(p_tenant uuid, p_unit uuid default null, p_search text default null, p_status text default null,
  p_from date default null, p_to date default null, p_cursor_at timestamptz default null, p_cursor_id uuid default null, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_units uuid[]; v_tz text; v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform app.require(app.has_role(p_tenant, array['morador']));
  if p_from is not null and p_to is not null and p_to < p_from then raise exception 'Período inválido.' using errcode = '22023'; end if;
  v_units := app.resident_units(p_tenant);
  if p_unit is not null then v_units := case when p_unit = any (v_units) then array[p_unit] else '{}' end; end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  return (select coalesce(jsonb_agg(app.resident_package_json(p) order by p.received_at desc, p.id desc), '[]') from (
    select * from public.packages where tenant_id = p_tenant and unit_id = any (v_units)
      and status not in ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA')
      and (p_status is null or status = p_status)
      and (p_from is null or received_at >= (p_from::timestamp at time zone v_tz))
      and (p_to is null or received_at < ((p_to + 1)::timestamp at time zone v_tz))
      and (v_q is null or carrier ilike '%' || v_q || '%' or tracking_code ilike '%' || v_q || '%'
           or app.package_ref(id) like upper(ltrim(v_q, '#')) || '%')
      and (p_cursor_at is null or (received_at, id) < (p_cursor_at, p_cursor_id))
    order by received_at desc, id desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) p);
end $$;

-- Detalhe com linha do tempo de fatos registrados (sem "aviso lido/entregue").
create function public.resident_package(p_tenant uuid, p_package uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.packages;
begin
  select * into p from public.packages where tenant_id = p_tenant and id = p_package;
  if not found or p.status = 'PRE_REGISTRADA' or not coalesce(p.unit_id = any (app.resident_units(p_tenant)), false) then
    raise exception 'Encomenda não encontrada ou sem acesso.' using errcode = 'P0002';
  end if;
  return app.resident_package_json(p) || jsonb_build_object('timeline', (
    select coalesce(jsonb_agg(jsonb_build_object('kind', k, 'at', at) order by at, o), '[]') from (values
      ('received', p.received_at, 1),
      ('stored', case when p.stored_at is distinct from p.received_at then p.stored_at end, 2),
      ('picked_up', p.picked_up_at, 3),
      (lower(p.status), case when p.status in ('DEVOLVIDA', 'CANCELADA', 'EXTRAVIADA') then p.resolved_at end, 4)) e(k, at, o)
    where at is not null));
end $$;

-- Minha conta: próprio perfil, unidades, contatos (dos outros: só primeiro nome e canais), contato da portaria.
create function public.resident_profile(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_units uuid[];
begin
  perform app.require(app.has_role(p_tenant, array['morador']));
  v_units := app.resident_units(p_tenant);
  return jsonb_build_object(
    'full_name', (select full_name from public.profiles where id = auth.uid()),
    'email', (select lower(email) from auth.users where id = auth.uid()),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'block', u.block, 'label', u.label, 'since', um.created_at)
                order by u.block nulls first, u.label), '[]')
                from public.unit_memberships um join public.units u on u.id = um.unit_id
               where um.tenant_id = p_tenant and um.user_id = auth.uid() and um.status = 'active'),
    'contacts', (select coalesce(jsonb_agg(case when c.user_id = auth.uid() or c.user_id is null then
                    jsonb_build_object('id', c.id, 'unit_id', c.unit_id, 'mine', c.user_id = auth.uid(), 'editable', true, 'name', c.name,
                      'phone', c.phone, 'email', c.email, 'notify_whatsapp', c.notify_whatsapp, 'notify_email', c.notify_email)
                  else jsonb_build_object('id', c.id, 'unit_id', c.unit_id, 'mine', false, 'editable', false,
                      'name', split_part(btrim(c.name), ' ', 1), 'has_whatsapp', c.phone is not null and c.notify_whatsapp,
                      'has_email', c.email is not null and c.notify_email) end
                  order by (c.user_id = auth.uid()) desc nulls last, c.created_at), '[]')
                from public.resident_contacts c where c.tenant_id = p_tenant and c.unit_id = any (v_units) and c.active),
    'whatsapp_available', app.has_feature(p_tenant, 'whatsapp') and coalesce((select notify_whatsapp from public.tenant_settings where tenant_id = p_tenant), true),
    'email_available', coalesce((select notify_email from public.tenant_settings where tenant_id = p_tenant), true),
    'portaria_contact', (select nullif(btrim(contact), '') from public.receipt_layouts where tenant_id = p_tenant));
end $$;

-- Contatos: morador lê/edita só o próprio e os familiares sem conta da unidade.
drop policy contacts_select on public.resident_contacts;
drop policy contacts_update on public.resident_contacts;
drop policy contacts_delete on public.resident_contacts;
create policy contacts_select on public.resident_contacts for select to authenticated
  using (app.is_staff(tenant_id) or (app.is_unit_member(tenant_id, unit_id) and (user_id is null or user_id = auth.uid())));
create policy contacts_update on public.resident_contacts for update to authenticated
  using (app.is_admin(tenant_id) or (app.is_unit_member(tenant_id, unit_id) and (user_id is null or user_id = auth.uid())))
  with check (app.is_admin(tenant_id) or (app.is_unit_member(tenant_id, unit_id) and (user_id is null or user_id = auth.uid())));
create policy contacts_delete on public.resident_contacts for delete to authenticated
  using (app.is_admin(tenant_id) or (app.is_unit_member(tenant_id, unit_id) and (user_id is null or user_id = auth.uid())));

-- Pedido de acesso: distingue "aprovado e depois encerrado" de "aprovado".
create or replace function public.my_access_request(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', case when r.status = 'approved' and not exists (
      select 1 from public.tenant_memberships m where m.tenant_id = r.tenant_id and m.user_id = auth.uid() and m.role = 'morador' and m.status = 'active')
      then 'revoked' else r.status end,
    'unit_text', concat_ws(' ', r.block_text, r.unit_text), 'reason', r.reason, 'created_at', r.created_at)
  from public.access_requests r join public.tenants t on t.id = r.tenant_id
  where t.slug = lower(btrim(p_slug)) and r.user_id = auth.uid() order by r.created_at desc limit 1
$$;

-- Central: estado ATUAL da encomenda de cada aviso, revalidado (sem acesso = null).
create or replace function public.my_notifications(p_tenant uuid, p_unread boolean default false, p_before timestamptz default null, p_limit int default 20)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when app.is_member(p_tenant) then jsonb_build_object(
    'unread', (select count(*) from public.notifications where tenant_id = p_tenant and user_id = auth.uid() and read_at is null),
    'items', coalesce((select jsonb_agg(to_jsonb(n) - 'user_id' - 'tenant_id' || jsonb_build_object('package_status', (
        select pk.status from public.packages pk where pk.tenant_id = p_tenant and pk.id = n.package_id
           and (app.is_staff(p_tenant) or pk.unit_id = any (app.resident_units(p_tenant))))) order by n.created_at desc) from (
        select * from public.notifications where tenant_id = p_tenant and user_id = auth.uid()
          and (not p_unread or read_at is null) and (p_before is null or created_at < p_before)
        order by created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) n), '[]'::jsonb)) end
$$;

revoke all on function app.can_see_receipt(uuid, uuid, timestamptz), app.package_ref(uuid), app.resident_package_json(public.packages),
  app.resident_units(uuid) from public, anon, authenticated;
revoke all on function public.resident_home(uuid, uuid), public.resident_history(uuid, uuid, text, text, date, date, timestamptz, uuid, int),
  public.resident_package(uuid, uuid), public.resident_profile(uuid) from public, anon;
grant execute on function public.resident_home(uuid, uuid), public.resident_history(uuid, uuid, text, text, date, date, timestamptz, uuid, int),
  public.resident_package(uuid, uuid), public.resident_profile(uuid) to authenticated, service_role;
