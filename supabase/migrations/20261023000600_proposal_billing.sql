-- Ponte proposta -> contrato verificado -> pedido -> pagamento verificado.
-- Aceite nunca concede serviço, não encurta o teste e não altera a assinatura vigente.
-- Preços privados ficam inativos; limites são resolvidos pelo preço EFETIVO (inclusive período anterior).
create table app.proposal_billing_terms (
  acceptance_id uuid primary key references public.contract_acceptances(id),
  proposal_id uuid not null unique references public.quote_proposals(id),
  tenant_id uuid not null references public.tenants(id),
  price_id uuid not null unique references public.plan_prices(id),
  limits jsonb not null,
  content_sha256 text not null
);
revoke all on app.proposal_billing_terms from public, anon, authenticated;
create trigger proposal_billing_immutable before update or delete on app.proposal_billing_terms
for each row execute function app.block_mutation();

-- Valida o snapshot jurídico sem confiar em preço/token do navegador.
create function app.proposal_billing_bind(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.contract_acceptances; p public.quote_proposals; b app.proposal_billing_terms; v int; price uuid;
begin
  select * into a from public.contract_acceptances where tenant_id=p_tenant and status='active';
  if not found or a.terms->>'source' is distinct from 'proposal' then return null; end if;
  if a.email_verified_at is null then raise exception 'Contrato sem verificação do representante.' using errcode='42501'; end if;
  select * into p from public.quote_proposals where token_hash=a.terms->>'proposal_token_sha256' for update;
  if not found or p.status <> 'accepted' then raise exception 'Proposta aceita obrigatória.' using errcode='P0001'; end if;
  if a.terms->>'plan_code' is distinct from p.content->>'plan_code'
     or a.terms->>'cycle' is distinct from p.cycle
     or (a.terms->>'amount_cents')::int is distinct from p.amount_cents
     or a.terms->'limits' is distinct from p.limits
     or (a.terms->>'valid_until')::timestamptz is distinct from p.valid_until
     or p.content_sha256 is distinct from app.sha256_hex(p.content::text) then
    raise exception 'Divergência entre proposta e contrato. Cobrança bloqueada.' using errcode='P0001';
  end if;
  select * into b from app.proposal_billing_terms where proposal_id=p.id;
  if found then
    if b.tenant_id<>p_tenant or b.acceptance_id<>a.id then
      raise exception 'Proposta já vinculada a outro contrato.' using errcode='P0001';
    end if;
    return b.price_id;
  end if;
  -- Mesmo bloqueio utilizado pela ativação comercial, para versionamento concorrente.
  perform pg_advisory_xact_lock(hashtextextended(p.plan_id::text || p.cycle,230200));
  select coalesce(max(version),0)+1 into v from public.plan_prices where plan_id=p.plan_id and cycle=p.cycle;
  insert into public.plan_prices(plan_id,cycle,amount_cents,version,active)
    values(p.plan_id,p.cycle,p.amount_cents,v,false) returning id into price;
  insert into app.proposal_billing_terms values(a.id,p.id,p_tenant,price,p.limits,p.content_sha256);
  perform app.audit(p_tenant,'quote.billing_bound','contract_acceptance',a.id::text,
    jsonb_build_object('proposal_id',p.id,'price_id',price,'content_sha256',p.content_sha256));
  return price;
end $$;

alter function app.ensure_open_order(uuid,text,uuid) rename to ensure_open_order_before_proposal;
create function app.ensure_open_order(p_sub uuid,p_kind text,p_actor uuid default null) returns public.billing_orders
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; o public.billing_orders; price uuid; pr public.plan_prices; b app.proposal_billing_terms; p public.quote_proposals;
begin
  select * into s from public.subscriptions where id=p_sub for update;
  price:=app.proposal_billing_bind(s.tenant_id);
  if price is null then return app.ensure_open_order_before_proposal(p_sub,p_kind,p_actor); end if;
  if s.trial_ends_at>app.now() and s.current_period_end is null then
    raise exception 'Seu mês grátis ainda está vigente. Aguarde o fim do teste.' using errcode='P0001';
  end if;
  if s.next_price_id is not null and s.next_price_id<>price then
    raise exception 'Troca de plano pendente diverge da proposta.' using errcode='P0001';
  end if;
  select * into b from app.proposal_billing_terms where price_id=price;
  select * into p from public.quote_proposals where id=b.proposal_id;
  select * into pr from public.plan_prices where id=price;
  select * into o from public.billing_orders where subscription_id=p_sub and status in ('pending','link_failed') for update;
  if found then
    if o.price_id=price and o.amount_cents=pr.amount_cents and o.cycle=pr.cycle
      and o.snapshot->'limits'=b.limits and o.snapshot->>'content_sha256'=b.content_sha256 then return o; end if;
    -- Não altera obrigações já oferecidas ao provedor, nem tentativas ambíguas.
    if o.checkout_url is not null or o.link_attempt_id is not null or o.link_state not in ('none','failed') then
      raise exception 'Pedido existente divergente exige conciliação antes da proposta.' using errcode='P0001';
    end if;
    update public.billing_orders set status='canceled',updated_at=app.now() where id=o.id;
    update public.notification_jobs set status='disabled' where event='billing_order' and ref_id=o.id::text and status in ('queued','failed');
  end if;
  insert into public.billing_orders(tenant_id,subscription_id,order_nsu,plan_id,price_id,cycle,amount_cents,snapshot,kind,created_by)
    values(s.tenant_id,s.id,'pp-'||replace(gen_random_uuid()::text,'-',''),pr.plan_id,price,pr.cycle,pr.amount_cents,
      p.content||jsonb_build_object('acceptance_id',b.acceptance_id,'proposal_id',p.id,'content_sha256',b.content_sha256,
        'limits',b.limits,'price_version',pr.version),p_kind,p_actor) returning * into o;
  perform app.enqueue_billing_email(s.tenant_id,'billing_order',o.id::text,
    jsonb_build_object('order_id',o.id,'amount_cents',o.amount_cents,'plan_name',p.content->>'plan_name','cycle',o.cycle));
  return o;
end $$;

-- RPC explícita do checkout: não recebe preço, plano nem token. Cliente sem proposta
-- conserva o contrato público e todas as regras de prepare_checkout.
create function public.prepare_proposal_billing(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare price uuid;
begin
  perform app.require(app.has_perm(p_tenant,'billing'),'Somente quem gerencia o faturamento pode pagar a assinatura.');
  perform 1 from public.billing_orders where tenant_id=p_tenant order by id for update;
  perform 1 from public.subscriptions where tenant_id=p_tenant for update;
  price:=app.proposal_billing_bind(p_tenant);
  if price is null then return public.prepare_checkout(p_tenant); end if;
  -- Ignora apenas catálogo público (preço negociado é privado); conserva teste,
  -- cancelamento e janela de renovação da implementação original.
  return public.prepare_checkout_before_authz_fix(p_tenant);
end $$;

create or replace function app.entitlements(p_tenant uuid) returns public.plan_entitlements
language sql stable security definer set search_path = '' as $$
  select (jsonb_populate_record(null::public.plan_entitlements,
    coalesce(b.limits,l.limits)||jsonb_build_object('plan_id',s.plan_id))).*
  from app.effective_subscription(p_tenant) s
  left join app.proposal_billing_terms b on b.tenant_id=p_tenant and b.price_id=s.price_id
  left join app.tenant_plan_limits l on l.tenant_id=p_tenant and l.plan_id=s.plan_id
$$;

-- Nenhum caminho antigo pode criar/ativar um pedido com snapshot negociado divergente.
create function app.guard_proposal_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare b app.proposal_billing_terms; p public.quote_proposals;
begin
  select * into b from app.proposal_billing_terms where price_id=new.price_id;
  if not found then
    if new.snapshot ? 'proposal_id' then raise exception 'Preço da proposta divergente.' using errcode='P0001'; end if;
    return new;
  end if;
  select * into p from public.quote_proposals where id=b.proposal_id;
  if new.tenant_id<>b.tenant_id or new.plan_id<>p.plan_id or new.cycle<>p.cycle or new.amount_cents<>p.amount_cents
    or new.snapshot->'limits' is distinct from b.limits
    or new.snapshot->>'proposal_id' is distinct from p.id::text
    or new.snapshot->>'acceptance_id' is distinct from b.acceptance_id::text
    or new.snapshot->>'content_sha256' is distinct from b.content_sha256 then
    raise exception 'Divergência no snapshot da proposta. Cobrança bloqueada.' using errcode='P0001';
  end if;
  if new.status='paid' and new.paid_amount_cents<p.amount_cents then
    raise exception 'Pagamento insuficiente para proposta.' using errcode='P0001';
  end if;
  return new;
end $$;
create trigger guard_proposal_order before insert or update on public.billing_orders
for each row execute function app.guard_proposal_order();

revoke all on function app.proposal_billing_bind(uuid),app.guard_proposal_order(),app.ensure_open_order_before_proposal(uuid,text,uuid)
 from public,anon,authenticated;
revoke all on function public.prepare_proposal_billing(uuid) from public,anon,authenticated;
grant execute on function public.prepare_proposal_billing(uuid) to authenticated;
