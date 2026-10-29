// Contratação eletrônica: publicação de documentos, aceite, verificação, aditivo,
// isolamento entre condomínios e separação aceite × pagamento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const CONTRATO = '# Contrato\n\n## 1. Partes\nContratada: {{RAZAO_SOCIAL}}, CNPJ {{CNPJ}}.\n\n## 2. Foro\n{{FORO}}.\n';
const LEGAL = { razao_social: 'Empresa Exemplo de Teste Ltda', cnpj: '11222333000181', endereco: 'Rua de Teste, 100, Cidade Exemplo',
  email_contato: 'contato@exemplo.invalid', canal_privacidade: 'privacidade@exemplo.invalid', encarregado: 'Pessoa Encarregada Teste',
  foro: 'Comarca de Teste', representante: 'Representante Teste', horario_suporte: 'Dias úteis, 9h às 18h (teste)', disponibilidade: 'Sem meta numérica (teste)' };
const svcCall = (db, fn, args) => db.service(`select public.${fn}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, Object.values(args)).then(r => r[0].r);

async function setup() {
  const db = await createDb();
  db.setNow('2026-10-23T12:00:00Z');
  await db.sql('update plans set published = true');
  const owner = await db.createUser('owner@legal.invalid');
  await db.sql("insert into platform_admins(user_id, role) values ($1, 'owner')", [owner]);
  const sindico = await db.createUser('sindico@a.invalid');
  const outro = await db.createUser('sindico@b.invalid');
  const prov = (uid, slug, doc) => db.rpc(uid, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `Cond ${slug}`, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'profissional', p_cycle: 'monthly' }).then(r => r.tenant_id);
  const A = await prov(sindico, 'cond-a', '11444777000161');
  const B = await prov(outro, 'cond-b', '11222333000181');
  return { db, owner, sindico, outro, A, B };
}

async function publish(s, content = CONTRATO, version = '1.0') {
  const d = await s.db.rpc(s.owner, 'platform_legal_doc_save', { p_id: null, p_kind: 'contrato_saas', p_version: version, p_content: content,
    p_summary: null, p_change_note: null, p_material: true });
  for (const to of ['review', 'approved', 'published']) await s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: to, p_note: null });
  return (await s.db.rpc(null, 'legal_document_current', { p_kind: 'contrato_saas' }));
}

const accept = (s, uid, sha, extra = {}) => svcCall(s.db, 'contract_accept', {
  p_actor: uid, p_tenant: s.A, p_document_sha256: sha, p_accepted: true, p_plan_code: 'profissional', p_cycle: 'monthly', p_proposal: null,
  p_contractor_name: 'Cond A', p_contractor_document: '11444777000161', p_rep_name: 'Síndica Teste', p_rep_cpf: null,
  p_rep_email: 'sindico@a.invalid', p_rep_phone: '11999990000', p_rep_role: 'Síndica', p_rep_authority: 'Eleita em assembleia (ata de teste)',
  p_ip: '203.0.113.7', p_user_agent: 'teste', ...extra });

test('publicação exige dados legais completos, aprovação e texto sem pendências; publicado é imutável', async () => {
  const s = await setup();
  try {
    assert.deepEqual((await s.db.rpc(s.owner, 'legal_entity_status')).complete, false, 'nada é semeado');
    const d = await s.db.rpc(s.owner, 'platform_legal_doc_save', { p_id: null, p_kind: 'contrato_saas', p_version: '1.0', p_content: CONTRATO,
      p_summary: null, p_change_note: null, p_material: true });
    await assert.rejects(s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: 'published', p_note: null }), /não permitida/);
    await s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: 'review', p_note: null });
    await s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: 'approved', p_note: null });
    await assert.rejects(s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: 'published', p_note: null }), /incompletos/);
    await assert.rejects(s.db.rpc(s.sindico, 'platform_legal_entity_set', { p: JSON.stringify(LEGAL) }), /restrito/);
    await s.db.rpc(s.owner, 'platform_legal_entity_set', { p: JSON.stringify(LEGAL) });
    // Trecho pendente no texto também bloqueia.
    const p2 = await s.db.rpc(s.owner, 'platform_legal_doc_save', { p_id: null, p_kind: 'termos', p_version: '1.0', p_content: 'Prazo: [PENDENTE DE DEFINIÇÃO] dias.',
      p_summary: null, p_change_note: null, p_material: true });
    for (const to of ['review', 'approved']) await s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: p2.id, p_to: to, p_note: null });
    await assert.rejects(s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: p2.id, p_to: 'published', p_note: null }), /pendentes/);
    await s.db.rpc(s.owner, 'platform_legal_doc_transition', { p_id: d.id, p_to: 'published', p_note: null });
    const cur = await s.db.rpc(null, 'legal_document_current', { p_kind: 'contrato_saas' });
    assert.match(cur.content_md, /Empresa Exemplo de Teste Ltda, CNPJ 11\.222\.333\/0001-81/);
    assert.doesNotMatch(cur.content_md, /\{\{/);
    await assert.rejects(s.db.service("update legal_documents set content_md = 'alterado depois' where id = $1", [d.id]), /imutável/);
    await assert.rejects(s.db.service('delete from legal_documents where id = $1', [d.id]), /não pode ser apagado/);
    await assert.rejects(s.db.as(s.sindico, 'select * from legal_documents'), /permission denied/);
    const audit = await s.db.sql("select action from audit_logs where action like 'legal.%' order by id");
    assert.ok(audit.some(a => a.action === 'legal.document_published'));
  } finally { await s.db.raw.close(); }
});

test('aceite: sha divergente, permissão, preço do servidor, isolamento, append-only, verificação, aditivo e pagamento intacto', async () => {
  const s = await setup();
  try {
    await s.db.rpc(s.owner, 'platform_legal_entity_set', { p: JSON.stringify(LEGAL) });
    const doc = await publish(s);
    const before = await s.db.sql('select status, price_cents_snapshot from subscriptions where tenant_id = $1', [s.A]);

    await assert.rejects(accept(s, s.sindico, 'a'.repeat(64)), /documento mudou/i);
    await assert.rejects(accept(s, s.sindico, doc.sha256, { p_accepted: false }), /Marque a caixa/);
    await assert.rejects(accept(s, s.outro, doc.sha256), /faturamento/, 'admin de outro condomínio não aceita');
    // Admin sem permissão billing.
    const semBilling = await s.db.createUser('admin2@a.invalid');
    const inv = await s.db.rpc(s.sindico, 'create_invitation', { p_tenant: s.A, p_email: 'admin2@a.invalid', p_role: 'admin', p_unit: null, p_permissions: '{settings}' });
    await s.db.rpc(semBilling, 'accept_invitation', { p_token: inv.token });
    await assert.rejects(accept(s, semBilling, doc.sha256), /faturamento/);
    await assert.rejects(s.db.rpc(semBilling, 'contract_quote', { p_tenant: s.A, p_plan_code: 'profissional', p_cycle: 'monthly', p_proposal: null }), /faturamento/);

    // Preço do catálogo, nunca do navegador; token de proposta inexistente é rejeitado.
    const q = await s.db.rpc(s.sindico, 'contract_quote', { p_tenant: s.A, p_plan_code: 'profissional', p_cycle: 'monthly', p_proposal: null });
    assert.equal(q.terms.amount_cents, 16900); assert.equal(q.terms.source, 'catalog'); assert.equal(q.document.sha256, doc.sha256);
    await assert.rejects(s.db.rpc(s.sindico, 'contract_quote', { p_tenant: s.A, p_plan_code: null, p_cycle: null, p_proposal: 'tok' }), /Proposta não encontrada/);

    const a1 = await accept(s, s.sindico, doc.sha256, { p_contractor_document: '11.444.777/0001-61' });
    assert.equal(a1.status, 'pending_verification');
    assert.equal(a1.terms.amount_cents, 16900);
    assert.equal(a1.document_sha256, doc.sha256);
    assert.equal(a1.ip, '203.0.113.7');

    // Sem verificação nada é enviado; e-mail não é "verificado" de mentira.
    await svcCall(s.db, 'complete_contract_pdf', { p_acceptance: a1.id, p_path: `${s.A}/contracts/${a1.id}/contrato-v1.pdf`, p_sha256: 'b'.repeat(64) });
    assert.equal((await s.db.sql("select count(*)::int n from notification_jobs where event = 'contract_copy'"))[0].n, 0);
    await assert.rejects(svcCall(s.db, 'contract_verify', { p_actor: s.sindico, p_acceptance: a1.id, p_code: '123456' }), /Nenhum código/);
    await svcCall(s.db, 'contract_set_code', { p_actor: s.sindico, p_acceptance: a1.id, p_code: '123456' });
    const [{ code_hash }] = await s.db.sql('select code_hash from app.contract_verifications where acceptance_id = $1', [a1.id]);
    assert.notEqual(code_hash, '123456', 'só hash');
    assert.equal((await svcCall(s.db, 'contract_verify', { p_actor: s.sindico, p_acceptance: a1.id, p_code: '000000' })).error, 'Código incorreto.');
    assert.equal((await svcCall(s.db, 'contract_verify', { p_actor: s.sindico, p_acceptance: a1.id, p_code: '123456' })).status, 'active');

    // Cópia só para o representante (e-mail); outro destinatário é barrado pela regra do outbox.
    const jobs = await s.db.sql("select channel, recipient from notification_jobs where event = 'contract_copy'");
    assert.deepEqual(jobs, [{ channel: 'email', recipient: 'sindico@a.invalid' }]);
    await s.db.sql("insert into notification_jobs(tenant_id, event, channel, recipient, ref_id) values ($1, 'contract_copy', 'email', 'intruso@x.invalid', $2)", [s.A, a1.id]);
    assert.equal((await s.db.sql("select count(*)::int n from notification_jobs where event = 'contract_copy'"))[0].n, 1);
    const [{ id: jobId }] = await s.db.sql("select id from notification_jobs where event = 'contract_copy'");
    const ctx = await svcCall(s.db, 'notification_context', { p_job: jobId });
    assert.equal(ctx.contract.id, a1.id); assert.equal(ctx.tenant_slug, 'cond-a', 'contexto anterior preservado');

    // Aceite não é pagamento.
    assert.deepEqual(await s.db.sql('select status, price_cents_snapshot from subscriptions where tenant_id = $1', [s.A]), before);
    assert.equal((await s.db.sql('select count(*)::int n from payments'))[0].n, 0);
    assert.equal((await s.db.sql('select count(*)::int n from billing_orders'))[0].n, 0);

    // Append-only.
    await assert.rejects(s.db.service("update contract_acceptances set representative_email = 'x@y.invalid' where id = $1", [a1.id]), /imutáveis/);
    await assert.rejects(s.db.service('delete from contract_acceptances where id = $1', [a1.id]), /permanente/);
    const again = await svcCall(s.db, 'complete_contract_pdf', { p_acceptance: a1.id, p_path: `${s.A}/contracts/${a1.id}/outro-arquivo.pdf`, p_sha256: 'c'.repeat(64) });
    assert.deepEqual([again.replayed, again.sha256], [true, 'b'.repeat(64)], 'PDF pronto não é trocado');
    await assert.rejects(s.db.service("update contract_acceptances set pdf_sha256 = $2 where id = $1", [a1.id, 'd'.repeat(64)]), /imutável/);
    await assert.rejects(s.db.as(s.sindico, "insert into contract_acceptances(tenant_id) values ($1)", [s.A]), /permission denied/);

    // Isolamento: outro condomínio e anon não veem.
    assert.equal((await s.db.as(s.sindico, 'select count(*)::int n from contract_acceptances'))[0].n, 1);
    assert.equal((await s.db.as(s.outro, 'select count(*)::int n from contract_acceptances'))[0].n, 0);
    await assert.rejects(s.db.as(null, 'select * from contract_acceptances'), /permission denied/);
    await assert.rejects(s.db.rpc(s.outro, 'contract_overview', { p_tenant: s.A }), /permissão/i);

    // Aditivo: nova versão material -> novo aceite ligado ao anterior.
    const doc2 = await publish(s, CONTRATO + '\n## 3. Novidade\nTexto novo.\n', '1.1');
    assert.equal((await s.db.rpc(s.sindico, 'contract_overview', { p_tenant: s.A })).needs_new_acceptance, true);
    await assert.rejects(accept(s, s.sindico, doc.sha256), /documento mudou/i);
    const a2 = await accept(s, s.sindico, doc2.sha256, { p_plan_code: 'prime' });
    assert.deepEqual([a2.kind, a2.previous_id, a2.terms.amount_cents], ['aditivo', a1.id, 36900]);
    await svcCall(s.db, 'contract_set_code', { p_actor: s.sindico, p_acceptance: a2.id, p_code: '654321' });
    await svcCall(s.db, 'contract_verify', { p_actor: s.sindico, p_acceptance: a2.id, p_code: '654321' });
    const rows = await s.db.sql('select id, status, superseded_by from contract_acceptances order by accepted_at, kind desc');
    assert.deepEqual(rows.map(r => r.status).sort(), ['active', 'superseded']);
    assert.equal(rows.find(r => r.id === a1.id).superseded_by, a2.id);

    // Cancelamento reutiliza cancel_subscription e lista efeitos.
    const c = await s.db.rpc(s.sindico, 'contract_cancel', { p_tenant: s.A, p_confirm: true, p_reason: null });
    assert.equal(c.canceled, true); assert.ok(c.effects.length >= 4);
    assert.equal((await s.db.sql('select cancel_at_period_end from subscriptions where tenant_id = $1', [s.A]))[0].cancel_at_period_end, true);
    assert.equal((await s.db.rpc(s.sindico, 'contract_overview', { p_tenant: s.A })).state, 'ending');

    // Admin Master vê evidências mascaradas.
    const list = await s.db.rpc(s.owner, 'platform_contract_acceptances', { p_tenant: null });
    assert.equal(list.length, 2); assert.doesNotMatch(JSON.stringify(list), /sindico@a\.invalid|203\.0\.113\.7/);
    // Consentimento do teste grava a versão vigente (ou a minuta não vigente).
    assert.deepEqual(await s.db.rpc(s.sindico, 'record_trial_consent', { p_tenant: s.A }), { termos: 'minuta-nao-vigente', privacidade: 'minuta-nao-vigente' });
  } finally { await s.db.raw.close(); }
});
