-- Platform operations: least-privilege metadata RPCs. Existing admin RPCs remain owner-only.
alter table public.platform_admins
  add column role text not null default 'owner' check (role in ('owner','support','finance','auditor')),
  add column active boolean not null default true;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.platform_admins where user_id = auth.uid() and role = 'owner' and active)
$$;

create function public.platform_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r text; caps text[] := '{}';
begin
  select role into r from public.platform_admins where user_id = auth.uid() and active;
  caps := case r
    when 'owner' then array['tenants','users','team','notifications','orders','incidents','audit','contacts','plans','trial_extend','tenant_status','membership_status','team_role','incident_resolve','notification_retry','plan_limits','plan_publish','plan_price','contact_status','courtesy_grant','courtesy_revoke','password_reset']
    when 'support' then array['tenants','users','notifications','contacts','membership_status','notification_retry','contact_status','password_reset']
    when 'finance' then array['tenants','orders','incidents','contacts','plans','trial_extend','incident_resolve','contact_status','courtesy_grant','courtesy_revoke']
    when 'auditor' then array['tenants','users','team','notifications','orders','incidents','audit','contacts','plans']
    else '{}'::text[] end;
  if r is not null then caps:=caps||array['overview','trials']; end if;
  return jsonb_build_object('user_id',auth.uid(),'role',r,'capabilities',caps);
end $$;

create function app.platform_require(p_capability text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare mfa boolean:=false; aal text;
begin
  perform app.require((public.platform_context()->'capabilities') ? p_capability,
    'Acesso restrito à administração da plataforma.');
  if p_capability not in ('overview','tenants','trials','users','team','notifications','orders','incidents','audit','contacts','plans')
    and to_regclass('auth.mfa_factors') is not null then
    execute 'select exists(select 1 from auth.mfa_factors where user_id=$1 and status=''verified'')' into mfa using auth.uid();
    aal:=coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'aal',current_setting('request.jwt.claim.aal',true));
    if mfa and aal is distinct from 'aal2' then raise exception 'Confirme o MFA antes desta ação.' using errcode='42501'; end if;
  end if;
end $$;

-- Private request ledger: no payload, tokens, addresses or arbitrary caller JSON persisted.
create table app.platform_requests (
  request_id uuid primary key,
  actor_id uuid not null,
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create table app.platform_user_cooldowns (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null
);

alter table public.notification_jobs
  add column platform_retry_count int not null default 0 check(platform_retry_count between 0 and 3),
  add column platform_retried_at timestamptz;

-- Accepted limits survive catalog edits, including a paid future/previous plan.
-- ponytail: one immutable snapshot per tenant/plan; renegotiation requires an explicit future migration.
create table app.tenant_plan_limits (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  limits jsonb not null,
  primary key (tenant_id,plan_id)
);
insert into app.tenant_plan_limits(tenant_id,plan_id,limits)
select distinct s.tenant_id,e.plan_id,to_jsonb(e)
from public.subscriptions s
join public.plan_entitlements e on e.plan_id in (s.plan_id,s.previous_plan_id,s.next_plan_id)
on conflict do nothing;
insert into app.tenant_plan_limits(tenant_id,plan_id,limits)
select distinct o.tenant_id,e.plan_id,to_jsonb(e) from public.billing_orders o
join public.plan_entitlements e on e.plan_id=o.plan_id where o.status in ('pending','link_failed','paid')
on conflict do nothing;

create function app.snapshot_plan_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare e public.plan_entitlements;
begin
  for e in select * from public.plan_entitlements
    where plan_id in (new.plan_id,new.previous_plan_id,new.next_plan_id) order by plan_id for share loop
    insert into app.tenant_plan_limits values(new.tenant_id,e.plan_id,to_jsonb(e)) on conflict do nothing;
  end loop;
  return new;
end $$;
create trigger subscription_limits_snapshot before insert or update of plan_id,previous_plan_id,next_plan_id
on public.subscriptions for each row execute function app.snapshot_plan_limits();

create or replace function app.entitlements(p_tenant uuid) returns public.plan_entitlements
language sql stable security definer set search_path = '' as $$
  select (jsonb_populate_record(null::public.plan_entitlements,l.limits)).*
  from app.tenant_plan_limits l where l.tenant_id=p_tenant
    and l.plan_id=(app.effective_subscription(p_tenant)).plan_id
$$;

-- Courtesy is access only, never payment, revenue, trial eligibility or invoice settlement.
create table public.platform_courtesies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  granted_by uuid not null,
  reason text not null check (length(btrim(reason)) between 10 and 1000),
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz not null default now()
);
create index platform_courtesies_tenant_idx on public.platform_courtesies(tenant_id,ends_at) where revoked_at is null;
alter table public.platform_courtesies enable row level security;
revoke all on public.platform_courtesies from public,anon,authenticated;
revoke all on app.platform_requests,app.platform_user_cooldowns,app.tenant_plan_limits from public,anon,authenticated;

create or replace function app.commercial_state(p_tenant uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_until timestamptz; v_grace int; v_status text; v_now timestamptz := app.now();
begin
  if not exists(select 1 from public.tenants where id=p_tenant and status='active') then return 'restricted'; end if;
  select s.status,app.access_until(p_tenant),coalesce(ts.grace_days,7)
    into v_status,v_until,v_grace from public.subscriptions s
    left join public.tenant_settings ts on ts.tenant_id=s.tenant_id where s.tenant_id=p_tenant;
  if v_status is null or v_status='suspended' then return 'restricted'; end if;
  if exists(select 1 from public.platform_courtesies where tenant_id=p_tenant and revoked_at is null
    and starts_at<=v_now and ends_at>v_now) then return 'full'; end if;
  if v_until is not null and v_now<v_until then return 'full'; end if;
  if v_status='canceled' then return 'restricted'; end if;
  if v_until is not null and v_now<v_until+make_interval(days=>v_grace) then return 'grace'; end if;
  return 'restricted';
end $$;

-- Team mutations serialize before reading owner counts, including service-role writes.
create function app.platform_team_lock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(210002,1);
  return null;
end $$;
create trigger platform_team_lock before insert or update or delete on public.platform_admins
for each statement execute function app.platform_team_lock();
create function app.platform_team_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and new.user_id<>old.user_id then raise exception 'Identidade imutável.' using errcode='22023'; end if;
  if tg_op='INSERT' then
    if auth.uid()=new.user_id then raise exception 'Autoelevação proibida.' using errcode='42501'; end if;
    return new;
  end if;
  if old.active and old.role='owner' and (tg_op='DELETE' or not new.active or new.role<>'owner') then
    if not exists(select 1 from public.platform_admins where user_id<>old.user_id and role='owner' and active) then
      raise exception 'Último owner protegido.' using errcode='42501';
    end if;
  end if;
  if tg_op='UPDATE' and auth.uid()=old.user_id and (new.role<>old.role or new.active<>old.active) then
    raise exception 'Alteração da própria autoridade proibida.' using errcode='42501';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger platform_team_guard before insert or update or delete on public.platform_admins
for each row execute function app.platform_team_guard();

create function app.platform_mask(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case when nullif(p_value,'') is null then null else left(p_value,1)||'***'||right(p_value,2) end
$$;

create function public.platform_list(p_section text,p_query text default '',p_status text default '',
  p_tenant uuid default null,p_page int default 0,p_from date default null,p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare source text; result jsonb;
begin
  perform app.platform_require(p_section);
  if p_page is null or p_page<0 or p_page>100000 or length(coalesce(p_query,''))>120
    or length(coalesce(p_status,''))>40 or (p_from is not null and p_to is not null and p_from>p_to) then
    raise exception 'Filtros inválidos.' using errcode='22023';
  end if;
  -- Each projection is a strict allowlist. Never serialize underlying rows wholesale.
  source := case p_section
    when 'tenants' then $q$select t.id,t.id tenant_id,t.name,t.slug,t.status,t.created_at,
      s.status subscription_status,p.code plan_code,s.trial_ends_at,s.current_period_end period_end,
      app.commercial_state(t.id) commercial_state,
      case when s.trial_ends_at is null or s.current_period_end is not null then null
        when s.trial_ends_at>app.now() then 'active' else 'expired' end trial_state
      from public.tenants t left join public.subscriptions s on s.tenant_id=t.id left join public.plans p on p.id=s.plan_id$q$
    when 'trials' then $q$select t.id,t.id tenant_id,t.name,t.slug,t.status tenant_status,t.created_at,
      s.status subscription_status,p.code plan_code,s.trial_ends_at,s.current_period_end period_end,
      app.commercial_state(t.id) commercial_state,
      case when s.trial_ends_at>app.now() then 'active' else 'expired' end trial_state,
      case when s.trial_ends_at>app.now() then 'active' else 'expired' end status
      from public.tenants t join public.subscriptions s on s.tenant_id=t.id left join public.plans p on p.id=s.plan_id
      where s.trial_ends_at is not null and s.current_period_end is null$q$
    when 'users' then $q$select coalesce(m.id,u.id) id,m.tenant_id,u.id user_id,p.full_name,
      app.platform_mask(u.email::text) email,m.role,coalesce(m.status,'unassigned') status,p.created_at
      from auth.users u left join public.profiles p on p.id=u.id left join public.tenant_memberships m on m.user_id=u.id$q$
    when 'team' then $q$select a.user_id id,null::uuid tenant_id,p.full_name,app.platform_mask(u.email::text) email,
      a.role,a.active,case when a.active then 'active' else 'inactive' end status,a.created_at
      from public.platform_admins a join auth.users u on u.id=a.user_id left join public.profiles p on p.id=a.user_id$q$
    when 'notifications' then $q$select j.id,j.tenant_id,j.event,j.channel,app.platform_mask(j.recipient) recipient,
      j.status,j.attempts,j.next_attempt_at,j.created_at,
      (j.status='failed' and j.attempts>=5 and j.locked_until is null and j.platform_retry_count<3
       and (j.platform_retried_at is null or j.platform_retried_at<app.now()-interval '1 hour')
       and not coalesce(j.last_error,'') ~* 'timeout|ambiguous|in_progress') retryable from public.notification_jobs j$q$
    when 'orders' then $q$select id,tenant_id,status,amount_cents,cycle,kind,paid_at,plan_id,created_at from public.billing_orders$q$
    when 'incidents' then $q$select id,tenant_id,order_id,kind,resolved_at,
      case when resolved_at is null then 'open' else 'resolved' end status,created_at from public.billing_incidents$q$
    when 'audit' then $q$select id,nullif(tenant_id::text,'')::uuid tenant_id,actor_id,action,target_type,target_id,
      action status,created_at,
      case when action like 'platform.%' then jsonb_build_object('reason',data->>'reason','before',data->'before','after',data->'after') end details
      from public.audit_logs$q$
    when 'contacts' then $q$select id,null::uuid tenant_id,name,app.platform_mask(email) email,
      app.platform_mask(phone) phone,status,source,created_at,
      case when source='ajuda' then left(message,300) end message from public.contact_requests$q$
    when 'plans' then $q$select p.id,null::uuid tenant_id,p.code,p.name,p.published,
      case when p.published then 'published' else 'draft' end status,p.created_at,
      (to_jsonb(e)-'plan_id') entitlements,
      coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'cycle',pr.cycle,'amount_cents',pr.amount_cents,'version',pr.version) order by pr.cycle)
        from public.plan_prices pr where pr.plan_id=p.id and pr.active),'[]'::jsonb) prices
      from public.plans p left join public.plan_entitlements e on e.plan_id=p.id$q$
    else null end;
  if source is null then raise exception 'Seção inválida.' using errcode='22023'; end if;
  execute 'with filtered as materialized (select to_jsonb(x) d from ('||source||') x
    where ($1='''' or strpos(lower(to_jsonb(x)::text),lower($1))>0)
      and ($2='''' or x.status=$2) and ($3 is null or x.tenant_id=$3)
      and ($5 is null or x.created_at>=($5::timestamp at time zone ''UTC''))
      and ($6 is null or x.created_at<(($6+1)::timestamp at time zone ''UTC'')))
    select jsonb_build_object(''total'',(select count(*) from filtered),''rows'',
      coalesce((select jsonb_agg(d order by d->>''created_at'' desc,d->>''id'') from
        (select d from filtered order by d->>''created_at'' desc,d->>''id'' limit 25 offset $4) page),''[]''::jsonb))'
    into result using coalesce(p_query,''),coalesce(p_status,''),p_tenant,p_page::bigint*25,p_from,p_to;
  return result;
end $$;

create function public.platform_action(p_action text,p_target uuid,p_reason text,p_data jsonb default '{}',
  p_request uuid default gen_random_uuid()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  prior app.platform_requests; fingerprint text; result jsonb; tenant uuid; before_data jsonb; after_data jsonb;
  s public.subscriptions; m public.tenant_memberships; j public.notification_jobs; e public.plan_entitlements;
  end_at timestamptz; start_at timestamptz; state text; keys text[]; n int; plan_code text; price uuid;
begin
  perform app.platform_require(p_action);
  if p_target is null or p_request is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000
    or p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Dados e justificativa obrigatórios.' using errcode='22023'; end if;
  keys := case p_action
    when 'trial_extend' then array['ends_at','trial_state'] when 'tenant_status' then array['status']
    when 'membership_status' then array['status'] when 'team_role' then array['role','active']
    when 'plan_limits' then array['max_units','max_concierges','ocr_monthly','whatsapp_monthly','storage_mb','feature_ocr','feature_whatsapp','feature_totem','feature_reports_plus']
    when 'plan_publish' then array['published'] when 'plan_price' then array['cycle','amount_cents']
    when 'contact_status' then array['status'] when 'courtesy_grant' then array['starts_at','ends_at']
    when 'courtesy_revoke' then '{}'::text[] when 'incident_resolve' then '{}'::text[]
    when 'notification_retry' then array['delivery_confirmed_failed'] else null end;
  if keys is null or exists(select 1 from jsonb_object_keys(p_data) k where not k=any(keys)) then
    raise exception 'Ação ou campos inválidos.' using errcode='22023'; end if;
  fingerprint := app.sha256_hex(jsonb_build_array(p_action,p_target,btrim(p_reason),p_data)::text);
  perform pg_advisory_xact_lock(hashtextextended(p_request::text,210002));
  select * into prior from app.platform_requests where request_id=p_request;
  if found then
    if prior.actor_id<>auth.uid() or prior.fingerprint<>fingerprint then raise exception 'Conflito de idempotência.' using errcode='22023'; end if;
    return prior.result||jsonb_build_object('replayed',true);
  end if;

  case p_action
  when 'trial_extend' then
    -- Match payment lock order (order then subscription); do not cancel a captured/in-flight checkout.
    perform 1 from public.billing_orders where tenant_id=p_target order by id for update;
    select * into s from public.subscriptions where tenant_id=p_target for update;
    if not found then raise exception 'Assinatura não encontrada.'; end if;
    tenant:=p_target; end_at:=(p_data->>'ends_at')::timestamptz;
    state:=case when s.trial_ends_at>app.now() then 'active' else 'expired' end;
    if p_data->>'trial_state' is distinct from state or end_at is null or not isfinite(end_at)
      or end_at<=app.now() or end_at<=s.trial_ends_at or s.trial_started_at is null
      or s.status not in ('trialing','pending_payment') or s.current_period_end is not null then
      raise exception 'Trial ativo/expirado ou data final incompatível.' using errcode='22023'; end if;
    if exists(select 1 from public.billing_orders where tenant_id=tenant and status in ('pending','link_failed')
      and (checkout_url is not null or link_attempt_id is not null)) then
      raise exception 'Checkout existente exige conciliação antes da prorrogação.'; end if;
    before_data:=jsonb_build_object('ends_at',s.trial_ends_at,'trial_state',state);
    update public.subscriptions set trial_ends_at=end_at,status='trialing',trial_extended_reason=btrim(p_reason),
      reminders_sent='{}',updated_at=app.now() where id=s.id;
    update public.billing_orders set status='canceled',updated_at=app.now() where subscription_id=s.id and status in ('pending','link_failed');
    after_data:=jsonb_build_object('ends_at',end_at,'trial_state','active');
  when 'tenant_status' then
    select jsonb_build_object('status',status) into before_data from public.tenants where id=p_target for update;
    if not found then raise exception 'Condomínio não encontrado.'; end if;
    if coalesce(p_data->>'status','') not in ('active','suspended','closed') then raise exception 'Situação inválida.' using errcode='22023'; end if;
    tenant:=p_target; update public.tenants set status=p_data->>'status' where id=p_target; after_data:=p_data;
  when 'membership_status' then
    select tenant_id into tenant from public.tenant_memberships where id=p_target;
    perform 1 from public.tenants where id=tenant for update;
    select * into m from public.tenant_memberships where id=p_target for update;
    if not found then raise exception 'Vínculo não encontrado.'; end if;
    if m.user_id=auth.uid() or (m.role='admin' and not app.is_platform_admin()) then raise exception 'Autoridade protegida.' using errcode='42501'; end if;
    if coalesce(p_data->>'status','') not in ('active','revoked') then raise exception 'Situação inválida.' using errcode='22023'; end if;
    if m.role='admin' and m.status='active' and p_data->>'status'='revoked'
      and not exists(select 1 from public.tenant_memberships where tenant_id=tenant and id<>m.id and role='admin' and status='active') then
      raise exception 'Último administrador protegido.' using errcode='42501'; end if;
    before_data:=jsonb_build_object('status',m.status);
    update public.tenant_memberships set status=p_data->>'status',updated_at=app.now() where id=p_target;
    update public.unit_memberships set status='revoked' where tenant_id=tenant and user_id=m.user_id and p_data->>'status'='revoked';
    after_data:=p_data;
  when 'team_role' then
    perform pg_advisory_xact_lock(210002,1);
    -- Recheck after serialization: a concurrently deactivated owner cannot mutate the team.
    perform app.platform_require('team_role');
    if p_target=auth.uid() then raise exception 'Alteração da própria autoridade proibida.' using errcode='42501'; end if;
    if coalesce(p_data->>'role','') not in ('owner','support','finance','auditor') or jsonb_typeof(p_data->'active') is distinct from 'boolean' then
      raise exception 'Papel e estado obrigatórios.' using errcode='22023'; end if;
    if not exists(select 1 from auth.users where id=p_target and email_confirmed_at is not null) then raise exception 'Usuário verificado obrigatório.'; end if;
    select jsonb_build_object('role',role,'active',active) into before_data from public.platform_admins where user_id=p_target for update;
    insert into public.platform_admins(user_id,role,active) values(p_target,p_data->>'role',(p_data->>'active')::boolean)
      on conflict(user_id) do update set role=excluded.role,active=excluded.active;
    after_data:=p_data;
  when 'incident_resolve' then
    select tenant_id,jsonb_build_object('resolved_at',resolved_at) into tenant,before_data from public.billing_incidents where id=p_target for update;
    if not found then raise exception 'Ocorrência não encontrada.'; end if;
    update public.billing_incidents set resolved_at=coalesce(resolved_at,app.now()) where id=p_target;
    after_data:=jsonb_build_object('resolved',true); -- Never marks an order paid or changes ledger totals.
  when 'notification_retry' then
    if (p_data->>'delivery_confirmed_failed')::boolean is not true then
      raise exception 'Confirmação manual de falha definitiva obrigatória.' using errcode='22023'; end if;
    select * into j from public.notification_jobs where id=p_target for update;
    if not found then raise exception 'Notificação não encontrada.'; end if;
    if j.status<>'failed' or j.attempts<5 or j.locked_until is not null then raise exception 'Somente falha terminal sem reserva pode ser reenviada.'; end if;
    if j.platform_retry_count>=3 then raise exception 'Limite de tentativas administrativas atingido (máx. 3).' using errcode='P0001'; end if;
    if j.platform_retried_at is not null and j.platform_retried_at>app.now()-interval '1 hour' then
      raise exception 'Aguarde 1 hora entre retries administrativos.' using errcode='P0001'; end if;
    if coalesce(j.last_error,'') ~* 'timeout|ambiguous|in_progress' then
      raise exception 'Falha ambígua exige verificação técnica antes do reenvio.'; end if;
    if not app.notification_allowed(j) then raise exception 'Destinatário não autorizado.' using errcode='42501'; end if;
    tenant:=j.tenant_id; before_data:=jsonb_build_object('status',j.status,'attempts',j.attempts,'retry_count',j.platform_retry_count);
    update public.notification_jobs set status='queued',attempts=0,next_attempt_at=app.now(),last_error=null,
      platform_retry_count=platform_retry_count+1,platform_retried_at=app.now(),updated_at=app.now() where id=p_target;
    after_data:=jsonb_build_object('status','queued','attempts',0,'retry_count',j.platform_retry_count+1);
  when 'plan_limits' then
    if p_data='{}'::jsonb then raise exception 'Informe limites.' using errcode='22023'; end if;
    select * into e from public.plan_entitlements where plan_id=p_target for update;
    if not found then raise exception 'Plano não encontrado.'; end if;
    before_data:=to_jsonb(e)-'plan_id';
    e:=jsonb_populate_record(e,p_data);
    update public.plan_entitlements set max_units=e.max_units,max_concierges=e.max_concierges,ocr_monthly=e.ocr_monthly,
      whatsapp_monthly=e.whatsapp_monthly,storage_mb=e.storage_mb,feature_ocr=e.feature_ocr,feature_whatsapp=e.feature_whatsapp,
      feature_totem=e.feature_totem,feature_reports_plus=e.feature_reports_plus where plan_id=p_target;
    after_data:=to_jsonb(e)-'plan_id';
  when 'plan_publish' then
    if jsonb_typeof(p_data->'published') is distinct from 'boolean' then raise exception 'Publicação inválida.' using errcode='22023'; end if;
    select jsonb_build_object('published',published) into before_data from public.plans where id=p_target for update;
    if not found then raise exception 'Plano não encontrado.'; end if;
    update public.plans set published=(p_data->>'published')::boolean where id=p_target; after_data:=p_data;
  when 'plan_price' then
    select code into plan_code from public.plans where id=p_target for update;
    if not found then raise exception 'Plano não encontrado.'; end if;
    if coalesce(p_data->>'cycle','') not in ('monthly','quarterly','yearly') or coalesce((p_data->>'amount_cents')::int,0)<=0 then
      raise exception 'Preço inválido.' using errcode='22023'; end if;
    price:=public.admin_set_price(plan_code,p_data->>'cycle',(p_data->>'amount_cents')::int);
    after_data:=p_data||jsonb_build_object('price_id',price);
  when 'contact_status' then
    if coalesce(p_data->>'status','') not in ('novo','em_atendimento','resolvido') then raise exception 'Situação inválida.' using errcode='22023'; end if;
    select jsonb_build_object('status',status) into before_data from public.contact_requests where id=p_target for update;
    if not found then raise exception 'Contato não encontrado.'; end if;
    update public.contact_requests set status=p_data->>'status' where id=p_target; after_data:=p_data;
  when 'courtesy_grant' then
    tenant:=p_target; perform 1 from public.tenants where id=tenant and status='active' for update;
    if not found then raise exception 'Condomínio ativo obrigatório.'; end if;
    if not exists(select 1 from public.subscriptions where tenant_id=tenant and status<>'suspended') then raise exception 'Assinatura elegível obrigatória.'; end if;
    start_at:=(p_data->>'starts_at')::timestamptz; end_at:=(p_data->>'ends_at')::timestamptz;
    if start_at is null or end_at is null or not isfinite(start_at) or not isfinite(end_at)
      or end_at<=start_at or end_at<=app.now() or end_at>start_at+interval '366 days' then raise exception 'Período de cortesia inválido.' using errcode='22023'; end if;
    if exists(select 1 from public.platform_courtesies where tenant_id=tenant and revoked_at is null and starts_at<end_at and ends_at>start_at) then
      raise exception 'Cortesia sobreposta.'; end if;
    insert into public.platform_courtesies(tenant_id,starts_at,ends_at,granted_by,reason)
      values(tenant,start_at,end_at,auth.uid(),btrim(p_reason)) returning jsonb_build_object('id',id,'starts_at',starts_at,'ends_at',ends_at) into after_data;
  when 'courtesy_revoke' then
    select tenant_id into tenant from public.platform_courtesies where id=p_target;
    perform 1 from public.tenants where id=tenant for update;
    select jsonb_build_object('revoked_at',revoked_at) into before_data from public.platform_courtesies where id=p_target for update;
    if not found then raise exception 'Cortesia não encontrada.'; end if;
    update public.platform_courtesies set revoked_at=coalesce(revoked_at,app.now()),revoked_by=coalesce(revoked_by,auth.uid()) where id=p_target;
    after_data:=jsonb_build_object('revoked',true);
  else raise exception 'Ação inválida.' using errcode='22023';
  end case;
  result:=jsonb_build_object('ok',true,'action',p_action,'target',p_target,'request_id',p_request,'changes',after_data);
  perform app.audit(tenant,'platform.'||p_action,'platform',p_target::text,
    jsonb_build_object('request_id',p_request,'reason',btrim(p_reason),'before',before_data,'after',after_data));
  insert into app.platform_requests(request_id,actor_id,fingerprint,result) values(p_request,auth.uid(),fingerprint,result);
  return result;
end $$;

create function public.platform_authorize_user_action(p_user uuid,p_action text,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare email text; requested timestamptz;
begin
  perform app.platform_require('password_reset');
  if p_action is distinct from 'password_reset' or p_user is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then
    raise exception 'Solicitação inválida.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,210003));
  select u.email::text into email from auth.users u where u.id=p_user and u.email_confirmed_at is not null;
  if not found or nullif(email,'') is null then raise exception 'Usuário verificado não encontrado.'; end if;
  -- Support cannot initiate resets against privileged platform staff.
  if not app.is_platform_admin() and exists(select 1 from public.platform_admins where user_id=p_user and active) then
    raise exception 'Conta privilegiada protegida.' using errcode='42501'; end if;
  select requested_at into requested from app.platform_user_cooldowns where user_id=p_user;
  if requested>app.now()-interval '5 minutes' then raise exception 'Aguarde 5 minutos antes de solicitar novamente.' using errcode='P0001'; end if;
  insert into app.platform_user_cooldowns values(p_user,app.now()) on conflict(user_id) do update set requested_at=excluded.requested_at;
  perform app.audit(null,'platform.password_reset_requested','user',p_user::text,jsonb_build_object('reason',btrim(p_reason),'outcome','attempted'));
  return jsonb_build_object('email',email);
end $$;

create function public.platform_tenant_detail(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t jsonb; s public.subscriptions;
begin
  perform app.platform_require('tenants');
  select jsonb_build_object('id',id,'name',name,'slug',slug,'status',status,'timezone',timezone,'created_at',created_at,
    'commercial_state',app.commercial_state(id)) into t from public.tenants where id=p_tenant;
  if not found then raise exception 'Condomínio não encontrado.'; end if;
  s:=app.effective_subscription(p_tenant);
  return jsonb_build_object('tenant',t,'subscription',jsonb_build_object('status',s.status,'plan_id',s.plan_id,
    'cycle',s.cycle,'trial_ends_at',s.trial_ends_at,'current_period_end',s.current_period_end,
    'entitlements',to_jsonb(app.entitlements(p_tenant))-'plan_id'),
    'counts',jsonb_build_object('members',(select count(*) from public.tenant_memberships where tenant_id=p_tenant and status='active'),
      'units',(select count(*) from public.units where tenant_id=p_tenant),
      'packages',(select count(*) from public.packages where tenant_id=p_tenant)),
    'courtesies',coalesce((select jsonb_agg(jsonb_build_object('id',id,'starts_at',starts_at,'ends_at',ends_at,'revoked_at',revoked_at) order by created_at desc)
      from public.platform_courtesies where tenant_id=p_tenant),'[]'::jsonb));
end $$;

create function public.platform_overview(p_from date default null,p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; can_finance boolean;
begin
  perform app.platform_require('tenants');
  if p_from is not null and p_to is not null and p_from>p_to then raise exception 'Período inválido.' using errcode='22023'; end if;
  can_finance:=(public.platform_context()->'capabilities') ? 'orders';
  select jsonb_build_object('tenants_total',count(*),'tenants_active',count(*) filter(where t.status='active'),
    'trial_active',count(*) filter(where s.current_period_end is null and s.trial_ends_at>app.now()),
    'trial_expired',count(*) filter(where s.current_period_end is null and s.trial_ends_at<=app.now())) into result
    from public.tenants t left join public.subscriptions s on s.tenant_id=t.id
    where (p_from is null or t.created_at>=p_from::timestamp at time zone 'UTC')
      and (p_to is null or t.created_at<(p_to+1)::timestamp at time zone 'UTC');
  return result||jsonb_build_object(
    'paid_cents',case when can_finance then (select coalesce(sum(amount_cents),0) from public.payments
      where (p_from is null or created_at>=p_from::timestamp at time zone 'UTC') and (p_to is null or created_at<(p_to+1)::timestamp at time zone 'UTC')) end,
    'orders_pending',case when can_finance then (public.platform_list('orders','','pending',null,0,p_from,p_to)->'total') end,
    'incidents_open',case when can_finance then (public.platform_list('incidents','','open',null,0,p_from,p_to)->'total') end,
    'jobs_failed',case when (public.platform_context()->'capabilities') ? 'notifications' then (public.platform_list('notifications','','failed',null,0,p_from,p_to)->'total') end,
    'contacts_total',(public.platform_list('contacts','','',null,0,p_from,p_to)->'total'));
end $$;

-- Legacy entrypoints retain compatibility without retaining weaker validation.
create or replace function public.admin_extend_trial(p_tenant uuid,p_new_end timestamptz,p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare state text;
begin
  perform app.require(app.is_platform_admin());
  select case when trial_ends_at>app.now() then 'active' else 'expired' end into state
    from public.subscriptions where tenant_id=p_tenant;
  perform public.platform_action('trial_extend',p_tenant,p_reason,jsonb_build_object('ends_at',p_new_end,'trial_state',state));
end $$;
create or replace function public.admin_release_checkout_link(p_order uuid,p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare tenant uuid;
begin
  perform app.require(app.is_platform_admin());
  if p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then raise exception 'Justificativa obrigatória.' using errcode='22023'; end if;
  update public.billing_orders set link_state='none',link_attempt_id=null,updated_at=app.now()
    where id=p_order and link_state='ambiguous' and status in ('pending','link_failed') and checkout_url is null returning tenant_id into tenant;
  if not found then raise exception 'Pedido aberto ambíguo sem link obrigatório.'; end if;
  perform app.audit(tenant,'admin.checkout_link_released','billing_order',p_order::text,jsonb_build_object('reason',btrim(p_reason)));
end $$;

-- Raw audit log remains tenant-scoped; platform team accesses projected audit via platform_list.
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select to authenticated
  using (tenant_id is not null and app.is_admin(tenant_id));

revoke all on function app.platform_require(text),app.snapshot_plan_limits(),app.platform_team_lock(),app.platform_team_guard(),app.platform_mask(text) from public,anon,authenticated;
revoke all on function public.platform_context(),public.platform_list(text,text,text,uuid,int,date,date),
  public.platform_action(text,uuid,text,jsonb,uuid),public.platform_overview(date,date),public.platform_tenant_detail(uuid),
  public.platform_authorize_user_action(uuid,text,text) from public,anon,authenticated;
grant execute on function public.platform_context(),public.platform_list(text,text,text,uuid,int,date,date),
  public.platform_action(text,uuid,text,jsonb,uuid),public.platform_overview(date,date),public.platform_tenant_detail(uuid),
  public.platform_authorize_user_action(uuid,text,text) to authenticated;
