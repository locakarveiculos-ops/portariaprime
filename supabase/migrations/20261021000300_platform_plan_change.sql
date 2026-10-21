-- Troca comercial global: sem personificação, sem pró-rata, sem alterar pedidos históricos.
create function public.platform_change_plan(p_tenant uuid,p_plan_code text,p_cycle text,p_reason text,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.subscriptions; pl public.plans; pr public.plan_prices; e public.plan_entitlements;
  previous app.platform_requests; fp text; result jsonb; units_count int; concierges_count int;
begin
  perform app.platform_require('trial_extend'); -- proprietário/financeiro; mesma fronteira comercial e MFA
  if p_tenant is null or p_request is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000
    or p_cycle is null or p_cycle not in ('monthly','quarterly','yearly') then
    raise exception 'Condomínio, ciclo e justificativa obrigatórios.' using errcode='22023';
  end if;
  fp:=app.sha256_hex(jsonb_build_array('platform_change_plan',p_tenant,p_plan_code,p_cycle,btrim(p_reason))::text);
  perform pg_advisory_xact_lock(hashtextextended(p_request::text,210002));
  select * into previous from app.platform_requests where request_id=p_request;
  if found then
    if previous.actor_id<>auth.uid() or previous.fingerprint<>fp then raise exception 'Conflito de idempotência.' using errcode='22023'; end if;
    return previous.result||jsonb_build_object('replayed',true);
  end if;
  -- Mesma ordem do pagamento: pedido antes da assinatura; não liberar link desconhecido.
  perform 1 from public.billing_orders where tenant_id=p_tenant order by id for update;
  perform 1 from public.tenants where id=p_tenant and status='active' for update;
  if not found then raise exception 'Condomínio ativo obrigatório.' using errcode='P0001'; end if;
  select * into s from public.subscriptions where tenant_id=p_tenant for update;
  if not found or s.status in ('suspended','canceled') then raise exception 'Assinatura indisponível para troca.' using errcode='P0001'; end if;
  select * into pl from public.plans where code=p_plan_code and published and not is_custom for share;
  if not found then raise exception 'Plano publicado obrigatório.' using errcode='22023'; end if;
  select * into pr from public.plan_prices where plan_id=pl.id and cycle=p_cycle and active for share;
  if not found then raise exception 'Preço ativo obrigatório.' using errcode='22023'; end if;
  select * into e from public.plan_entitlements where plan_id=pl.id for share;
  select (jsonb_populate_record(e,limits)).* into e from app.tenant_plan_limits where tenant_id=p_tenant and plan_id=pl.id;
  if not found then select * into e from public.plan_entitlements where plan_id=pl.id; end if;
  select count(*) into units_count from public.units where tenant_id=p_tenant and active;
  select count(*) into concierges_count from public.concierge_locations where tenant_id=p_tenant and active;
  if units_count>e.max_units or concierges_count>e.max_concierges then
    raise exception 'Uso atual excede o destino (% unidades, % portarias). Nenhum dado foi excluído.',units_count,concierges_count using errcode='P0001';
  end if;
  if exists(select 1 from public.billing_orders where tenant_id=p_tenant and status in ('pending','link_failed')
    and (checkout_url is not null or link_attempt_id is not null)) then
    raise exception 'Pedido com tentativa externa exige conciliação antes de trocar o plano.' using errcode='P0001';
  end if;
  if s.status='trialing' and s.trial_ends_at>app.now() then
    update public.subscriptions set plan_id=pl.id,price_id=pr.id,cycle=p_cycle,price_cents_snapshot=pr.amount_cents,
      next_plan_id=null,next_price_id=null,next_cycle=null,updated_at=app.now() where id=s.id;
    result:=jsonb_build_object('ok',true,'effective','now','trial_ends_at',s.trial_ends_at,'amount_cents',pr.amount_cents);
  else
    update public.subscriptions set next_plan_id=pl.id,next_price_id=pr.id,next_cycle=p_cycle,updated_at=app.now() where id=s.id;
    result:=jsonb_build_object('ok',true,'effective','next_payment','effective_at',s.current_period_end,'amount_cents',pr.amount_cents);
  end if;
  update public.billing_orders set status='canceled',updated_at=app.now() where subscription_id=s.id and status in ('pending','link_failed');
  perform app.audit(p_tenant,'platform.plan_change','subscription',s.id::text,
    jsonb_build_object('request_id',p_request,'reason',btrim(p_reason),'before',jsonb_build_object('plan_id',s.plan_id,'cycle',s.cycle),
      'after',result||jsonb_build_object('plan_id',pl.id,'cycle',p_cycle)));
  insert into app.platform_requests values(p_request,auth.uid(),fp,result,app.now());
  return result;
end $$;
revoke all on function public.platform_change_plan(uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.platform_change_plan(uuid,text,text,text,uuid) to authenticated;
