-- =============================================================================
-- Organizações (administradoras) com carteira de condomínios.
--  * Papéis próprios (org_admin | org_viewer); NÃO reutiliza o acesso global da plataforma.
--  * Vínculo org↔condomínio explícito: nasce "pending" e só fica "active" quando um
--    administrador do condomínio com permissão "settings" aprova. A plataforma pode criar
--    o vínculo ativo com organizations_manage, justificativa e auditoria.
--  * Convite de membro por e-mail com token de uso único (só o hash é guardado), expiração
--    de 7 dias, revogação imediata.
--  * Leitura da carteira: somente agregados (contagens), via app.dashboard_operation_core,
--    a mesma lógica da Visão geral do condomínio. Sem moradores, unidades, fotos ou assinaturas.
--  * public.dashboard_operation continua exigindo admin do condomínio (mesma checagem).
-- =============================================================================

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 120),
  document text check (document is null or document ~ '^\d{11}$|^\d{14}$'),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('org_admin', 'org_viewer')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id, status);

create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('org_admin', 'org_viewer')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index organization_invitations_org_idx on public.organization_invitations (org_id, created_at desc);

create table public.organization_tenants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'revoked')),
  source text not null default 'org_request' check (source in ('org_request', 'platform')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  authorized_by uuid references auth.users(id) on delete set null,   -- síndico que aprovou ou operador da plataforma
  authorized_at timestamptz,
  ended_by uuid references auth.users(id) on delete set null,
  ended_at timestamptz,
  unique (org_id, tenant_id),
  check (status <> 'active' or (authorized_by is not null and authorized_at is not null))
);
create index organization_tenants_tenant_idx on public.organization_tenants (tenant_id, status);

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.organization_tenants enable row level security;
revoke all on public.organizations, public.organization_members, public.organization_invitations, public.organization_tenants
  from public, anon, authenticated;
grant all on public.organizations, public.organization_members, public.organization_invitations, public.organization_tenants to service_role;

-- ---------------------------------------------------------------------------
-- Autorização
-- ---------------------------------------------------------------------------
create function app.org_role(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_members m join public.organizations o on o.id = m.org_id
  where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active' and o.status = 'active'
$$;

create function app.org_can_view_via(p_org uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.org_role(p_org) is not null and exists (select 1 from public.organization_tenants l
    where l.org_id = p_org and l.tenant_id = p_tenant and l.status = 'active')
$$;

-- Membro ativo de organização ativa com vínculo ativo para o condomínio.
create function app.org_can_view(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organization_tenants l
    join public.organization_members m on m.org_id = l.org_id and m.user_id = auth.uid() and m.status = 'active'
    join public.organizations o on o.id = l.org_id and o.status = 'active'
    where l.tenant_id = p_tenant and l.status = 'active')
$$;

-- ---------------------------------------------------------------------------
-- Visão operacional: núcleo sem checagem (interno) + wrapper público com a checagem original.
-- ---------------------------------------------------------------------------
create or replace function app.dashboard_operation_core(p_tenant uuid, p_stale_hours int default 72) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_now timestamptz := app.now(); v_day timestamptz; v_stale int := least(greatest(coalesce(p_stale_hours, 72), 1), 720);
begin
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_day := date_trunc('day', v_now at time zone v_tz) at time zone v_tz;
  return jsonb_build_object(
    'timezone', v_tz, 'stale_hours', v_stale, 'as_of', v_now,
    'waiting_now', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status)),
    'stale_now', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status)
                   and received_at <= v_now - make_interval(hours => v_stale)),
    'received_today', (select count(*) from public.packages where tenant_id = p_tenant and status <> 'PRE_REGISTRADA'
                        and received_at >= v_day and received_at < v_day + interval '1 day'),
    'picked_today', (select count(*) from public.packages where tenant_id = p_tenant and picked_up_at >= v_day and picked_up_at < v_day + interval '1 day'),
    'occupancy', (select jsonb_build_object('used', coalesce(sum(o.used), 0), 'capacity', nullif(coalesce(sum(sl.capacity), 0), 0))
                    from public.storage_locations sl
                    cross join lateral (select count(*) used from public.packages p where p.tenant_id = p_tenant
                                         and p.storage_location_id = sl.id and app.occupies_space(p.status)) o
                   where sl.tenant_id = p_tenant and sl.active),
    'unstored_now', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status) and storage_location_id is null),
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('id', sl.id, 'code', sl.code, 'rack', sl.rack, 'shelf', sl.shelf,
                    'capacity', sl.capacity, 'used', o.used, 'is_contingency', sl.is_contingency)
                    order by (o.used::numeric / sl.capacity) desc, sl.sort_order, sl.code), '[]'::jsonb)
                    from public.storage_locations sl
                    cross join lateral (select count(*) used from public.packages p where p.tenant_id = p_tenant
                                         and p.storage_location_id = sl.id and app.occupies_space(p.status)) o
                   where sl.tenant_id = p_tenant and sl.active),
    'attention', jsonb_build_object(
      'access_requests', (select count(*) from public.access_requests where tenant_id = p_tenant and status = 'pending'),
      'stale_packages', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status)
                          and received_at <= v_now - make_interval(hours => v_stale)),
      'near_capacity', (select count(*) from public.storage_locations sl where sl.tenant_id = p_tenant and sl.active
                         and (select count(*) from public.packages p where p.tenant_id = p_tenant and p.storage_location_id = sl.id
                              and app.occupies_space(p.status)) >= sl.capacity * 0.85),
      'notification_failures', (select count(*) from public.notification_jobs where tenant_id = p_tenant and status = 'failed' and attempts >= 5),
      'receipt_failures', (select count(*) from public.receipts where tenant_id = p_tenant and pdf_status = 'failed'),
      'preregistered', (select count(*) from public.packages where tenant_id = p_tenant and status = 'PRE_REGISTRADA')),
    'recent', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
      select jsonb_build_object('id', p.id, 'kind', case when p.picked_up_at is not null then 'picked' else 'received' end,
        'at', coalesce(p.picked_up_at, p.received_at), 'unit', concat_ws(' · ', u.block, u.label), 'carrier', p.carrier) x
        from public.packages p left join public.units u on u.id = p.unit_id
       where p.tenant_id = p_tenant and p.status <> 'PRE_REGISTRADA'
       order by coalesce(p.picked_up_at, p.received_at) desc limit 8) r));
end $$;

create or replace function public.dashboard_operation(p_tenant uuid, p_stale_hours int default 72) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_admin(p_tenant));
  return app.dashboard_operation_core(p_tenant, p_stale_hours);
end $$;

-- Recorte somente de agregados para a administradora (sem "recent", sem ids de encomenda).
create function app.org_tenant_aggregates(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tenant_id', t.id, 'name', coalesce(b.display_name, t.name), 'tenant_status', t.status, 'timezone', t.timezone,
    'commercial_state', app.commercial_state(t.id),
    'waiting_now', (d->>'waiting_now')::int, 'stale_now', (d->>'stale_now')::int,
    'received_today', (d->>'received_today')::int, 'picked_today', (d->>'picked_today')::int,
    'occupancy', d->'occupancy', 'unstored_now', (d->>'unstored_now')::int,
    'notification_failures', (d->'attention'->>'notification_failures')::int,
    'receipt_failures', (d->'attention'->>'receipt_failures')::int,
    'pending_access_requests', (d->'attention'->>'access_requests')::int,
    'near_capacity', (d->'attention'->>'near_capacity')::int, 'as_of', d->'as_of')
  from public.tenants t left join public.tenant_branding b on b.tenant_id = t.id
  cross join lateral (select app.dashboard_operation_core(t.id, 72) d) x
  where t.id = p_tenant
$$;

-- ---------------------------------------------------------------------------
-- Organização: criação, contexto, carteira
-- ---------------------------------------------------------------------------
create function public.org_create(p_name text, p_document text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.organizations;
begin
  perform app.require(auth.uid() is not null and app.email_verified(), 'Confirme seu e-mail antes de criar uma administradora.');
  if (select count(*) from public.organizations where created_by = auth.uid()) >= 3 then
    raise exception 'Limite de administradoras criadas por esta conta atingido. Fale com o suporte.' using errcode = 'P0001';
  end if;
  insert into public.organizations (name, document, created_by)
  values (btrim(p_name), app.digits(p_document), auth.uid()) returning * into o;
  insert into public.organization_members (org_id, user_id, role, invited_by) values (o.id, auth.uid(), 'org_admin', auth.uid());
  perform app.audit(null, 'org.created', 'organization', o.id::text, '{}'::jsonb);
  return jsonb_build_object('id', o.id);
end $$;

create function public.my_orgs() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status, 'role', m.role,
      'tenants_active', (select count(*) from public.organization_tenants l where l.org_id = o.id and l.status = 'active'))
    order by o.name), '[]'::jsonb)
  from public.organization_members m join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid() and m.status = 'active'
$$;

create function public.org_detail(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r text := app.org_role(p_org); v_admin boolean;
begin
  perform app.require(r is not null, 'Você não faz parte desta administradora.');
  v_admin := r = 'org_admin';
  return (select jsonb_build_object('id', o.id, 'name', o.name, 'document', case when v_admin then o.document end, 'role', r,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'status', m.status,
        'name', coalesce(nullif(btrim(p.full_name), ''), split_part(u.email, '@', 1)),
        'email', case when v_admin then lower(u.email) end, 'me', m.user_id = auth.uid()) order by m.status, m.created_at), '[]'::jsonb)
      from public.organization_members m join auth.users u on u.id = m.user_id left join public.profiles p on p.id = m.user_id
      where m.org_id = o.id and (v_admin or m.status = 'active')),
    'invitations', case when v_admin then (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role,
        'expires_at', i.expires_at, 'expired', i.expires_at <= app.now()) order by i.created_at desc), '[]'::jsonb)
      from public.organization_invitations i where i.org_id = o.id and i.accepted_at is null and i.revoked_at is null) else '[]'::jsonb end,
    'links', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'tenant_id', l.tenant_id, 'status', l.status, 'source', l.source,
        'tenant_name', coalesce(b.display_name, t.name), 'requested_at', l.requested_at, 'authorized_at', l.authorized_at, 'ended_at', l.ended_at)
        order by l.status, coalesce(b.display_name, t.name)), '[]'::jsonb)
      from public.organization_tenants l join public.tenants t on t.id = l.tenant_id left join public.tenant_branding b on b.tenant_id = t.id
      where l.org_id = o.id))
    from public.organizations o where o.id = p_org);
end $$;

-- Carteira consolidada: só condomínios com vínculo ativo; só agregados.
create function public.org_portfolio(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.org_role(p_org) is not null, 'Você não faz parte desta administradora.');
  return (select coalesce(jsonb_agg(app.org_tenant_aggregates(l.tenant_id) order by coalesce(b.display_name, t.name)), '[]'::jsonb)
    from public.organization_tenants l join public.tenants t on t.id = l.tenant_id left join public.tenant_branding b on b.tenant_id = t.id
    where l.org_id = p_org and l.status = 'active' and app.org_can_view_via(p_org, l.tenant_id));
end $$;

-- Drill-down somente leitura e somente agregados.
create function public.org_tenant_overview(p_org uuid, p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d jsonb;
begin
  perform app.require(app.org_can_view_via(p_org, p_tenant), 'Sem vínculo ativo com este condomínio.');
  d := app.dashboard_operation_core(p_tenant, 72);
  return app.org_tenant_aggregates(p_tenant) || jsonb_build_object(
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('code', x->>'code', 'capacity', (x->>'capacity')::int,
        'used', (x->>'used')::int, 'is_contingency', (x->>'is_contingency')::boolean)), '[]'::jsonb)
      from jsonb_array_elements(d->'locations') x),
    'preregistered', (d->'attention'->>'preregistered')::int,
    'units_active', (select count(*) from public.units where tenant_id = p_tenant and active));
end $$;

-- ---------------------------------------------------------------------------
-- Membros e convites
-- ---------------------------------------------------------------------------
create function public.org_invite(p_org uuid, p_email text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_token text := app.random_token(); v_email text := lower(btrim(coalesce(p_email, ''))); i public.organization_invitations;
begin
  perform app.require(app.org_role(p_org) = 'org_admin', 'Somente administradores da administradora convidam.');
  if p_role not in ('org_admin', 'org_viewer') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  update public.organization_invitations set revoked_at = now()
   where org_id = p_org and email = v_email and accepted_at is null and revoked_at is null;
  insert into public.organization_invitations (org_id, email, role, token_hash, expires_at, created_by)
  values (p_org, v_email, p_role, app.sha256_hex(v_token), app.now() + interval '7 days', auth.uid()) returning * into i;
  perform app.audit(null, 'org.invitation_created', 'organization', p_org::text, jsonb_build_object('invitation', i.id, 'role', p_role));
  return jsonb_build_object('invitation_id', i.id, 'token', v_token, 'expires_at', i.expires_at);
end $$;

create function public.org_invitation_preview(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org_name', o.name, 'role', i.role,
    'valid', i.accepted_at is null and i.revoked_at is null and i.expires_at > app.now() and o.status = 'active')
  from public.organization_invitations i join public.organizations o on o.id = i.org_id
  where i.token_hash = app.sha256_hex(coalesce(p_token, ''))
$$;

create function public.org_accept_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.organization_invitations; v_uid uuid := auth.uid();
begin
  perform app.require(v_uid is not null, 'Faça login para aceitar o convite.');
  perform app.require(app.email_verified(), 'Confirme seu e-mail antes de aceitar o convite.');
  select * into i from public.organization_invitations where token_hash = app.sha256_hex(coalesce(p_token, '')) for update;
  if not found or i.revoked_at is not null then raise exception 'Convite inválido ou revogado.' using errcode = 'P0001'; end if;
  if i.accepted_at is not null then raise exception 'Este convite já foi utilizado.' using errcode = 'P0001'; end if;
  if i.expires_at <= app.now() then raise exception 'Convite expirado. Peça um novo à administradora.' using errcode = 'P0001'; end if;
  if i.email <> app.current_email() then
    raise exception 'Este convite foi enviado para outro e-mail. Entre com a conta de %.', i.email using errcode = '42501';
  end if;
  -- Quem convidou precisa continuar administrador (revogação vale para convites pendentes).
  if not exists (select 1 from public.organization_members m join public.organizations o on o.id = m.org_id
                  where m.org_id = i.org_id and m.user_id = i.created_by and m.role = 'org_admin' and m.status = 'active' and o.status = 'active') then
    update public.organization_invitations set revoked_at = now() where id = i.id;
    raise exception 'Convite revogado: quem o emitiu não administra mais esta administradora.' using errcode = 'P0001';
  end if;
  insert into public.organization_members (org_id, user_id, role, invited_by)
  values (i.org_id, v_uid, i.role, i.created_by)
  on conflict (org_id, user_id) do update set role = excluded.role, status = 'active', invited_by = excluded.invited_by, updated_at = now();
  update public.organization_invitations set accepted_at = now(), accepted_by = v_uid where id = i.id;
  perform app.audit(null, 'org.invitation_accepted', 'organization', i.org_id::text, jsonb_build_object('invitation', i.id, 'role', i.role));
  return jsonb_build_object('org_id', i.org_id);
end $$;

create function public.org_revoke_invitation(p_org uuid, p_invitation uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.org_role(p_org) = 'org_admin');
  update public.organization_invitations set revoked_at = now()
   where id = p_invitation and org_id = p_org and accepted_at is null and revoked_at is null;
  perform app.audit(null, 'org.invitation_revoked', 'organization', p_org::text, jsonb_build_object('invitation', p_invitation));
end $$;

create function public.org_set_member_status(p_org uuid, p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.org_role(p_org) = 'org_admin' or (p_user = auth.uid() and p_status = 'revoked'));
  if p_status not in ('active', 'revoked') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  perform 1 from public.organization_members where org_id = p_org for update;
  if p_status = 'revoked' and not exists (select 1 from public.organization_members where org_id = p_org and user_id <> p_user
      and role = 'org_admin' and status = 'active') and exists (select 1 from public.organization_members where org_id = p_org
      and user_id = p_user and role = 'org_admin' and status = 'active') then
    raise exception 'A administradora precisa de pelo menos um administrador ativo.' using errcode = 'P0001';
  end if;
  update public.organization_members set status = p_status, updated_at = now() where org_id = p_org and user_id = p_user;
  perform app.require(found, 'Membro não encontrado.');
  -- Revogado: convites pendentes emitidos por ele deixam de valer imediatamente.
  if p_status = 'revoked' then
    update public.organization_invitations set revoked_at = now()
     where org_id = p_org and created_by = p_user and accepted_at is null and revoked_at is null;
  end if;
  perform app.audit(null, 'org.member_' || p_status, 'organization', p_org::text, jsonb_build_object('user', p_user));
end $$;

-- ---------------------------------------------------------------------------
-- Vínculos org ↔ condomínio
-- ---------------------------------------------------------------------------
create function public.org_request_link(p_org uuid, p_slug text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; l public.organization_tenants;
begin
  perform app.require(app.org_role(p_org) = 'org_admin', 'Somente administradores da administradora pedem vínculo.');
  select id into v_tenant from public.tenants where slug = lower(btrim(coalesce(p_slug, ''))) and status = 'active';
  if v_tenant is null then raise exception 'Condomínio não encontrado. Confira o endereço (ex.: /c/meu-condominio).' using errcode = 'P0001'; end if;
  select * into l from public.organization_tenants where org_id = p_org and tenant_id = v_tenant for update;
  if found and l.status in ('pending', 'active') then return jsonb_build_object('id', l.id, 'status', l.status); end if;
  insert into public.organization_tenants (org_id, tenant_id, status, source, requested_by, requested_at)
  values (p_org, v_tenant, 'pending', 'org_request', auth.uid(), now())
  on conflict (org_id, tenant_id) do update set status = 'pending', source = 'org_request', requested_by = excluded.requested_by,
    requested_at = excluded.requested_at, authorized_by = null, authorized_at = null, ended_by = null, ended_at = null
  returning * into l;
  perform app.audit(v_tenant, 'org.link_requested', 'organization_tenant', l.id::text, jsonb_build_object('org', p_org));
  return jsonb_build_object('id', l.id, 'status', l.status);
end $$;

-- Lado do condomínio: administrador com permissão "settings".
create function public.tenant_org_links(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings'));
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'org_id', o.id, 'org_name', o.name, 'org_document', o.document,
      'status', l.status, 'source', l.source, 'requested_at', l.requested_at, 'authorized_at', l.authorized_at, 'ended_at', l.ended_at,
      'requested_by_email', (select lower(email) from auth.users where id = l.requested_by))
    order by (l.status = 'pending') desc, l.requested_at desc), '[]'::jsonb)
    from public.organization_tenants l join public.organizations o on o.id = l.org_id where l.tenant_id = p_tenant);
end $$;

create function public.tenant_org_decide(p_link uuid, p_decision text) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.organization_tenants;
begin
  select * into l from public.organization_tenants where id = p_link for update;
  perform app.require(found and app.has_perm(l.tenant_id, 'settings'));
  if p_decision = 'approve' then
    if l.status <> 'pending' then raise exception 'Este pedido não está mais pendente.' using errcode = 'P0001'; end if;
    update public.organization_tenants set status = 'active', authorized_by = auth.uid(), authorized_at = now() where id = l.id;
  elsif p_decision = 'reject' then
    if l.status <> 'pending' then raise exception 'Este pedido não está mais pendente.' using errcode = 'P0001'; end if;
    update public.organization_tenants set status = 'rejected', ended_by = auth.uid(), ended_at = now() where id = l.id;
  elsif p_decision = 'revoke' then
    if l.status not in ('active', 'pending') then return; end if;
    update public.organization_tenants set status = 'revoked', ended_by = auth.uid(), ended_at = now() where id = l.id;
  else
    raise exception 'Decisão inválida.' using errcode = '22023';
  end if;
  perform app.audit(l.tenant_id, 'org.link_' || p_decision, 'organization_tenant', l.id::text, jsonb_build_object('org', l.org_id));
end $$;

-- A própria administradora pode encerrar um vínculo.
create function public.org_end_link(p_org uuid, p_link uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.organization_tenants;
begin
  perform app.require(app.org_role(p_org) = 'org_admin');
  select * into l from public.organization_tenants where id = p_link and org_id = p_org for update;
  perform app.require(found, 'Vínculo não encontrado.');
  if l.status not in ('active', 'pending') then return; end if;
  update public.organization_tenants set status = 'revoked', ended_by = auth.uid(), ended_at = now() where id = l.id;
  perform app.audit(l.tenant_id, 'org.link_ended_by_org', 'organization_tenant', l.id::text, jsonb_build_object('org', p_org));
end $$;

-- ---------------------------------------------------------------------------
-- Plataforma (organizations / organizations_manage)
-- ---------------------------------------------------------------------------
create function public.org_platform_list(p_query text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := nullif(lower(btrim(coalesce(p_query, ''))), '');
begin
  perform app.platform_require('organizations');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'document', o.document, 'status', o.status,
      'created_at', o.created_at,
      'members_active', (select count(*) from public.organization_members m where m.org_id = o.id and m.status = 'active'),
      'links', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'tenant_id', l.tenant_id, 'tenant_name', t.name,
          'status', l.status, 'source', l.source, 'authorized_at', l.authorized_at) order by t.name), '[]'::jsonb)
        from public.organization_tenants l join public.tenants t on t.id = l.tenant_id where l.org_id = o.id))
    order by o.name), '[]'::jsonb)
    from (select * from public.organizations o where q is null or position(q in lower(o.name || ' ' || coalesce(o.document, ''))) > 0
           order by o.name limit 50) o);
end $$;

create function public.org_platform_link(p_org uuid, p_tenant uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.organization_tenants;
begin
  perform app.platform_require('organizations_manage');
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Justifique o vínculo (mínimo de 10 caracteres).' using errcode = '22023'; end if;
  perform app.require(exists (select 1 from public.organizations where id = p_org), 'Administradora não encontrada.');
  perform app.require(exists (select 1 from public.tenants where id = p_tenant), 'Condomínio não encontrado.');
  insert into public.organization_tenants (org_id, tenant_id, status, source, requested_by, requested_at, authorized_by, authorized_at)
  values (p_org, p_tenant, 'active', 'platform', auth.uid(), now(), auth.uid(), now())
  on conflict (org_id, tenant_id) do update set status = 'active', source = 'platform', authorized_by = auth.uid(),
    authorized_at = now(), ended_by = null, ended_at = null
  returning * into l;
  perform app.audit(p_tenant, 'platform.org_link', 'organization_tenant', l.id::text, jsonb_build_object('org', p_org, 'reason', left(btrim(p_reason), 500)));
  return jsonb_build_object('id', l.id, 'status', l.status);
end $$;

create function public.org_platform_end_link(p_link uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare l public.organization_tenants;
begin
  perform app.platform_require('organizations_manage');
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Justifique (mínimo de 10 caracteres).' using errcode = '22023'; end if;
  select * into l from public.organization_tenants where id = p_link for update;
  perform app.require(found, 'Vínculo não encontrado.');
  update public.organization_tenants set status = 'revoked', ended_by = auth.uid(), ended_at = now() where id = l.id;
  perform app.audit(l.tenant_id, 'platform.org_link_revoked', 'organization_tenant', l.id::text, jsonb_build_object('org', l.org_id, 'reason', left(btrim(p_reason), 500)));
end $$;

create function public.org_platform_set_status(p_org uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.platform_require('organizations_manage');
  if p_status not in ('active', 'suspended') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Justifique (mínimo de 10 caracteres).' using errcode = '22023'; end if;
  update public.organizations set status = p_status where id = p_org;
  perform app.require(found, 'Administradora não encontrada.');
  perform app.audit(null, 'platform.org_status', 'organization', p_org::text, jsonb_build_object('status', p_status, 'reason', left(btrim(p_reason), 500)));
end $$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function app.org_role(uuid), app.org_can_view_via(uuid, uuid), app.org_can_view(uuid),
  app.dashboard_operation_core(uuid, int), app.org_tenant_aggregates(uuid) from public, anon, authenticated;
grant execute on function app.org_can_view(uuid) to authenticated, service_role;

revoke all on function public.org_create(text, text), public.my_orgs(), public.org_detail(uuid), public.org_portfolio(uuid),
  public.org_tenant_overview(uuid, uuid), public.org_invite(uuid, text, text), public.org_invitation_preview(text),
  public.org_accept_invitation(text), public.org_revoke_invitation(uuid, uuid), public.org_set_member_status(uuid, uuid, text),
  public.org_request_link(uuid, text), public.tenant_org_links(uuid), public.tenant_org_decide(uuid, text), public.org_end_link(uuid, uuid),
  public.org_platform_list(text), public.org_platform_link(uuid, uuid, text), public.org_platform_end_link(uuid, text),
  public.org_platform_set_status(uuid, text, text) from public, anon;
grant execute on function public.org_create(text, text), public.my_orgs(), public.org_detail(uuid), public.org_portfolio(uuid),
  public.org_tenant_overview(uuid, uuid), public.org_invite(uuid, text, text), public.org_invitation_preview(text),
  public.org_accept_invitation(text), public.org_revoke_invitation(uuid, uuid), public.org_set_member_status(uuid, uuid, text),
  public.org_request_link(uuid, text), public.tenant_org_links(uuid), public.tenant_org_decide(uuid, text), public.org_end_link(uuid, uuid),
  public.org_platform_list(text), public.org_platform_link(uuid, uuid, text), public.org_platform_end_link(uuid, text),
  public.org_platform_set_status(uuid, text, text) to authenticated, service_role;
grant execute on function public.org_invitation_preview(text) to anon;
