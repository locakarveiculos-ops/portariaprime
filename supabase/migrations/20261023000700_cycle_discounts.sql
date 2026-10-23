-- Desconto por ciclo para NOVOS contratos (decisão do proprietário em 23/10/2026):
--   trimestral = 3 x mensal - 5%   |   anual = 12 x mensal - 15%   (arredondado para baixo ao real)
-- Mensal não muda. Assinaturas e pedidos existentes não mudam: a cobrança usa o
-- price_cents_snapshot aceito; versões antigas ficam inativas e preservadas.
-- Ativação direta (sem o fluxo de viabilidade, ainda sem custos cadastrados), registrada na auditoria.
do $$
declare r record; v int; new_cents int;
begin
  for r in
    select p.id plan_id, p.code, m.amount_cents monthly, c.cycle
      from public.plans p
      join public.plan_prices m on m.plan_id = p.id and m.cycle = 'monthly' and m.active
      cross join (values ('quarterly'), ('yearly')) c(cycle)
     where not p.is_custom
  loop
    new_cents := (floor(r.monthly * case r.cycle when 'quarterly' then 3 * 0.95 else 12 * 0.85 end / 100) * 100)::int;
    if exists (select 1 from public.plan_prices where plan_id = r.plan_id and cycle = r.cycle and active and amount_cents = new_cents) then
      continue; -- idempotente
    end if;
    perform pg_advisory_xact_lock(hashtextextended(r.plan_id::text || r.cycle, 230200));
    select coalesce(max(version), 0) + 1 into v from public.plan_prices where plan_id = r.plan_id and cycle = r.cycle;
    update public.plan_prices set active = false where plan_id = r.plan_id and cycle = r.cycle and active;
    insert into public.plan_prices (plan_id, cycle, amount_cents, version) values (r.plan_id, r.cycle, new_cents, v);
    perform app.audit(null, 'commercial.cycle_discount', 'plan_price', r.code || ':' || r.cycle,
      jsonb_build_object('reason', 'Desconto por ciclo aprovado pelo proprietário: trimestral 5%, anual 15%',
        'monthly_cents', r.monthly, 'amount_cents', new_cents, 'version', v));
  end loop;
end $$;
