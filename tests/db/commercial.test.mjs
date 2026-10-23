// Comercial: preço novo só para novos contratos, viabilidade sem custo = não validada,
// sugestão 5% com piso, proposta imutável, token vencido, sem acesso direto, destinatário de quote_sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const COSTS = { infra_monthly: 1500, storage_gb_month: 15, pdf_unit: 0.05, ocr_unit: 0.4, whatsapp_unit: 0.2, email_unit: 0.01,
  payment_fee_pct: 5, support_monthly: 2000, tax_pct: 6, min_margin_pct: 20 };

async function setup() {
  const db = await createDb();
  db.setNow('2026-10-23T12:00:00Z');
  await db.sql('update plans set published = true');
  const owner = await db.createUser('owner@com.invalid');
  const support = await db.createUser('support@com.invalid');
  const sindico = await db.createUser('sindico@com.invalid');
  await db.sql("insert into platform_admins(user_id,role) values($1,'owner'),($2,'support')", [owner, support]);
  const cost = (key, value) => db.rpc(owner, 'commercial_action', { p_action: 'cost_set', p_target: key,
    p_data: JSON.stringify({ value, source: 'Fatura do fornecedor 10/2026' }), p_reason: 'Atualização de custo de teste' });
  const submit = (p, ip = 'a'.repeat(64)) => db.service('select public.quote_submit($1, $2) r', [JSON.stringify(p), ip]).then((r) => r[0].r);
  return { db, owner, support, sindico, cost, submit };
}

test('preço Prime R$ 249 em rascunho; ativação só com viabilidade; assinatura existente preservada', async () => {
  const { db, owner, sindico, cost } = await setup();
  try {
    const T = (await db.rpc(sindico, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Prime Antigo', p_slug: 'prime-antigo',
      p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const [{ price_cents_snapshot: before }] = await db.sql('select price_cents_snapshot from subscriptions where tenant_id=$1', [T]);
    assert.equal(before, 34900);
    const ov = await db.rpc(owner, 'commercial_overview');
    const draft = ov.drafts.find((d) => d.plan === 'prime');
    assert.deepEqual([draft.amount_cents, draft.status, draft.current_cents], [24900, 'draft', 34900]);
    assert.equal(ov.missing.length, 10);
    assert.equal(ov.plans.find((p) => p.code === 'prime').typical.validated, false);
    const act = (action, target = draft.id) => db.rpc(owner, 'commercial_action', { p_action: action, p_target: target, p_data: '{}', p_reason: 'Revisão comercial do Prime' });
    await assert.rejects(act('price_activate'), /Aprove/);
    await act('price_approve');
    await assert.rejects(act('price_activate'), /Viabilidade não validada/);
    for (const [k, v] of Object.entries(COSTS)) await cost(k, v);
    const r = await act('price_activate');
    assert.equal(r.changes.status, 'active');
    // Catálogo para novos contratos = 24900; assinatura existente mantém snapshot e limites congelados.
    assert.equal((await db.sql("select amount_cents from plan_prices pr join plans p on p.id=pr.plan_id where p.code='prime' and cycle='monthly' and active"))[0].amount_cents, 24900);
    assert.equal((await db.sql('select price_cents_snapshot from subscriptions where tenant_id=$1', [T]))[0].price_cents_snapshot, 34900);
    const other = await db.createUser('novo@com.invalid');
    const N = (await db.rpc(other, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Prime Novo', p_slug: 'prime-novo',
      p_document: '11222333000181', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    assert.equal((await db.sql('select price_cents_snapshot from subscriptions where tenant_id=$1', [N]))[0].price_cents_snapshot, 24900);
    // Essencial e Profissional mantêm valores.
    const keep = await db.sql("select p.code, pr.amount_cents from plan_prices pr join plans p on p.id=pr.plan_id where pr.active and cycle='monthly' and p.code in ('essencial','profissional') order by 1");
    assert.deepEqual(keep.map((x) => x.amount_cents), [9900, 14900]);
    assert.ok((await db.sql("select 1 from audit_logs where action='commercial.price_activate'")).length === 1);
  } finally { await db.raw.close(); }
});

test('viabilidade: custo ausente nunca vira zero', async () => {
  const { db, owner, support, cost } = await setup();
  try {
    for (const [k, v] of Object.entries(COSTS)) if (k !== 'whatsapp_unit') await cost(k, v);
    const v = await db.rpc(owner, 'commercial_viability', { p_plan: 'profissional', p_scenario: 'typical' });
    assert.equal(v.validated, false);
    assert.deepEqual(v.missing, ['whatsapp_unit']);
    assert.equal(v.total_cost_cents, undefined);
    assert.equal(v.usage.notices, Math.round(400 * 0.6 * 2 * 4 * 2), '4 moradores por encomenda, chegada + retirada');
    await cost("whatsapp_unit", 0.2);
    const ok = await db.rpc(owner, 'commercial_viability', { p_plan: 'profissional', p_scenario: 'high' });
    assert.equal(ok.validated, true);
    assert.equal(ok.usage.whatsapp, 1500, 'WhatsApp limitado à franquia');
    assert.equal(ok.usage.whatsapp_capped, true);
    await assert.rejects(db.rpc(support, 'commercial_viability', { p_plan: 'prime' }), /restrito/);
    await assert.rejects(db.rpc(owner, 'commercial_action', { p_action: 'cost_set', p_target: 'ocr_unit',
      p_data: JSON.stringify({ value: 1 }), p_reason: 'Sem fonte informada aqui' }), /fonte/);
    // Campanha pública exige critérios.
    await assert.rejects(db.rpc(owner, 'commercial_action', { p_action: 'policy_set', p_target: 'policy',
      p_data: JSON.stringify({ campaign_active: true }), p_reason: 'Ativar campanha pública' }), /critérios/);
  } finally { await db.raw.close(); }
});

test('sugestão 5% abaixo com piso, needs_review e proposta imutável com token', async () => {
  const { db, owner, cost, submit } = await setup();
  try {
    const base = { contact_name: 'Ana Síndica', email: 'Ana@Cond.invalid', org_kind: 'condominio', org_name: 'Residencial Azul',
      units: 300, concierges: 2, budget_cycle: 'monthly', budget_valid_until: '2026-12-31' };
    const q1 = await submit({ ...base, budget_cents: 20000 });
    assert.match(q1.protocol, /^PP-ORC-20261023-/);
    const q2 = await submit({ ...base, budget_cents: 14000 }, 'b'.repeat(64));
    // Desconto sem custos informados: needs_review (nunca promessa).
    let s = await db.rpc(owner, 'quote_suggest', { p_quote: q2.id });
    assert.equal(s.status, 'needs_review'); assert.match(s.reason, /Viabilidade/);
    for (const [k, v] of Object.entries(COSTS)) await cost(k, v);
    s = await db.rpc(owner, 'quote_suggest', { p_quote: q1.id });
    assert.equal(s.plan, 'profissional');
    // Catálogo 14900 já é <= 95% de 20000 -> catálogo.
    assert.deepEqual([s.status, s.suggested_cents], ['catalog', 14900]);
    s = await db.rpc(owner, 'quote_suggest', { p_quote: q2.id });
    assert.deepEqual([s.status, s.suggested_cents], ['ok', 13300]);
    const q3 = await submit({ ...base, budget_cents: 3000 }, 'c'.repeat(64));
    s = await db.rpc(owner, 'quote_suggest', { p_quote: q3.id });
    assert.equal(s.status, 'needs_review'); assert.match(s.reason, /piso/);
    assert.equal((await submit({ ...base, org_kind: 'administradora', condos_count: 5, budget_cents: 50000 }, 'd'.repeat(64))).protocol.length > 0, true);

    // Proposta: rascunho -> envio (congela) -> imutável.
    const d = await db.rpc(owner, 'quote_action', { p_action: 'proposal_draft', p_quote: q2.id, p_reason: 'Proposta comparativa',
      p_data: JSON.stringify({ plan: 'profissional', cycle: 'monthly', amount_cents: 13300, valid_days: 10, conditions: 'Preço válido por 12 meses a partir do aceite.' }) });
    const pid = d.data.proposal_id;
    await assert.rejects(db.rpc(owner, 'quote_action', { p_action: 'proposal_draft', p_quote: q3.id, p_reason: 'Tentativa abaixo do piso',
      p_data: JSON.stringify({ plan: 'profissional', cycle: 'monthly', amount_cents: 2850, valid_days: 10, conditions: 'Abaixo do piso de propósito.' }) })
      .then((x) => db.rpc(owner, 'quote_proposal_send', { p_proposal: x.data.proposal_id, p_reason: 'Envio abaixo do piso' })), /piso/);
    const sent = await db.rpc(owner, 'quote_proposal_send', { p_proposal: pid, p_reason: 'Envio autorizado pelo responsável' });
    assert.match(sent.protocol, /^PP-PROP-/);
    await assert.rejects(db.sql('update quote_proposals set amount_cents=1 where id=$1', [pid]), /imutável/);
    await assert.rejects(db.sql('delete from quote_proposals where id=$1', [pid]), /não pode ser excluída/);
    await assert.rejects(db.rpc(owner, 'quote_proposal_send', { p_proposal: pid, p_reason: 'Reenvio da mesma proposta' }), /imutável/);
    const [{ sha }] = await db.sql('select content_sha256 sha from quote_proposals where id=$1', [pid]);
    assert.match(sha, /^[0-9a-f]{64}$/);

    // quote_sent: um job só para o e-mail da solicitação; token só no payload do outbox (hash no banco).
    const jobs = await db.sql("select * from notification_jobs where event='quote_sent'");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].recipient, 'ana@cond.invalid');
    assert.equal(jobs[0].tenant_id, null);
    const token = jobs[0].payload.token;
    assert.equal((await db.sql('select token_hash from quote_proposals where id=$1', [pid]))[0].token_hash.includes(token), false);
    assert.equal((await db.service('select public.notification_is_authorized($1) r', [jobs[0].id]))[0].r, true);
    const ctx = (await db.service('select public.notification_context($1) r', [jobs[0].id]))[0].r;
    assert.equal(ctx.quote.protocol, q2.protocol);
    // Outro destinatário para o mesmo ref é descartado pela guarda do outbox.
    await db.sql("insert into notification_jobs(tenant_id,event,channel,recipient,ref_id) values(null,'quote_sent','email','intruso@x.invalid',$1)", [`${q2.id}:x`]);
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='quote_sent'"))[0].n, 1);
    await db.service("select public.complete_notification_job($1,'accepted','ref',null)", [jobs[0].id]);
    assert.equal((await db.sql('select payload from notification_jobs where id=$1', [jobs[0].id]))[0].payload.token, undefined, 'token removido após envio');

    // Link público: termos congelados; vencido rejeitado; aceite não recalcula.
    const terms = await db.rpc(null, 'proposal_terms', { p_token: token });
    assert.deepEqual([terms.amount_cents, terms.cycle, terms.plan_code, terms.limits.max_units], [13300, 'monthly', 'profissional', 400]);
    await assert.rejects(db.rpc(null, 'proposal_terms', { p_token: 'f'.repeat(64) }), /não encontrada/);
    await assert.rejects(db.rpc(null, 'proposal_terms', { p_token: "x' or 1=1" }), /não encontrada/);
    db.setNow('2026-11-10T12:00:00Z');
    await assert.rejects(db.rpc(null, 'proposal_terms', { p_token: token }), /vencida/);
    await assert.rejects(db.rpc(null, 'proposal_accept', { p_token: token }), /vencida/);
    assert.equal((await db.rpc(null, 'proposal_view', { p_token: token })).status, 'expired');
    db.setNow('2026-10-25T12:00:00Z');
    await db.sql("update plan_prices set active=false where active and plan_id=(select id from plans where code='profissional') and cycle='monthly'");
    const acc = await db.rpc(null, 'proposal_accept', { p_token: token });
    assert.deepEqual([acc.accepted, acc.amount_cents], [true, 13300]);
    db.setNow('2026-12-25T12:00:00Z');
    assert.equal((await db.rpc(null, 'proposal_terms', { p_token: token })).accepted, true, 'aceita continua válida');
    const detail = await db.rpc(owner, 'quote_detail', { p_quote: q2.id });
    assert.equal(detail.quote.status, 'aceita');
    assert.deepEqual(detail.events.map((e) => e.kind), ['received', 'proposal_draft', 'proposal_sent', 'proposal_accepted']);
    assert.equal(detail.quote.ip_hash, undefined);
    await assert.rejects(db.sql('update quote_events set kind=$1', ['x']), /append-only/);
  } finally { await db.raw.close(); }
});

test('nenhum acesso direto por anon/authenticated; limite por IP; retenção do anexo', async () => {
  const { db, owner, sindico, submit } = await setup();
  try {
    for (const t of ['quote_requests', 'quote_events', 'quote_proposals', 'commercial_costs', 'commercial_scenarios', 'quote_policy', 'plan_price_drafts']) {
      await assert.rejects(db.as(sindico, `select * from ${t}`), /permission denied/, t);
      await assert.rejects(db.as(null, `select * from ${t}`), /permission denied/, t);
      await assert.rejects(db.as(owner, `select * from ${t}`), /permission denied/, `${t} (owner também só por RPC)`);
    }
    for (const fn of ['quote_submit', 'quote_attach', 'quote_attachments_due']) {
      await assert.rejects(db.as(sindico, `select public.${fn}()`), /permission denied|does not exist/);
    }
    await assert.rejects(db.as(sindico, "select public.quote_submit('{}'::jsonb, $1)", ['a'.repeat(64)]), /permission denied/);
    await assert.rejects(db.rpc(sindico, 'quote_list'), /restrito/);
    await assert.rejects(db.rpc(sindico, 'commercial_overview'), /restrito/);
    await assert.rejects(db.rpc(null, 'quote_list'), /permission denied/);
    const p = { contact_name: 'Bia', email: 'bia@x.invalid', org_kind: 'condominio', org_name: 'Cond X', units: 50 };
    const ip = 'e'.repeat(64);
    const q = await submit(p, ip); await submit(p, ip); await submit(p, ip);
    await assert.rejects(submit(p, ip), /Aguarde/);
    await assert.rejects(submit({ ...p, email: 'invalido' }, 'f'.repeat(64)), /Confira/);
    await assert.rejects(db.service('select public.quote_attach($1,$2,$3,$4,$5)', [q.id, '../x.pdf', 'application/pdf', 10, 'a'.repeat(64)]), /Anexo inválido/);
    const path = `${q.id}/${crypto.randomUUID()}.pdf`;
    await db.service('select public.quote_attach($1,$2,$3,$4,$5)', [q.id, path, 'application/pdf', 10, 'a'.repeat(64)]);
    await assert.rejects(db.service('select public.quote_attach($1,$2,$3,$4,$5)', [q.id, path, 'application/pdf', 10, 'a'.repeat(64)]), /não aceito/);
    assert.equal((await db.service('select * from public.quote_attachments_due(10)')).length, 0);
    db.setNow('2027-05-01T12:00:00Z');
    const due = await db.service('select * from public.quote_attachments_due(10)');
    assert.deepEqual(due.map((d) => d.path), [path]);
    await db.service('select public.quote_attachment_purged($1,$2)', [q.id, path]);
    assert.equal((await db.sql('select attachment_path from quote_requests where id=$1', [q.id]))[0].attachment_path, null);
    const list = await db.rpc(owner, 'quote_list', {});
    assert.equal(list.total, 3);
    assert.doesNotMatch(JSON.stringify(list), /bia@x\.invalid|ip_hash/);

    // quote_sent: autorização sem tenant (destinatário prospect resolvido por quote_requests).
    const [job] = await db.sql("insert into notification_jobs(tenant_id,event,channel,recipient,ref_id) values(null,'quote_sent','email','bia@x.invalid',$1) returning id", [`${q.id}:test`]);
    assert.equal((await db.service('select public.notification_is_authorized($1) r', [job.id]))[0].r, true);
    // Destinatário diferente não é autorizado (não é o e-mail da solicitação).
    await db.sql("insert into notification_jobs(tenant_id,event,channel,recipient,ref_id) values(null,'quote_sent','email','outra@x.invalid',$1)", [`${q.id}:test2`]);
    const fakes = await db.sql("select id from notification_jobs where recipient = 'outra@x.invalid'");
    assert.equal(fakes.length, 0, 'descartado pelo trigger guard');
  } finally { await db.raw.close(); }
});

test('ponte proposta -> contrato verificado -> billing: snapshot idêntico, preserva teste e assinatura', async () => {
  const { db, owner, sindico, cost, submit } = await setup();
  try {
    for (const [k, v] of Object.entries(COSTS)) await cost(k, v);
    // Condomínio existente com assinatura em teste.
    const T = (await db.rpc(sindico, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond Ponte', p_slug: 'cond-ponte',
      p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const baseSub = (await db.sql('select * from subscriptions where tenant_id = $1', [T]))[0];
    assert.equal(baseSub.status, 'trialing');

    // Orçamento e proposta aceita de R$ 130,00 no Profissional.
    const q = await submit({ contact_name: 'Gestor', email: 'sindico@com.invalid', org_kind: 'condominio',
      org_name: 'Cond Ponte', units: 300, concierges: 2, budget_cents: 14000, budget_cycle: 'monthly' });
    const draft = await db.rpc(owner, 'quote_action', { p_action: 'proposal_draft', p_quote: q.id, p_reason: 'Proposta negociada',
      p_data: JSON.stringify({ plan: 'profissional', cycle: 'monthly', amount_cents: 13000, valid_days: 30, conditions: 'Condição especial 12 meses.' }) });
    await db.rpc(owner, 'quote_proposal_send', { p_proposal: draft.data.proposal_id, p_reason: 'Envio autorizado' });
    const [{ payload: pJob }] = await db.sql("select payload from notification_jobs where event='quote_sent'");
    const token = pJob.token;
    await db.rpc(null, 'proposal_accept', { p_token: token });

    // Publicação legal necessária para aceite do contrato SaaS.
    const legalDoc = { razao_social: 'Portaria Prime Testes Ltda', cnpj: '11222333000181', endereco: 'Rua Central, 1',
      email_contato: 'contato@prime.invalid', canal_privacidade: 'dpo@prime.invalid', encarregado: 'DPO Teste',
      foro: 'São Paulo', representante: 'Diretor Teste', horario_suporte: '9h às 18h', disponibilidade: '99%' };
    await db.rpc(owner, 'platform_legal_entity_set', { p: JSON.stringify(legalDoc) });
    const d = await db.rpc(owner, 'platform_legal_doc_save', { p_id: null, p_kind: 'contrato_saas', p_version: '1.0',
      p_content: '# Contrato SaaS\nPartes: {{RAZAO_SOCIAL}} / {{CNPJ}}.\nForo: {{FORO}}.', p_summary: null, p_change_note: null, p_material: true });
    for (const to of ['review', 'approved', 'published']) await db.rpc(owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: to, p_note: null });
    const pub = await db.rpc(null, 'legal_document_current', { p_kind: 'contrato_saas' });

    const quote = await db.rpc(sindico, 'contract_quote', { p_tenant: T, p_plan_code: null, p_cycle: null, p_proposal: token });
    assert.equal(quote.terms.amount_cents, 13000);
    assert.equal(quote.terms.source, 'proposal');

    const accept = (actor, extra = {}) => db.service(
      `select public.contract_accept($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) as r`,
      [actor, T, pub.sha256, true, null, null, token, 'Cond Ponte', '11444777000161',
       'Gestor', '11122233344', 'sindico@com.invalid', '11999998888', 'Síndico', 'Eleito em assembleia',
       extra.ip || '203.0.113.1', extra.ua || 'NodeTest']
    ).then((rows) => rows[0].r);

    const a = await accept(sindico);
    assert.equal(a.status, 'pending_verification');

    // Aceite pendente de verificação NÃO vincula cobrança nem cria pedido.
    await assert.rejects(db.rpc(sindico, 'prepare_proposal_billing', { p_tenant: T }), /mês grátis vai até/);
    assert.equal((await db.sql('select count(*)::int n from billing_orders where tenant_id = $1', [T]))[0].n, 0);
    assert.equal((await db.sql('select count(*)::int n from app.proposal_billing_terms'))[0].n, 0, 'sem vínculo antes da verificação');

    // Verificação do e-mail do representante.
    await db.service('select public.contract_set_code($1,$2,$3)', [sindico, a.id, '654321']);
    await db.service('select public.contract_verify($1,$2,$3)', [sindico, a.id, '654321']);
    const [{ status: cStatus }] = await db.sql('select status from contract_acceptances where id = $1', [a.id]);
    assert.equal(cStatus, 'active');

    // Durante o mês grátis: prepare_proposal_billing respeita a regra da Portaria Prime.
    await assert.rejects(db.rpc(sindico, 'prepare_proposal_billing', { p_tenant: T }), /mês grátis vai até/);
    assert.equal((await db.sql('select count(*)::int n from billing_orders where tenant_id = $1', [T]))[0].n, 0);
    // Assinatura continua trialing sem alteração.
    const subDuringTrial = (await db.sql('select * from subscriptions where tenant_id = $1', [T]))[0];
    assert.equal(subDuringTrial.status, 'trialing');
    assert.equal(subDuringTrial.price_cents_snapshot, 34900);

    // Fim do mês grátis: agora a cobrança é permitida com o snapshot da proposta.
    db.setNow('2026-11-25T12:00:00Z');
    const order = await db.rpc(sindico, 'prepare_proposal_billing', { p_tenant: T });
    assert.equal(order.amount_cents, 13000);
    assert.equal(order.description.includes('Profissional'), true);

    const [dbOrder] = await db.sql('select * from billing_orders where id = $1', [order.order_id]);
    assert.equal(dbOrder.amount_cents, 13000);
    assert.equal(dbOrder.snapshot.amount_cents, 13000);
    assert.equal(dbOrder.snapshot.plan_code, 'profissional');
    assert.equal(dbOrder.snapshot.limits.max_units, 400);
    assert.match(dbOrder.snapshot.content_sha256, /^[0-9a-f]{64}$/);
    // Divergência (valor, snapshot ou proposta de outro contrato) é rejeitada por qualquer caminho.
    await assert.rejects(db.service('update billing_orders set amount_cents = 1000 where id = $1', [order.order_id]), /Divergência/);
    await assert.rejects(db.service("update billing_orders set snapshot = snapshot || '{\"limits\":{\"max_units\":9999}}'::jsonb where id = $1", [order.order_id]), /Divergência/);
    // Repetir o checkout devolve o mesmo pedido (idempotente), sem duplicar.
    assert.equal((await db.rpc(sindico, 'prepare_proposal_billing', { p_tenant: T })).order_id, order.order_id);
    assert.equal((await db.sql('select count(*)::int n from billing_orders where tenant_id = $1', [T]))[0].n, 1);
    // Cliente sem proposta mantém o prepare_checkout original (catálogo).
    const other = await db.createUser('plain@com.invalid');
    const O = (await db.rpc(other, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Plain', p_slug: 'plain-cond',
      p_document: '11222333000181', p_timezone: 'America/Sao_Paulo', p_plan_code: 'essencial', p_cycle: 'monthly' })).tenant_id;
    await assert.rejects(db.rpc(other, 'prepare_proposal_billing', { p_tenant: O }), /mês grátis vai até/);
    await assert.rejects(db.rpc(other, 'prepare_proposal_billing', { p_tenant: T }), /faturamento/, 'sem permissão no outro condomínio');
    // Preço gerado para a proposta é privado (active = false no catálogo público).
    const [privPrice] = await db.sql('select * from plan_prices where id = $1', [dbOrder.price_id]);
    assert.equal(privPrice.active, false);

    // O serviço ainda NÃO mudou antes do pagamento verificado.
    const subBeforePay = (await db.sql('select * from subscriptions where tenant_id = $1', [T]))[0];
    assert.equal(subBeforePay.status, 'pending_payment');
    assert.equal(subBeforePay.price_cents_snapshot, 34900, 'ainda snapshot antigo');

    // Pagamento verificado aplica a proposta, congela limites e preserva período anterior.
    const paid = await db.service(
      'select public.apply_verified_payment($1,$2,$3,$4,$5,$6,$7,$8) as r',
      [order.order_nsu, 'trans-ponte-1', 'slug-ponte', 13000, 13000, 1, 'pix', 'https://receipt.invalid']
    ).then((rows) => rows[0].r);
    assert.equal(paid.result, 'activated');

    const subAfterPay = (await db.sql('select * from subscriptions where tenant_id = $1', [T]))[0];
    assert.equal(subAfterPay.status, 'active');
    assert.equal(subAfterPay.price_cents_snapshot, 13000);
    assert.equal(subAfterPay.previous_price_cents, null, 'teste gratuito não é período pago anterior');
    assert.equal(subAfterPay.trial_ends_at.toISOString(), baseSub.trial_ends_at.toISOString(), 'mês grátis preservado');

    // Limites refletem a proposta através de app.entitlements.
    const [ent] = await db.sql('select * from app.entitlements($1)', [T]);
    assert.equal(ent.max_units, 400);
  } finally { await db.raw.close(); }
});
