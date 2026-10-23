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
  } finally { await db.raw.close(); }
});
