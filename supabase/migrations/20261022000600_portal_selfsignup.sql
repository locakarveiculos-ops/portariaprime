-- =============================================================================
-- Portal público por condomínio e cadastro de morador sem convite.
-- Cadastro cria SOLICITAÇÃO; o vínculo só existe após aprovação da administração.
-- =============================================================================

-- Slugs que colidiriam com rotas do app (o portal é /c/{slug}).
create function app.reserved_slug(p text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(p) in ('admin','api','app','c','entrar','cadastro','convite','onboarding','checkout','totem','assets','brand',
    'screens','sw','manifest','termos','privacidade','recuperar-senha','nova-senha','portaria','morador','suporte','ajuda',
    'portariaprime','www','login','logout','static','public')
$$;
alter table public.tenants add constraint tenants_slug_not_reserved check (not app.reserved_slug(slug)) not valid;

-- Dados públicos do portal: só marca. Nada de moradores, unidades, ocupação ou contatos.
create function public.portal_info(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('slug', t.slug, 'name', coalesce(b.display_name, t.name), 'logo_path', b.logo_path,
    'color_primary', b.color_primary, 'color_secondary', b.color_secondary, 'color_accent', b.color_accent,
    'status', case when t.status = 'active' then 'active' else 'unavailable' end,
    'logo_version', extract(epoch from b.updated_at)::bigint)
  from public.tenants t left join public.tenant_branding b on b.tenant_id = t.id
  where t.slug = lower(btrim(p_slug)) and t.status <> 'closed'
$$;
grant execute on function public.portal_info(text) to anon, authenticated, service_role;

-- Solicitações de vínculo.
create table public.access_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  phone text check (phone is null or phone ~ '^\+?\d{10,15}$'),
  block_text text check (block_text is null or length(block_text) <= 30),
  unit_text text not null check (length(btrim(unit_text)) between 1 and 30),
  unit_id uuid,                                   -- encontrado pelo servidor; revisável pelo síndico
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  reason text check (reason is null or length(reason) <= 300),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id)
);
-- Uma solicitação pendente por pessoa e condomínio (retry/duplo clique não duplica).
create unique index access_requests_pending_uq on public.access_requests (tenant_id, user_id) where status = 'pending';
create index access_requests_tenant_idx on public.access_requests (tenant_id, status, created_at desc);
alter table public.access_requests enable row level security;
grant select on public.access_requests to authenticated;
create policy access_requests_select on public.access_requests for select to authenticated
  using (user_id = auth.uid() or app.has_perm(tenant_id, 'approve'));

-- Novo evento do outbox: resultado da solicitação ao solicitante e aviso ao aprovador; boas-vindas do portal.
alter table public.notification_jobs drop constraint if exists notification_jobs_event_check;
alter table public.notification_jobs add constraint notification_jobs_event_check check (event in
  ('package_received', 'package_picked_up', 'invitation', 'trial_reminder', 'billing_order', 'billing_paid', 'ops_alert',
   'access_request', 'access_decision', 'portal_welcome'));

create or replace function app.notification_allowed(j public.notification_jobs) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare u uuid;
begin
  if not exists(select 1 from public.tenants where id = j.tenant_id and status = 'active') then return false; end if;
  if j.event in ('package_received','package_picked_up') then
    select unit_id into u from public.packages where tenant_id = j.tenant_id and id::text = j.ref_id;
    if u is null then return false; end if;
    if j.channel = 'push' then
      return exists(select 1 from public.unit_memberships um join public.tenant_memberships m
        on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
        where um.tenant_id = j.tenant_id and um.unit_id = u and um.user_id::text = j.recipient and um.status = 'active');
    end if;
    return exists(select 1 from public.resident_contacts c where c.tenant_id = j.tenant_id and c.unit_id = u and c.active
      and ((j.channel = 'email' and c.notify_email and c.email = j.recipient)
        or (j.channel = 'whatsapp' and c.notify_whatsapp and c.phone = j.recipient))
      and (c.user_id is null or exists(select 1 from public.unit_memberships um join public.tenant_memberships m
        on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
        where um.tenant_id = c.tenant_id and um.unit_id = c.unit_id and um.user_id = c.user_id and um.status = 'active')));
  end if;
  if j.event in ('ops_alert', 'access_request') then
    return j.channel in ('push', 'email') and exists(select 1 from public.tenant_memberships m
      where m.tenant_id = j.tenant_id and m.role = 'admin' and m.status = 'active'
        and (m.user_id::text = j.recipient or (j.channel = 'email' and lower((select email from auth.users where id = m.user_id)) = j.recipient))
        and (j.event = 'ops_alert' or 'approve' = any (m.permissions)));
  end if;
  if j.event = 'access_decision' then
    -- Só ao próprio solicitante (e-mail da conta), sobre a própria solicitação.
    return j.channel = 'email' and exists(select 1 from public.access_requests r join auth.users u on u.id = r.user_id
      where r.id::text = j.ref_id and r.tenant_id = j.tenant_id and lower(u.email) = j.recipient);
  end if;
  if j.event = 'portal_welcome' then
    return j.channel in ('email', 'whatsapp') and exists(select 1 from public.tenant_memberships m join auth.users u on u.id = m.user_id
      where m.tenant_id = j.tenant_id and m.role = 'admin' and m.status = 'active'
        and ((j.channel = 'email' and lower(u.email) = j.recipient)
          or (j.channel = 'whatsapp' and j.recipient = (select contact_phone from public.tenants where id = j.tenant_id))));
  end if;
  if j.event in ('trial_reminder','billing_order','billing_paid') then
    return j.channel = 'email' and j.recipient in (select app.billing_admin_emails(j.tenant_id));
  end if;
  return false;
end $$;

-- Cadastro sem convite: qualquer conta verificada pode PEDIR vínculo. Nada é liberado aqui.
-- Mesma resposta para unidade existente ou não (sem enumeração).
create function public.request_access(p_slug text, p_full_name text, p_phone text, p_block text, p_unit text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_t public.tenants; v_unit uuid; v_req uuid; v_phone text := nullif(app.digits(p_phone), '');
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  perform app.require(app.email_verified(), 'Confirme seu e-mail antes de solicitar o cadastro.');
  select * into v_t from public.tenants where slug = lower(btrim(p_slug)) and status = 'active';
  if not found then raise exception 'Condomínio não encontrado ou indisponível.' using errcode = 'P0002'; end if;
  if exists (select 1 from public.tenant_memberships where tenant_id = v_t.id and user_id = auth.uid() and role = 'morador' and status = 'active') then
    raise exception 'Você já tem acesso de morador neste condomínio.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_unit, ''))) = 0 then raise exception 'Informe sua unidade.' using errcode = '22023'; end if;
  if v_phone is not null and v_phone !~ '^\d{10,13}$' then raise exception 'Telefone inválido (DDD + número).' using errcode = '22023'; end if;
  -- Limite de abuso: 5 solicitações por pessoa por dia em todos os condomínios.
  if (select count(*) from public.access_requests where user_id = auth.uid() and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Muitas solicitações. Tente novamente amanhã.' using errcode = 'P0001';
  end if;
  select id into v_unit from public.units
   where tenant_id = v_t.id and active and app.norm_unit(label) = app.norm_unit(p_unit)
     and coalesce(app.norm_block(block), '') = coalesce(app.norm_block(p_block), '') limit 1;
  select id into v_req from public.access_requests where tenant_id = v_t.id and user_id = auth.uid() and status = 'pending';
  if found then
    update public.access_requests set full_name = btrim(p_full_name), phone = coalesce(v_phone, phone), block_text = nullif(btrim(p_block), ''),
      unit_text = btrim(p_unit), unit_id = v_unit where id = v_req;
  else
    insert into public.access_requests (tenant_id, user_id, full_name, phone, block_text, unit_text, unit_id)
    values (v_t.id, auth.uid(), btrim(p_full_name), v_phone, nullif(btrim(p_block), ''), btrim(p_unit), v_unit)
    returning id into v_req;
    -- Aviso a quem aprova (central + push), sem dados do solicitante na notificação.
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    select v_t.id, m.user_id, 'access_request', 'Nova solicitação de cadastro', 'Um morador pediu acesso. Revise em Unidades e pessoas.'
      from public.tenant_memberships m where m.tenant_id = v_t.id and m.role = 'admin' and m.status = 'active' and 'approve' = any (m.permissions);
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id)
    select v_t.id, 'access_request', 'push', m.user_id::text, v_req::text
      from public.tenant_memberships m where m.tenant_id = v_t.id and m.role = 'admin' and m.status = 'active' and 'approve' = any (m.permissions)
    on conflict do nothing;
  end if;
  perform app.audit(v_t.id, 'access_request.created', 'access_request', v_req::text, '{}'::jsonb);
  return jsonb_build_object('request_id', v_req, 'status', 'pending', 'slug', v_t.slug);
end $$;

-- Estado do próprio pedido (para a tela de pendência).
create function public.my_access_request(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', r.status, 'unit_text', concat_ws(' ', r.block_text, r.unit_text), 'reason', r.reason, 'created_at', r.created_at)
  from public.access_requests r join public.tenants t on t.id = r.tenant_id
  where t.slug = lower(btrim(p_slug)) and r.user_id = auth.uid() order by r.created_at desc limit 1
$$;

-- Aprovar: cria vínculo e contato na mesma transação (idempotente). Recusar: só a solicitação.
create function public.decide_access_request(p_request uuid, p_approve boolean, p_unit uuid default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.access_requests; v_unit uuid; v_max int; v_count int; v_email text;
begin
  select * into r from public.access_requests where id = p_request for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  perform app.require(app.has_perm(r.tenant_id, 'approve'), 'Somente quem aprova cadastros pode decidir.');
  if r.status <> 'pending' then
    return jsonb_build_object('status', r.status, 'replayed', true);
  end if;
  if p_approve then
    v_unit := coalesce(p_unit, r.unit_id);
    if v_unit is null or not exists (select 1 from public.units where tenant_id = r.tenant_id and id = v_unit and active) then
      raise exception 'Escolha uma unidade cadastrada para aprovar.' using errcode = '22023';
    end if;
    perform 1 from public.units where id = v_unit for update;
    select max_residents_per_unit into v_max from public.tenant_settings where tenant_id = r.tenant_id;
    select count(*) into v_count from public.unit_memberships where unit_id = v_unit and status = 'active' and user_id <> r.user_id;
    if v_count >= coalesce(v_max, 10) then raise exception 'A unidade já atingiu o limite de % moradores.', v_max using errcode = 'P0001'; end if;
    insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
    values (r.tenant_id, r.user_id, 'morador', '{}', 'active')
    on conflict (tenant_id, user_id, role) do update set status = 'active', updated_at = now();
    insert into public.unit_memberships (tenant_id, unit_id, user_id) values (r.tenant_id, v_unit, r.user_id)
    on conflict (unit_id, user_id) do update set status = 'active';
    select lower(email) into v_email from auth.users where id = r.user_id;
    if not exists (select 1 from public.resident_contacts where unit_id = v_unit and user_id = r.user_id) then
      insert into public.resident_contacts (tenant_id, unit_id, user_id, name, email, phone)
      values (r.tenant_id, v_unit, r.user_id, r.full_name, v_email, case when r.phone is null then null when r.phone like '55%' then '+' || r.phone else '+55' || r.phone end);
    else
      update public.resident_contacts set active = true where unit_id = v_unit and user_id = r.user_id;
    end if;
    update public.access_requests set status = 'approved', unit_id = v_unit, decided_by = auth.uid(), decided_at = now(),
      reason = nullif(btrim(p_reason), '') where id = r.id;
  else
    if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Informe o motivo da recusa.' using errcode = '22023'; end if;
    update public.access_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), reason = btrim(p_reason) where id = r.id;
  end if;
  select lower(email) into v_email from auth.users where id = r.user_id;
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  values (r.tenant_id, 'access_decision', 'email', v_email, r.id::text, jsonb_build_object('approved', p_approve))
  on conflict do nothing;
  perform app.audit(r.tenant_id, case when p_approve then 'access_request.approved' else 'access_request.rejected' end,
    'access_request', r.id::text, jsonb_build_object('unit_id', v_unit));
  return jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end, 'replayed', false);
end $$;

create function public.list_access_requests(p_tenant uuid, p_status text default 'pending') returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'approve') then coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'full_name', r.full_name, 'email', u.email, 'phone', r.phone, 'block_text', r.block_text, 'unit_text', r.unit_text,
    'unit_id', r.unit_id, 'status', r.status, 'reason', r.reason, 'created_at', r.created_at, 'decided_at', r.decided_at) order by r.created_at desc), '[]') end
  from public.access_requests r join auth.users u on u.id = r.user_id
  where r.tenant_id = p_tenant and (p_status is null or r.status = p_status)
$$;

-- Boas-vindas do portal ao responsável (só condomínios novos; nenhum envio retroativo).
create or replace function app.portal_welcome_after_provision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  select lower(email) into v_email from auth.users where id = new.user_id;
  if new.role = 'admin' and v_email is not null and not exists
      (select 1 from public.tenant_memberships where tenant_id = new.tenant_id and id <> new.id) then
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id)
    values (new.tenant_id, 'portal_welcome', 'email', v_email, new.tenant_id::text) on conflict do nothing;
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id)
    select new.tenant_id, 'portal_welcome', 'whatsapp', t.contact_phone, new.tenant_id::text
      from public.tenants t where t.id = new.tenant_id and t.contact_phone is not null on conflict do nothing;
    perform app.audit(new.tenant_id, 'portal.created', 'tenant', new.tenant_id::text, '{}'::jsonb);
  end if;
  return new;
end $$;
create trigger tenant_portal_welcome after insert on public.tenant_memberships
  for each row execute function app.portal_welcome_after_provision();

-- Reenvio manual das boas-vindas (link do portal) ao responsável.
create function public.resend_portal_welcome(p_tenant uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings'));
  if exists (select 1 from public.audit_logs where tenant_id = p_tenant and action = 'portal.welcome_resent' and created_at > now() - interval '5 minutes') then
    raise exception 'Aguarde 5 minutos para reenviar.' using errcode = 'P0001';
  end if;
  update public.notification_jobs set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, locked_until = null, updated_at = now()
   where tenant_id = p_tenant and event = 'portal_welcome';
  if not found then
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id)
    values (p_tenant, 'portal_welcome', 'email', app.current_email(), p_tenant::text) on conflict do nothing;
  end if;
  perform app.audit(p_tenant, 'portal.welcome_resent', 'tenant', p_tenant::text, '{}'::jsonb);
end $$;

-- Contexto para o template do portal (data do fim do teste e nome do responsável).
create or replace function public.notification_context(p_job uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tenant_id', t.id, 'tenant_name', coalesce(b.display_name, t.name), 'tenant_slug', t.slug, 'timezone', t.timezone,
    'color_primary', b.color_primary, 'logo_path', b.logo_path,
    'trial_ends_at', (select trial_ends_at from public.subscriptions where tenant_id = t.id),
    'admin_name', (select coalesce(p.full_name, split_part(u.email, '@', 1)) from auth.users u left join public.profiles p on p.id = u.id where u.id = t.created_by),
    'whatsapp', (select jsonb_build_object('enabled', i.enabled, 'instance', i.config ->> 'instance')
                   from public.tenant_integrations i where i.tenant_id = t.id and i.provider = 'whatsapp_evolution'),
    'package', (select jsonb_build_object('id', p.id, 'carrier', p.carrier, 'tracking_code', p.tracking_code, 'received_at', p.received_at,
                  'picked_up_at', p.picked_up_at, 'picked_up_by', p.picked_up_by_name, 'storage_code', sl.code,
                  'unit', concat_ws(' ', u.block, u.label), 'protocol', r.protocol,
                  'pdf_path', case when r.pdf_status = 'ready' then r.pdf_path end)
                from public.packages p
                left join public.units u on u.id = p.unit_id
                left join public.storage_locations sl on sl.id = p.storage_location_id
                left join public.receipts r on r.package_id = p.id
               where p.tenant_id = j.tenant_id and j.payload ? 'package_id' and p.id = (j.payload ->> 'package_id')::uuid))
  from public.notification_jobs j
  join public.tenants t on t.id = j.tenant_id
  left join public.tenant_branding b on b.tenant_id = t.id
  where j.id = p_job
$$;

revoke all on function public.request_access(text, text, text, text, text), public.my_access_request(text),
  public.decide_access_request(uuid, boolean, uuid, text), public.list_access_requests(uuid, text),
  public.resend_portal_welcome(uuid), app.portal_welcome_after_provision(), app.reserved_slug(text) from public, anon;
grant execute on function public.request_access(text, text, text, text, text), public.my_access_request(text),
  public.decide_access_request(uuid, boolean, uuid, text), public.list_access_requests(uuid, text),
  public.resend_portal_welcome(uuid) to authenticated, service_role;
grant execute on function app.reserved_slug(text) to authenticated, service_role;

-- Ícones do PWA por condomínio (versionados; versão antiga permanece para apps já instalados).
alter table public.tenant_branding add column app_icons_version bigint;
create function public.set_app_icons_version(p_tenant uuid, p_version bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings'));
  if not exists (select 1 from storage.objects where bucket_id = 'tenant-public'
                  and name = p_tenant::text || '/app-v' || p_version || '/icon-512.png') then
    raise exception 'Ícones não encontrados.' using errcode = 'P0001';
  end if;
  update public.tenant_branding set app_icons_version = p_version, updated_at = now() where tenant_id = p_tenant;
  perform app.audit(p_tenant, 'app_icons.updated', 'tenant', p_tenant::text, jsonb_build_object('version', p_version));
end $$;
revoke all on function public.set_app_icons_version(uuid, bigint) from public, anon;
grant execute on function public.set_app_icons_version(uuid, bigint) to authenticated, service_role;

drop policy if exists pp_public_insert on storage.objects;
create policy pp_public_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-public' and app.has_perm(app.path_tenant(name), 'settings')
    and (split_part(name, '/', 2) like 'logo-%'
      or (split_part(name, '/', 2) ~ '^app-v[0-9]{10,16}$' and split_part(name, '/', 3) in ('icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-180.png'))));

create or replace function public.portal_info(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('slug', t.slug, 'name', coalesce(b.display_name, t.name), 'logo_path', b.logo_path,
    'color_primary', b.color_primary, 'color_secondary', b.color_secondary, 'color_accent', b.color_accent,
    'status', case when t.status = 'active' then 'active' else 'unavailable' end,
    'tenant_id', t.id, 'icons_version', b.app_icons_version)
  from public.tenants t left join public.tenant_branding b on b.tenant_id = t.id
  where t.slug = lower(btrim(p_slug)) and t.status <> 'closed'
$$;
