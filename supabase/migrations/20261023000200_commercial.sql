-- =============================================================================
-- PORTARIA PRIME — Comercial (1/2): custos de viabilidade, simulação de uso,
-- preço em rascunho (versão nova só para NOVOS contratos) e política de cobertura.
-- Orçamentos, propostas e o contrato de public.proposal_terms ficam em
-- 20261023000201_quotes.sql. Documentação: docs/COMERCIAL_PROPOSTAS.md.
--
-- Regras:
--  * Valores monetários sempre em centavos (numeric para custos unitários
--    fracionários, ex.: 0,3 centavo por leitura de OCR). Percentuais em %.
--  * Custo sem valor = AUSENTE (null). A simulação nunca trata ausência como zero:
--    devolve validated=false e a lista do que falta.
--  * Nada aqui é legível por anon/authenticated diretamente; só por RPC com
--    capacidade da plataforma ('costs' leitura, 'costs_manage' ações, 'plan_price'
--    ativação de preço).
-- =============================================================================

-- Custos configuráveis (cada valor com fonte, data e responsável).
create table public.commercial_costs (
  key text primary key check (key in ('infra_monthly', 'storage_gb_month', 'pdf_unit', 'ocr_unit', 'whatsapp_unit',
    'email_unit', 'payment_fee_pct', 'support_monthly', 'tax_pct', 'min_margin_pct')),
  label text not null,
  unit text not null check (unit in ('cents', 'percent')),
  value numeric(14, 4) check (value is null or value >= 0),
  source text,
  updated_at timestamptz,
  updated_by uuid,
  check (value is null or (length(btrim(coalesce(source, ''))) >= 3 and updated_at is not null)),
  check (unit <> 'percent' or value is null or value < 100)
);
insert into public.commercial_costs (key, label, unit) values
  ('infra_monthly', 'Infraestrutura mensal rateada por condomínio (centavos/mês)', 'cents'),
  ('storage_gb_month', 'Armazenamento (centavos por GB/mês)', 'cents'),
  ('pdf_unit', 'Geração de PDF (centavos por comprovante)', 'cents'),
  ('ocr_unit', 'OCR (centavos por leitura)', 'cents'),
  ('whatsapp_unit', 'WhatsApp (centavos por mensagem aceita)', 'cents'),
  ('email_unit', 'E-mail (centavos por mensagem)', 'cents'),
  ('payment_fee_pct', 'Taxa do meio de pagamento (% do preço)', 'percent'),
  ('support_monthly', 'Suporte (centavos por condomínio/mês)', 'cents'),
  ('tax_pct', 'Tributos (% do preço)', 'percent'),
  ('min_margin_pct', 'Margem mínima (% do preço)', 'percent');

-- Cenários de uso. São HIPÓTESES de consumo (não custos); ajuste por migration
-- quando houver dado real de produção.
-- ponytail: sem tela de edição de cenário; adicionar ação 'scenario_set' quando houver histórico de uso.
create table public.commercial_scenarios (
  code text primary key check (code in ('typical', 'high')),
  label text not null,
  occupancy numeric(5, 4) not null check (occupancy > 0 and occupancy <= 1),        -- fração de max_units ocupada
  packages_per_unit numeric(8, 2) not null check (packages_per_unit >= 0),         -- encomendas por unidade/mês
  residents_per_package int not null check (residents_per_package between 1 and 20), -- moradores avisados por encomenda
  events_per_package int not null check (events_per_package between 1 and 5),     -- avisos por encomenda (chegada + retirada)
  whatsapp_share numeric(5, 4) not null check (whatsapp_share between 0 and 1),
  email_share numeric(5, 4) not null check (email_share between 0 and 1),
  ocr_share numeric(5, 4) not null check (ocr_share between 0 and 1),
  mb_per_package numeric(8, 3) not null check (mb_per_package >= 0),               -- fotos + assinatura + PDF
  retention_months int not null check (retention_months between 1 and 120),
  source text not null
);
insert into public.commercial_scenarios values
  ('typical', 'Típico', 0.6, 2, 4, 2, 0.5, 0.5, 0.7, 0.6, 12, 'Hipótese inicial da equipe comercial (sem histórico de produção).'),
  ('high', 'Alto', 1.0, 4, 4, 2, 1.0, 1.0, 1.0, 1.0, 12, 'Hipótese de pior caso: plano lotado, todos os avisos por WhatsApp e e-mail.');

-- Política de cobertura de orçamento (linha única). Campanha pública desligada por padrão.
create table public.quote_policy (
  id boolean primary key default true check (id),
  discount_pct numeric(5, 2) not null default 5 check (discount_pct >= 0 and discount_pct < 50),
  campaign_active boolean not null default false,
  criteria_text text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (not campaign_active or length(btrim(coalesce(criteria_text, ''))) >= 20)
);
insert into public.quote_policy (id) values (true);

-- Preço proposto como rascunho: só vira plan_prices (catálogo) por ativação explícita.
create table public.plan_price_drafts (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id),
  cycle text not null check (cycle in ('monthly', 'quarterly', 'yearly')),
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'active', 'discarded')),
  note text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  activated_by uuid,
  activated_at timestamptz,
  price_id uuid references public.plan_prices(id),
  viability jsonb
);
create unique index plan_price_drafts_open_uq on public.plan_price_drafts (plan_id, cycle) where status in ('draft', 'approved');

-- Prime R$ 249/mês para NOVOS contratos: entra como rascunho (viabilidade ainda não validada).
insert into public.plan_price_drafts (plan_id, cycle, amount_cents, note)
select id, 'monthly', 24900, 'Prime R$ 249/mês para novos contratos. Assinaturas existentes mantêm o preço contratado.'
from public.plans where code = 'prime';

alter table public.commercial_costs enable row level security;
alter table public.commercial_scenarios enable row level security;
alter table public.quote_policy enable row level security;
alter table public.plan_price_drafts enable row level security;
revoke all on public.commercial_costs, public.commercial_scenarios, public.quote_policy, public.plan_price_drafts
  from public, anon, authenticated;
grant all on public.commercial_costs, public.commercial_scenarios, public.quote_policy, public.plan_price_drafts to service_role;

-- -----------------------------------------------------------------------------
-- Simulação. Consumo de franquia (ver docs): cada mensagem ACEITA pelo provedor por
-- destinatário consome 1; tentativas com falha, duplicatas (dedupe do outbox) e
-- envios desativados não consomem; o contador reinicia todo mês (período UTC AAAA-MM).
-- WhatsApp e OCR são limitados pela franquia do plano (além dela não há envio/leitura,
-- portanto não há custo). E-mail e PDF não têm franquia.
-- -----------------------------------------------------------------------------
create function app.commercial_sim(e public.plan_entitlements, p_scenario text, p_units numeric, p_price_month numeric)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.commercial_scenarios; c jsonb; missing text[];
  units numeric; pk numeric; notices numeric; wa numeric; em numeric; ocr numeric; pdf numeric; gb numeric;
  fixed numeric; variable numeric; fee numeric; tax numeric; marg numeric; floor_m numeric; cost numeric; usage jsonb;
begin
  select * into s from public.commercial_scenarios where code = p_scenario;
  if not found then raise exception 'Cenário inválido.' using errcode = '22023'; end if;
  select coalesce(array_agg(k order by k), '{}') into missing
    from unnest(array['infra_monthly', 'storage_gb_month', 'pdf_unit', 'ocr_unit', 'whatsapp_unit', 'email_unit',
      'payment_fee_pct', 'support_monthly', 'tax_pct', 'min_margin_pct']) k
   where not exists (select 1 from public.commercial_costs cc where cc.key = k and cc.value is not null);
  select coalesce(jsonb_object_agg(key, value), '{}') into c from public.commercial_costs where value is not null;

  units := coalesce(p_units, e.max_units * s.occupancy);
  pk := units * s.packages_per_unit;
  notices := pk * s.residents_per_package * s.events_per_package;
  wa := case when e.feature_whatsapp then least(notices * s.whatsapp_share, e.whatsapp_monthly) else 0 end;
  em := notices * s.email_share;
  ocr := case when e.feature_ocr then least(pk * s.ocr_share, e.ocr_monthly) else 0 end;
  pdf := pk;
  gb := least(e.storage_mb, pk * s.mb_per_package * s.retention_months) / 1024.0;
  usage := jsonb_build_object('units', round(units), 'packages', round(pk), 'notices', round(notices),
    'whatsapp', round(wa), 'email', round(em), 'ocr', round(ocr), 'pdf', round(pdf), 'storage_gb', round(gb, 2),
    'whatsapp_capped', e.feature_whatsapp and notices * s.whatsapp_share > e.whatsapp_monthly);

  if cardinality(missing) > 0 then
    return jsonb_build_object('validated', false, 'missing', to_jsonb(missing), 'scenario', p_scenario,
      'usage', usage, 'price_month_cents', round(p_price_month));
  end if;
  fee := (c ->> 'payment_fee_pct')::numeric / 100;
  tax := (c ->> 'tax_pct')::numeric / 100;
  marg := (c ->> 'min_margin_pct')::numeric / 100;
  if fee + tax + marg >= 1 then
    return jsonb_build_object('validated', false, 'missing', to_jsonb(array['percentuais_somam_100']), 'scenario', p_scenario,
      'usage', usage, 'price_month_cents', round(p_price_month));
  end if;
  fixed := (c ->> 'infra_monthly')::numeric + (c ->> 'support_monthly')::numeric;
  variable := fixed + gb * (c ->> 'storage_gb_month')::numeric + pdf * (c ->> 'pdf_unit')::numeric
    + ocr * (c ->> 'ocr_unit')::numeric + wa * (c ->> 'whatsapp_unit')::numeric + em * (c ->> 'email_unit')::numeric;
  -- Piso: preço em que, descontadas taxa e tributos, sobra a margem mínima sobre o preço.
  floor_m := ceil(variable / (1 - fee - tax - marg));
  cost := variable + coalesce(p_price_month, 0) * (fee + tax);
  return jsonb_build_object('validated', true, 'missing', '[]'::jsonb, 'scenario', p_scenario, 'usage', usage,
    'cost_cents', jsonb_build_object('fixed', round(fixed, 2), 'storage', round(gb * (c ->> 'storage_gb_month')::numeric, 2),
      'pdf', round(pdf * (c ->> 'pdf_unit')::numeric, 2), 'ocr', round(ocr * (c ->> 'ocr_unit')::numeric, 2),
      'whatsapp', round(wa * (c ->> 'whatsapp_unit')::numeric, 2), 'email', round(em * (c ->> 'email_unit')::numeric, 2),
      'payment_fee', round(coalesce(p_price_month, 0) * fee, 2), 'tax', round(coalesce(p_price_month, 0) * tax, 2)),
    'total_cost_cents', ceil(cost), 'price_month_cents', round(p_price_month),
    'margin_pct', case when p_price_month > 0 then round((p_price_month - cost) / p_price_month * 100, 2) end,
    'min_margin_pct', marg * 100, 'floor_month_cents', floor_m,
    'viable', coalesce(p_price_month >= floor_m, false));
end $$;

/** Viabilidade de um plano do catálogo. Preço padrão = versão ativa do ciclo. */
create function public.commercial_viability(p_plan text, p_scenario text default 'typical',
  p_amount_cents int default null, p_cycle text default 'monthly') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pl public.plans; e public.plan_entitlements; amount int;
begin
  perform app.platform_require('costs');
  select * into pl from public.plans where code = p_plan;
  select * into e from public.plan_entitlements where plan_id = pl.id;
  if pl.id is null or e.plan_id is null then raise exception 'Plano não encontrado.' using errcode = 'P0002'; end if;
  if coalesce(p_cycle, '') not in ('monthly', 'quarterly', 'yearly') then raise exception 'Ciclo inválido.' using errcode = '22023'; end if;
  amount := coalesce(p_amount_cents, (select amount_cents from public.plan_prices where plan_id = pl.id and cycle = p_cycle and active));
  return app.commercial_sim(e, p_scenario, null, amount::numeric / app.cycle_months(p_cycle))
    || jsonb_build_object('plan', pl.code, 'cycle', p_cycle, 'amount_cents', amount, 'is_custom', pl.is_custom);
end $$;

/** Painel de custos: custos, cenários, política, rascunhos de preço e simulação típica/alta por plano. */
create function public.commercial_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare plans jsonb;
begin
  perform app.platform_require('costs');
  select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'name', p.name, 'is_custom', p.is_custom, 'published', p.published,
      'price_month_cents', pr.amount_cents, 'entitlements', to_jsonb(e) - 'plan_id',
      'typical', case when not p.is_custom then app.commercial_sim(e, 'typical', null, pr.amount_cents) end,
      'high', case when not p.is_custom then app.commercial_sim(e, 'high', null, pr.amount_cents) end) order by p.sort_order), '[]')
    into plans
    from public.plans p join public.plan_entitlements e on e.plan_id = p.id
    left join public.plan_prices pr on pr.plan_id = p.id and pr.cycle = 'monthly' and pr.active;
  return jsonb_build_object(
    'costs', (select jsonb_agg(jsonb_build_object('key', key, 'label', label, 'unit', unit, 'value', value, 'source', source,
      'updated_at', updated_at, 'updated_by', updated_by) order by key) from public.commercial_costs),
    'missing', (select coalesce(jsonb_agg(key order by key), '[]') from public.commercial_costs where value is null),
    'scenarios', (select jsonb_agg(to_jsonb(s) order by s.code) from public.commercial_scenarios s),
    'policy', (select to_jsonb(q) - 'id' from public.quote_policy q),
    'drafts', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'plan', p.code, 'plan_name', p.name, 'cycle', d.cycle,
      'amount_cents', d.amount_cents, 'status', d.status, 'note', d.note, 'created_at', d.created_at, 'approved_at', d.approved_at,
      'activated_at', d.activated_at,
      'current_cents', (select amount_cents from public.plan_prices where plan_id = d.plan_id and cycle = d.cycle and active),
      'viability', case when d.status in ('draft', 'approved') then app.commercial_sim(e, 'high', null, d.amount_cents::numeric / app.cycle_months(d.cycle))
        else d.viability end) order by d.created_at desc), '[]')
      from public.plan_price_drafts d join public.plans p on p.id = d.plan_id join public.plan_entitlements e on e.plan_id = d.plan_id),
    'plans', plans);
end $$;

/**
 * Ações de custos e preço (todas auditadas, justificativa >= 10 caracteres).
 *   cost_set      (costs_manage) target=chave   data {value, source}   value null = remover (volta a "ausente")
 *   policy_set    (costs_manage)                data {discount_pct, campaign_active, criteria_text}
 *   price_draft   (costs_manage)                data {plan, cycle, amount_cents}
 *   price_approve (costs_manage) target=rascunho
 *   price_discard (costs_manage) target=rascunho
 *   price_activate(plan_price)   target=rascunho aprovado; exige viabilidade validada e preço >= piso
 *                                no cenário ALTO. Cria nova versão em plan_prices (só novos contratos;
 *                                assinaturas guardam price_cents_snapshot e limites congelados).
 */
create function public.commercial_action(p_action text, p_target text, p_data jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.plan_price_drafts; e public.plan_entitlements; pl public.plans; sim jsonb; v int; pid uuid;
  before_data jsonb; after_data jsonb; val numeric;
begin
  perform app.platform_require(case when p_action = 'price_activate' then 'plan_price' else 'costs_manage' end);
  if p_reason is null or length(btrim(p_reason)) not between 10 and 1000 or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Dados e justificativa (mín. 10 caracteres) obrigatórios.' using errcode = '22023';
  end if;
  case p_action
  when 'cost_set' then
    select jsonb_build_object('value', value, 'source', source) into before_data from public.commercial_costs where key = p_target for update;
    if not found then raise exception 'Custo desconhecido.' using errcode = '22023'; end if;
    if jsonb_typeof(p_data -> 'value') not in ('number', 'null') or (p_data ? 'value') is false then
      raise exception 'Valor numérico obrigatório (use null para remover).' using errcode = '22023';
    end if;
    val := (p_data ->> 'value')::numeric;
    if val is not null and length(btrim(coalesce(p_data ->> 'source', ''))) < 3 then
      raise exception 'Informe a fonte do valor.' using errcode = '22023';
    end if;
    update public.commercial_costs set value = val, source = case when val is null then null else left(btrim(p_data ->> 'source'), 300) end,
      updated_at = case when val is null then null else app.now() end, updated_by = auth.uid() where key = p_target;
    after_data := jsonb_build_object('value', val, 'source', p_data ->> 'source');
  when 'policy_set' then
    select to_jsonb(q) - 'id' into before_data from public.quote_policy q for update;
    if coalesce((p_data ->> 'campaign_active')::boolean, (before_data ->> 'campaign_active')::boolean)
       and length(btrim(coalesce(case when p_data ? 'criteria_text' then p_data ->> 'criteria_text' else before_data ->> 'criteria_text' end, ''))) < 20 then
      raise exception 'Campanha pública exige texto de critérios e exclusões (mín. 20 caracteres).' using errcode = '22023';
    end if;
    if p_data ? 'discount_pct' and ((p_data ->> 'discount_pct')::numeric < 0 or (p_data ->> 'discount_pct')::numeric >= 50) then
      raise exception 'Desconto entre 0 e 49,99%%.' using errcode = '22023';
    end if;
    update public.quote_policy set
      discount_pct = coalesce((p_data ->> 'discount_pct')::numeric, discount_pct),
      campaign_active = coalesce((p_data ->> 'campaign_active')::boolean, campaign_active),
      criteria_text = case when p_data ? 'criteria_text' then nullif(btrim(p_data ->> 'criteria_text'), '') else criteria_text end,
      updated_at = app.now(), updated_by = auth.uid();
    select to_jsonb(q) - 'id' into after_data from public.quote_policy q;
  when 'price_draft' then
    select * into pl from public.plans where code = p_data ->> 'plan';
    if not found or pl.is_custom then raise exception 'Plano inválido (sob medida é por proposta).' using errcode = '22023'; end if;
    if coalesce(p_data ->> 'cycle', '') not in ('monthly', 'quarterly', 'yearly')
       or jsonb_typeof(p_data -> 'amount_cents') <> 'number' or (p_data ->> 'amount_cents')::numeric <> floor((p_data ->> 'amount_cents')::numeric)
       or (p_data ->> 'amount_cents')::numeric <= 0 then
      raise exception 'Preço em centavos inteiros obrigatório.' using errcode = '22023';
    end if;
    insert into public.plan_price_drafts (plan_id, cycle, amount_cents, note, created_by)
      values (pl.id, p_data ->> 'cycle', (p_data ->> 'amount_cents')::int, btrim(p_reason), auth.uid()) returning * into d;
    after_data := jsonb_build_object('id', d.id, 'plan', pl.code, 'cycle', d.cycle, 'amount_cents', d.amount_cents);
    p_target := d.id::text;
  when 'price_approve', 'price_discard', 'price_activate' then
    begin
      select * into d from public.plan_price_drafts where id = p_target::uuid for update;
    exception when invalid_text_representation then raise exception 'Rascunho inválido.' using errcode = '22023';
    end;
    if not found then raise exception 'Rascunho não encontrado.' using errcode = 'P0002'; end if;
    before_data := jsonb_build_object('status', d.status);
    if p_action = 'price_approve' then
      if d.status <> 'draft' then raise exception 'Somente rascunho pode ser aprovado.' using errcode = 'P0001'; end if;
      update public.plan_price_drafts set status = 'approved', approved_by = auth.uid(), approved_at = app.now() where id = d.id;
    elsif p_action = 'price_discard' then
      if d.status not in ('draft', 'approved') then raise exception 'Preço já ativado não pode ser descartado.' using errcode = 'P0001'; end if;
      update public.plan_price_drafts set status = 'discarded' where id = d.id;
    else
      if d.status <> 'approved' then raise exception 'Aprove o rascunho antes de ativar.' using errcode = 'P0001'; end if;
      select * into e from public.plan_entitlements where plan_id = d.plan_id;
      sim := app.commercial_sim(e, 'high', null, d.amount_cents::numeric / app.cycle_months(d.cycle));
      if not (sim ->> 'validated')::boolean then
        raise exception 'Viabilidade não validada: faltam %.', (select string_agg(x, ', ') from jsonb_array_elements_text(sim -> 'missing') x)
          using errcode = 'P0001';
      end if;
      if not (sim ->> 'viable')::boolean then
        raise exception 'Preço abaixo do piso (custo + margem mínima) no cenário alto: piso mensal % centavos.', sim ->> 'floor_month_cents'
          using errcode = 'P0001';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(d.plan_id::text || d.cycle, 230200));
      select coalesce(max(version), 0) + 1 into v from public.plan_prices where plan_id = d.plan_id and cycle = d.cycle;
      update public.plan_prices set active = false where plan_id = d.plan_id and cycle = d.cycle and active;
      insert into public.plan_prices (plan_id, cycle, amount_cents, version) values (d.plan_id, d.cycle, d.amount_cents, v) returning id into pid;
      update public.plan_price_drafts set status = 'active', activated_by = auth.uid(), activated_at = app.now(), price_id = pid, viability = sim
        where id = d.id;
    end if;
    select jsonb_build_object('status', status, 'price_id', price_id) into after_data from public.plan_price_drafts where id = d.id;
  else
    raise exception 'Ação inválida.' using errcode = '22023';
  end case;
  perform app.audit(null, 'commercial.' || p_action, 'commercial', p_target,
    jsonb_build_object('reason', btrim(p_reason), 'before', before_data, 'after', after_data));
  return jsonb_build_object('ok', true, 'action', p_action, 'target', p_target, 'changes', after_data);
end $$;

-- Resumo público da campanha (só aparece quando ativa e com critérios).
create function public.quote_policy_public() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('campaign_active', campaign_active,
    'discount_pct', case when campaign_active then discount_pct end,
    'criteria_text', case when campaign_active then criteria_text end)
  from public.quote_policy
$$;

revoke all on function app.commercial_sim(public.plan_entitlements, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.commercial_viability(text, text, int, text), public.commercial_overview(),
  public.commercial_action(text, text, jsonb, text), public.quote_policy_public() from public, anon, authenticated;
grant execute on function public.commercial_viability(text, text, int, text), public.commercial_overview(),
  public.commercial_action(text, text, jsonb, text) to authenticated;
grant execute on function public.quote_policy_public() to anon, authenticated, service_role;
