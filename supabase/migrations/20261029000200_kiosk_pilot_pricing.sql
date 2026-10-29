-- Modo Portaria Exclusiva (quiosque Android gerenciado, acesso piloto) incluído em todos os planos.
-- Nova tabela de preços SÓ para novas contratações:
--   mensal = mensal vigente + R$ 20,00
--   trimestral = 3 x novo mensal - 5%   |   anual = 12 x novo mensal - 15%   (arredondado para baixo ao real,
--   mesma política de 20261023000700_cycle_discounts.sql)
-- Versões de preço são imutáveis: cria nova versão e desativa a anterior (preservada).
-- Assinaturas, pedidos, propostas e contratos existentes NÃO mudam:
--   * cobrança usa price_cents_snapshot (inalterado);
--   * app.price_purchasable passa a aceitar a versão antiga que a assinatura já possui (antes,
--     desativar a versão bloqueava o checkout da renovação de quem já contratou);
--   * app.contract_terms mantém o preço da assinatura quando o aceite é do mesmo plano e ciclo.
-- Solicitações de ativação piloto usam contact_requests (source 'quiosque:piloto'); o Admin Master
-- vê os detalhes técnicos (marca, modelo, Android) na lista de contatos.
-- Idempotente (marcador de auditoria por plano). NÃO aplicar em produção sem revisão e backup.

do $$
declare r record; c text; v int; m int; new_cents int;
begin
  for r in
    select p.id plan_id, p.code, pr.amount_cents monthly
      from public.plans p join public.plan_prices pr on pr.plan_id = p.id and pr.cycle = 'monthly' and pr.active
     where not p.is_custom order by p.sort_order
  loop
    if exists (select 1 from public.audit_logs where action = 'commercial.kiosk_pilot_pricing' and target_id = r.code) then
      continue;
    end if;
    m := r.monthly + 2000;
    foreach c in array array['monthly', 'quarterly', 'yearly'] loop
      new_cents := case c when 'monthly' then m
        else (floor(m * case c when 'quarterly' then 3 * 0.95 else 12 * 0.85 end / 100) * 100)::int end;
      perform pg_advisory_xact_lock(hashtextextended(r.plan_id::text || c, 230200));
      select coalesce(max(version), 0) + 1 into v from public.plan_prices where plan_id = r.plan_id and cycle = c;
      update public.plan_prices set active = false where plan_id = r.plan_id and cycle = c and active;
      insert into public.plan_prices (plan_id, cycle, amount_cents, version) values (r.plan_id, c, new_cents, v);
    end loop;
    perform app.audit(null, 'commercial.kiosk_pilot_pricing', 'plan', r.code,
      jsonb_build_object('reason', 'Modo Portaria Exclusiva incluído: mensal + R$ 20,00; trimestral -5% e anual -15% sobre o novo mensal',
        'previous_monthly_cents', r.monthly, 'monthly_cents', m,
        'quarterly_cents', (floor(m * 3 * 0.95 / 100) * 100)::int, 'yearly_cents', (floor(m * 12 * 0.85 / 100) * 100)::int));
  end loop;
end $$;

-- Preço comprável: plano publicado e não sob medida. A versão pode estar inativa (substituída por
-- uma nova tabela): quem já tem essa versão na assinatura continua pagando o valor contratado.
create or replace function app.price_purchasable(p_price uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.plan_prices pr join public.plans p on p.id = pr.plan_id
    where pr.id = p_price and p.published and not p.is_custom)
$$;

-- Termos do aceite: igual à versão anterior, exceto que o aceite do MESMO plano e ciclo da assinatura
-- vigente mantém o preço já contratado (sem reajuste automático pela nova tabela).
create or replace function app.contract_terms(p_tenant uuid, p_plan_code text, p_cycle text, p_proposal text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pl public.plans; pr public.plan_prices; e public.plan_entitlements; s public.subscriptions; p jsonb; v_amount int; v_kept boolean := false;
begin
  select * into s from public.subscriptions where tenant_id = p_tenant;
  if nullif(btrim(coalesce(p_proposal, '')), '') is not null then
    if to_regprocedure('public.proposal_terms(text)') is null then
      raise exception 'Propostas comerciais ainda não estão disponíveis. Contrate por um plano do catálogo.' using errcode = 'P0001';
    end if;
    execute 'select public.proposal_terms($1)' into p using btrim(p_proposal);
    if p is null or jsonb_typeof(p) <> 'object' or coalesce((p ->> 'amount_cents')::int, 0) <= 0
       or app.cycle_months(p ->> 'cycle') is null then
      raise exception 'Proposta inválida ou não encontrada.' using errcode = 'P0002';
    end if;
    if (p ->> 'valid_until') is not null and (p ->> 'valid_until')::timestamptz <= app.now() then
      raise exception 'A proposta expirou. Solicite uma nova.' using errcode = 'P0001';
    end if;
    select * into pl from public.plans where code = p ->> 'plan_code';
    return jsonb_build_object('source', 'proposal', 'proposal_token_sha256', app.sha256_hex(btrim(p_proposal)),
      'plan_code', p ->> 'plan_code', 'plan_name', coalesce(pl.name, p ->> 'plan_code'), 'cycle', p ->> 'cycle',
      'amount_cents', (p ->> 'amount_cents')::int, 'limits', coalesce(p -> 'limits', '{}'::jsonb), 'valid_until', p -> 'valid_until',
      'billing', 'link_por_ciclo', 'trial_ends_at', case when s.status = 'trialing' then s.trial_ends_at end);
  end if;
  select * into pl from public.plans where code = p_plan_code and published and not is_custom;
  if not found then raise exception 'Plano indisponível.' using errcode = '22023'; end if;
  if s.plan_id = pl.id and s.cycle = p_cycle and s.next_price_id is null and s.price_id is not null then
    select * into pr from public.plan_prices where id = s.price_id;
    v_kept := found;
  end if;
  if not v_kept then
    select * into pr from public.plan_prices where plan_id = pl.id and cycle = p_cycle and active;
    if not found then raise exception 'Ciclo indisponível para este plano.' using errcode = '22023'; end if;
  end if;
  v_amount := case when v_kept then s.price_cents_snapshot else pr.amount_cents end;
  select * into e from public.plan_entitlements where plan_id = pl.id;
  return jsonb_build_object('source', 'catalog', 'plan_code', pl.code, 'plan_name', pl.name, 'cycle', pr.cycle,
    'amount_cents', v_amount, 'price_id', pr.id, 'price_version', pr.version, 'price_kept', v_kept, 'limits', to_jsonb(e) - 'plan_id',
    'billing', 'link_por_ciclo', 'trial_ends_at', case when s.status = 'trialing' then s.trial_ends_at end);
end $$;

-- Lista do Admin Master: igual à versão anterior; contatos de 'quiosque:piloto' também mostram a mensagem
-- (condomínio, marca, modelo e Android; e-mail e telefone continuam mascarados nas colunas próprias).
create or replace function public.platform_list(p_section text,p_query text default '',p_status text default '',
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
      case when source='ajuda' then left(message,300) when source='quiosque:piloto' then left(message,1200) end message
      from public.contact_requests$q$
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
