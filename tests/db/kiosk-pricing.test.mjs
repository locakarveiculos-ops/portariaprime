// 20261029000200: Modo Portaria Exclusiva incluído; mensal + R$ 20 só para novas contratações,
// trimestral/anual pela política existente (-5%/-15%, arredondado para baixo ao real).
// Assinaturas, renovações e aceites de quem já contratou mantêm o valor; Admin Master vê o pedido piloto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const MIG = '20261029000200_kiosk_pilot_pricing.sql';
const OLD = { essencial: 9900, profissional: 14900, prime: 34900 };
const expected = (m) => ({ monthly: m, quarterly: Math.floor(m * 3 * 0.95 / 100) * 100, yearly: Math.floor(m * 12 * 0.85 / 100) * 100 });
const active = async (db) => Object.fromEntries((await db.sql(`select p.code || ':' || pp.cycle k, pp.amount_cents v from plans p
  join plan_prices pp on pp.plan_id = p.id where pp.active and not p.is_custom`)).map((r) => [r.k, r.v]));

test('nova tabela: +R$ 20 no mensal, ciclos pela política, versões antigas preservadas, idempotente', async () => {
  const db = await createDb({ before: MIG });
  try {
    const before = await active(db);
    for (const [code, m] of Object.entries(OLD)) assert.equal(before[`${code}:monthly`], m, `${code} mensal antes`);
    const versions = (await db.sql('select count(*)::int n from plan_prices'))[0].n;
    await db.applyMigration(MIG);
    const after = await active(db);
    for (const [code, m] of Object.entries(OLD)) {
      const e = expected(m + 2000);
      assert.deepEqual([after[`${code}:monthly`], after[`${code}:quarterly`], after[`${code}:yearly`]], [e.monthly, e.quarterly, e.yearly], code);
    }
    assert.deepEqual([after['essencial:quarterly'], after['essencial:yearly'], after['profissional:quarterly'], after['profissional:yearly'], after['prime:quarterly'], after['prime:yearly']],
      [33900, 121300, 48100, 172300, 105100, 376300]);
    assert.equal((await db.sql('select count(*)::int n from plan_prices'))[0].n, versions + 9, '9 versões novas, antigas mantidas');
    const [{ n }] = await db.sql('select count(*)::int n from (select plan_id, cycle from plan_prices where active group by 1, 2 having count(*) > 1) x');
    assert.equal(n, 0, 'um preço ativo por plano/ciclo');
    assert.ok((await db.sql("select 1 from plan_prices pp join plans p on p.id = pp.plan_id where p.code = 'profissional' and pp.cycle = 'monthly' and pp.amount_cents = 14900 and not pp.active")).length === 1);
    await db.applyMigration(MIG);
    assert.equal((await db.sql('select count(*)::int n from plan_prices'))[0].n, versions + 9, 'reaplicar não cria versões');
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action = 'commercial.kiosk_pilot_pricing'"))[0].n, 3);
    // Plano sob medida continua sem preço de catálogo.
    assert.equal((await db.sql("select count(*)::int n from plan_prices pp join plans p on p.id = pp.plan_id where p.is_custom"))[0].n, 0);
  } finally { await db.raw.close(); }
});

test('quem já contratou mantém valor no teste, na renovação e no aceite; novo contrato usa a tabela nova', async () => {
  const db = await createDb({ before: MIG });
  try {
    await db.sql('update plans set published = true');
    db.setNow('2026-01-01T12:00:00Z');
    const paidAdmin = await db.createUser('pago@kiosk.invalid');
    const trialAdmin = await db.createUser('teste@kiosk.invalid');
    const prov = (u, slug, doc, plan, cycle) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: slug, p_slug: slug,
      p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: plan, p_cycle: cycle }).then((r) => r.tenant_id);
    const P = await prov(paidAdmin, 'cond-pago', '11444777000161', 'profissional', 'monthly');
    // Assinatura paga antes da nova tabela.
    db.setNow('2026-02-02T12:00:00Z');
    await db.service('select public.billing_tick()');
    const [first] = await db.sql("select * from billing_orders where tenant_id = $1 and status = 'pending'", [P]);
    assert.equal(first.amount_cents, 14900);
    const paid = (await db.service("select public.apply_verified_payment($1,'tx-k1','s',$2,$2,1,'pix',null) r", [first.order_nsu, 14900]))[0].r;
    assert.equal(paid.result, 'activated');
    db.setNow('2026-01-01T12:00:00Z');
    const T = await prov(trialAdmin, 'cond-teste', '11222333000181', 'essencial', 'yearly');
    const trialBefore = (await db.sql('select trial_ends_at, price_cents_snapshot from subscriptions where tenant_id = $1', [T]))[0];
    assert.equal(trialBefore.price_cents_snapshot, 100900);

    await db.applyMigration(MIG);

    // Mês grátis e snapshot preservados.
    const trialAfter = (await db.sql('select trial_ends_at, price_cents_snapshot from subscriptions where tenant_id = $1', [T]))[0];
    assert.deepEqual(trialAfter, trialBefore);
    // Renovação de quem já pagou: checkout liberado e no valor contratado (versão antiga, inativa).
    db.setNow('2026-02-26T12:00:00Z');
    const renewal = await db.rpc(paidAdmin, 'prepare_checkout', { p_tenant: P });
    assert.equal(renewal.amount_cents, 14900);
    // Fim do teste: primeira cobrança no valor aceito no cadastro.
    db.setNow('2026-02-02T12:00:00Z');
    const firstTrial = await db.rpc(trialAdmin, 'prepare_checkout', { p_tenant: T });
    assert.equal(firstTrial.amount_cents, 100900);

    // Aceite do mesmo plano/ciclo mantém o valor; outro ciclo usa a tabela nova.
    const same = await db.rpc(paidAdmin, 'contract_quote', { p_tenant: P, p_plan_code: 'profissional', p_cycle: 'monthly', p_proposal: null });
    assert.deepEqual([same.terms.amount_cents, same.terms.price_kept], [14900, true]);
    const other = await db.rpc(paidAdmin, 'contract_quote', { p_tenant: P, p_plan_code: 'profissional', p_cycle: 'yearly', p_proposal: null });
    assert.deepEqual([other.terms.amount_cents, other.terms.price_kept], [172300, false]);

    // Novo condomínio já nasce na tabela nova.
    const novo = await db.createUser('novo@kiosk.invalid');
    db.setNow('2026-03-01T12:00:00Z');
    const N = await prov(novo, 'cond-novo', '45723174000110', 'profissional', 'monthly');
    assert.equal((await db.sql('select price_cents_snapshot from subscriptions where tenant_id = $1', [N]))[0].price_cents_snapshot, 16900);
    // Plano despublicado continua bloqueando checkout novo (regra anterior mantida).
    await db.sql("update plans set published = false where code = 'essencial'");
    await db.sql("update billing_orders set status = 'canceled' where tenant_id = $1", [T]);
    await assert.rejects(db.rpc(trialAdmin, 'prepare_checkout', { p_tenant: T }), /disponível/);
  } finally { await db.raw.close(); }
});

test('pedido de ativação piloto: só superadmin lê; detalhes técnicos visíveis, contato mascarado', async () => {
  const db = await createDb();
  try {
    const owner = await db.createUser('owner@kiosk.invalid');
    const user = await db.createUser('sindico@kiosk.invalid');
    await db.sql("insert into platform_admins(user_id, role) values ($1, 'owner')", [owner]);
    await db.sql(`insert into contact_requests(name, email, phone, message, source) values
      ('Síndica Piloto', 'piloto@cond.invalid', '11988887777', 'Solicitação de ativação piloto PQ-1\nAparelho: Samsung Galaxy Tab A9 · Android 14 · 1 aparelho(s).', 'quiosque:piloto'),
      ('Outro', 'outro@cond.invalid', null, 'Mensagem privada da landing', 'landing')`);
    const list = await db.rpc(owner, 'platform_list', { p_section: 'contacts' });
    const pilot = list.rows.find((r) => r.source === 'quiosque:piloto');
    assert.match(pilot.message, /Samsung Galaxy Tab A9 · Android 14/);
    assert.equal(pilot.status, 'novo');
    assert.doesNotMatch(JSON.stringify(list), /piloto@cond\.invalid|11988887777|Mensagem privada/);
    await assert.rejects(db.rpc(user, 'platform_list', { p_section: 'contacts' }));
    await assert.rejects(db.as(null, 'select * from contact_requests'), /permission denied/);
    assert.equal((await db.as(user, 'select count(*)::int n from contact_requests'))[0].n, 0);
  } finally { await db.raw.close(); }
});

test('pedidos piloto: papéis do Admin Master leem, só contact_status muda status; contato completo só por consulta auditada com MFA', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const ids = {};
    for (const r of ['owner', 'support', 'finance', 'auditor']) {
      ids[r] = await db.createUser(`${r}@plat.invalid`);
      await db.sql('insert into platform_admins(user_id, role) values ($1, $2)', [ids[r], r]);
    }
    const sindico = await db.createUser('sindico@cond.invalid');
    const comum = await db.createUser('comum@x.invalid');
    await db.rpc(sindico, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond', p_slug: 'cond-piloto',
      p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'essencial', p_cycle: 'monthly' });
    const [{ id }] = await db.sql(`insert into contact_requests(name, email, phone, message, source) values ('Síndica Piloto', 'piloto@cond.invalid',
      '11988887777', 'Solicitação de ativação piloto PQ-20261029-ABC123 — Modo Portaria Exclusiva.\nCondomínio: Cond.\nAparelho: Samsung Galaxy Tab A9 · Android 14 · 1 aparelho(s).', 'quiosque:piloto') returning id`);

    // Leitura: anon, usuário comum e síndico não leem a tabela nem a lista; os 4 papéis leem pela lista (mascarada).
    await assert.rejects(db.as(null, 'select * from contact_requests'), /permission denied/);
    for (const u of [comum, sindico]) {
      assert.equal((await db.as(u, 'select count(*)::int n from contact_requests'))[0].n, 0);
      await assert.rejects(db.rpc(u, 'platform_list', { p_section: 'contacts' }), /restrito/);
      await assert.rejects(db.rpc(u, 'platform_contact_reveal', { p_id: id, p_reason: 'Retorno ao solicitante piloto' }), /restrito/);
    }
    for (const r of ['owner', 'support', 'finance', 'auditor']) {
      const list = await db.rpc(ids[r], 'platform_list', { p_section: 'contacts' });
      assert.equal(list.rows[0].status, 'novo', r);
      assert.match(list.rows[0].message, /PQ-20261029-ABC123/);
      assert.doesNotMatch(JSON.stringify(list), /piloto@cond\.invalid|11988887777/, r);
    }

    // Status: só quem tem contact_status (owner, support, finance); auditor não.
    const act = (u, status) => db.rpc(u, 'platform_action', { p_action: 'contact_status', p_target: id, p_reason: 'Contato iniciado com a síndica',
      p_data: JSON.stringify({ status }), p_request: crypto.randomUUID() });
    await assert.rejects(act(ids.auditor, 'resolvido'), /restrito/);
    await assert.rejects(act(sindico, 'resolvido'), /restrito/);
    for (const r of ['support', 'finance', 'owner']) assert.equal((await act(ids[r], 'em_atendimento')).ok, true, r);
    const [row] = await db.sql('select status, handled_by from contact_requests where id = $1', [id]);
    assert.deepEqual([row.status, row.handled_by], ['em_atendimento', ids.owner]);

    // Contato completo: quem atende (contact_status) com justificativa; auditor não; cada consulta auditada sem o dado.
    await assert.rejects(db.rpc(ids.auditor, 'platform_contact_reveal', { p_id: id, p_reason: 'Retorno ao solicitante piloto' }), /restrito/);
    await assert.rejects(db.rpc(ids.support, 'platform_contact_reveal', { p_id: id, p_reason: 'curto' }), /Justificativa/);
    await assert.rejects(db.rpc(ids.support, 'platform_contact_reveal', { p_id: crypto.randomUUID(), p_reason: 'Retorno ao solicitante piloto' }), /não encontrado/);
    const c = await db.rpc(ids.support, 'platform_contact_reveal', { p_id: id, p_reason: 'Retorno ao solicitante piloto' });
    assert.deepEqual([c.email, c.phone], ['piloto@cond.invalid', '11988887777']);
    const audit = await db.sql("select actor_id, target_id, data from audit_logs where action = 'platform.contact_reveal'");
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].actor_id, audit[0].target_id, audit[0].data.reason, audit[0].data.source], [ids.support, id, 'Retorno ao solicitante piloto', 'quiosque:piloto']);
    assert.doesNotMatch(JSON.stringify(audit), /piloto@cond\.invalid|11988887777/, 'auditoria não guarda o dado revelado');
    // Aparece na trilha do Admin Master.
    assert.ok((await db.rpc(ids.owner, 'platform_list', { p_section: 'audit' })).rows.some((r) => r.action === 'platform.contact_reveal'));

    // MFA: com fator verificado, exige aal2 (mesma regra de app.platform_require).
    await db.raw.exec('create table auth.mfa_factors (user_id uuid, status text)');
    await db.sql("insert into auth.mfa_factors values ($1, 'verified')", [ids.finance]);
    const withAal = async (aal) => {
      await db.raw.exec('begin');
      try {
        await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [ids.finance, JSON.stringify({ sub: ids.finance, aal })]);
        await db.raw.exec('set local role authenticated');
        const r = await db.raw.query('select public.platform_contact_reveal($1, $2) r', [id, 'Retorno ao solicitante piloto']);
        await db.raw.exec('commit');
        return r.rows[0].r;
      } catch (e) { await db.raw.exec('rollback'); throw e; }
    };
    await assert.rejects(withAal('aal1'), /Confirme o MFA/);
    assert.equal((await withAal('aal2')).email, 'piloto@cond.invalid');
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action = 'platform.contact_reveal'"))[0].n, 2, 'recusa por MFA não grava consulta');
  } finally { await db.raw.close(); }
});
