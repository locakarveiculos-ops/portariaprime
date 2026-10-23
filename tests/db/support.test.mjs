// Suporte com protocolo: abertura só pela equipe, isolamento, nota interna, aviso a quem abriu e métricas reais.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const provision = (db, uid, slug, doc) => db.rpc(uid, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: slug, p_slug: slug,
  p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);

test('chamados de suporte: protocolo, permissões, conversa, avisos e métricas', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    db.setNow('2026-03-10T12:00:00Z');
    const admin = await db.createUser('sindico@sup.invalid', { name: 'Síndica' });
    const port = await db.createUser('porteiro@sup.invalid');
    const port2 = await db.createUser('porteiro2@sup.invalid');
    const resident = await db.createUser('morador@sup.invalid');
    const other = await db.createUser('outro@sup.invalid');
    const agent = await db.createUser('agente@sup.invalid');
    const auditor = await db.createUser('auditor@sup.invalid');
    await db.sql("insert into platform_admins(user_id, role) values ($1, 'support'), ($2, 'auditor')", [agent, auditor]);
    const T = await provision(db, admin, 'sup-cond', '11444777000161');
    const O = await provision(db, other, 'sup-outro', '11222333000181');
    for (const [uid, email] of [[port, 'porteiro@sup.invalid'], [port2, 'porteiro2@sup.invalid']]) {
      const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: email, p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
      await db.rpc(uid, 'accept_invitation', { p_token: inv.token });
    }
    const [{ id: unit }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'101') returning id", [T]);
    const invR = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: 'morador@sup.invalid', p_role: 'morador', p_unit: unit, p_permissions: '{}' });
    await db.rpc(resident, 'accept_invitation', { p_token: invR.token });

    const open = (uid, tenant, extra = {}) => db.rpc(uid, 'support_open', { p_tenant: tenant, p_kind: 'operacional', p_subject: 'Leitor de QR falha',
      p_category: 'encomendas', p_body: 'A câmera não abre na tela de entrega.', p_priority: 'normal', p_route: '/c/sup-cond/portaria', p_app_version: '1.4.2', ...extra });

    // Protocolo legível, único e sequencial por ano.
    const a = await open(port, T);
    const b = await open(admin, T, { p_subject: 'Dúvida sobre cobrança', p_kind: 'comercial', p_category: 'cobranca' });
    const c = await open(other, O);
    assert.deepEqual([a.protocol, b.protocol, c.protocol], ['SUP-2026-000001', 'SUP-2026-000002', 'SUP-2026-000003']);
    db.setNow('2027-01-02T12:00:00Z');
    assert.equal((await open(other, O)).protocol, 'SUP-2027-000001', 'sequência reinicia no ano novo');
    db.setNow('2026-03-10T12:00:00Z');

    // Contexto seguro: rota com query/hash ou versão estranha não é gravada.
    const d = await open(admin, T, { p_route: '/c/sup-cond/portaria?email=x@y.z', p_app_version: '<script>' });
    const [ctx] = await db.sql('select ctx_route, ctx_app_version from support_tickets where id=$1', [d.id]);
    assert.deepEqual(ctx, { ctx_route: null, ctx_app_version: null });

    // Morador não abre (fala com a portaria); urgência só pela plataforma; sem login não chama.
    await assert.rejects(open(resident, T), /Moradores falam com a portaria/);
    await assert.rejects(open(admin, T, { p_priority: 'urgente' }), /Urgência/);
    await assert.rejects(open(null, T), /permission denied|permissão/i);
    await assert.rejects(open(other, T), /Somente a equipe/);

    // Isolamento: outro condomínio e morador não leem; porteiro vê só os que abriu; admin vê todos do condomínio.
    await assert.rejects(db.rpc(other, 'support_ticket', { p_ticket: a.id }), /permissão/i);
    await assert.rejects(db.rpc(resident, 'support_ticket', { p_ticket: a.id }), /permissão/i);
    await assert.rejects(db.rpc(resident, 'support_my_tickets', { p_tenant: T }), /permissão/i);
    await assert.rejects(db.rpc(port2, 'support_ticket', { p_ticket: a.id }), /permissão/i);
    assert.deepEqual((await db.rpc(port, 'support_my_tickets', { p_tenant: T })).map((t) => t.protocol), ['SUP-2026-000001']);
    assert.equal((await db.rpc(admin, 'support_my_tickets', { p_tenant: T })).length, 3);
    assert.equal((await db.rpc(other, 'support_my_tickets', { p_tenant: O })).length, 2);
    await assert.rejects(db.as(admin, 'select * from support_tickets'), /permission denied/);
    await assert.rejects(db.as(admin, 'select * from support_messages'), /permission denied/);

    // Plataforma: auditor lê mas não age; sem capacidade não lê.
    assert.equal((await db.rpc(auditor, 'support_admin_list', {})).total, 5);
    await assert.rejects(db.rpc(auditor, 'support_admin_reply', { p_ticket: a.id, p_body: 'Oi' }), /restrito/);
    await assert.rejects(db.rpc(admin, 'support_admin_list', {}), /restrito/);

    // Nota interna invisível ao cliente e sem aviso; resposta pública avisa só quem abriu.
    db.setNow('2026-03-10T14:30:00Z');
    await db.rpc(agent, 'support_admin_assign', { p_ticket: a.id });
    await db.rpc(agent, 'support_admin_reply', { p_ticket: a.id, p_body: 'Nota: cliente usa tablet antigo.', p_internal: true });
    let view = await db.rpc(port, 'support_ticket', { p_ticket: a.id });
    assert.equal(view.messages.length, 1);
    assert.ok(!JSON.stringify(view).includes('tablet antigo'));
    assert.equal(view.first_response_at, null, 'nota interna não conta como primeira resposta');
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='support_reply'"))[0].n, 0);
    await db.rpc(agent, 'support_admin_reply', { p_ticket: a.id, p_body: 'Libere a câmera nas configurações do navegador.' });
    view = await db.rpc(port, 'support_ticket', { p_ticket: a.id });
    assert.equal(view.messages.length, 2);
    assert.equal(view.status, 'aguardando_cliente');
    assert.equal(view.messages[1].author, 'Equipe Portaria Prime');
    const jobs = await db.sql("select channel, recipient, ref_id from notification_jobs where event='support_reply' order by channel");
    assert.deepEqual(jobs.map((j) => [j.channel, j.recipient]), [['email', 'porteiro@sup.invalid'], ['push', port]]);
    assert.ok(jobs.every((j) => j.ref_id.startsWith(`${a.id}:`)));
    assert.equal((await db.rpc(agent, 'support_admin_ticket', { p_ticket: a.id })).messages.filter((m) => m.internal).length, 1);

    // Regra do outbox: support_reply para outra pessoa é descartado pela guarda.
    await db.service("insert into notification_jobs(tenant_id,event,channel,recipient,ref_id) values($1,'support_reply','email','sindico@sup.invalid',$2)", [T, `${a.id}:x`]);
    assert.equal((await db.sql("select count(*)::int n from notification_jobs where event='support_reply' and recipient='sindico@sup.invalid'"))[0].n, 0);
    // Contexto do template: só protocolo (sem conteúdo da conversa).
    const [{ id: jobId }] = await db.sql("select id from notification_jobs where event='support_reply' and channel='email'");
    const [{ r: nctx }] = await db.service('select public.notification_context($1) r', [jobId]);
    assert.equal(nctx.support.protocol, 'SUP-2026-000001');
    assert.equal(nctx.tenant_slug, 'sup-cond');
    assert.ok(!JSON.stringify(nctx).includes('câmera'));

    // Cliente responde (volta para "aberto"), plataforma resolve, cliente encerra; encerrado não aceita resposta.
    db.setNow('2026-03-11T12:00:00Z');
    await db.rpc(port, 'support_reply', { p_ticket: a.id, p_body: 'Funcionou, obrigado.' });
    assert.equal((await db.rpc(port, 'support_ticket', { p_ticket: a.id })).status, 'aberto');
    await db.rpc(agent, 'support_admin_set', { p_ticket: a.id, p_status: 'resolvido', p_priority: 'urgente' });
    await db.rpc(port, 'support_close', { p_ticket: a.id });
    await assert.rejects(db.rpc(port, 'support_reply', { p_ticket: a.id, p_body: 'Mais uma coisa' }), /encerrado/);
    await assert.rejects(db.as(agent, 'update support_messages set body = $1', ['x']), /permission denied/);
    await assert.rejects(db.service('update support_messages set body = $1', ['x']), /append-only/);

    // Métricas reais: 1ª resposta de 2,5 h (12:00 -> 14:30); resolução de 24 h; por tema.
    const m = await db.rpc(agent, 'support_metrics', { p_from: '2026-03-01', p_to: '2026-03-31' });
    assert.equal(m.opened, 4);
    assert.deepEqual(m.first_response, { n: 1, pending: 3, avg_h: 2.5, median_h: 2.5 });
    assert.deepEqual(m.resolution, { n: 1, avg_h: 24, median_h: 24 });
    assert.deepEqual(m.by_category.map((x) => [x.category, x.n]), [['encomendas', 3], ['cobranca', 1]]);
    assert.deepEqual(m.by_kind, { operacional: 3, comercial: 1 });
    const empty = await db.rpc(agent, 'support_metrics', { p_from: '2025-01-01', p_to: '2025-01-31' });
    assert.deepEqual([empty.opened, empty.first_response.avg_h, empty.resolution.median_h], [0, null, null]);

    // Configuração: sem cadastro = null; prazo só aparece ao cliente se aprovado.
    assert.equal(await db.rpc(admin, 'support_settings_get'), null);
    await assert.rejects(db.rpc(auditor, 'support_settings_save', { p_hours: 'x', p_channels: 'y', p_first_response_target: '4 h', p_approved: false }), /restrito/);
    await db.rpc(agent, 'support_settings_save', { p_hours: 'Seg. a sex., 9h às 18h', p_channels: 'Chamado no app', p_first_response_target: 'Até 4 horas úteis', p_approved: false });
    let s = await db.rpc(admin, 'support_settings_get');
    assert.equal(s.hours, 'Seg. a sex., 9h às 18h'); assert.equal(s.first_response_target, null);
    await db.rpc(agent, 'support_settings_save', { p_hours: 'Seg. a sex., 9h às 18h', p_channels: 'Chamado no app', p_first_response_target: 'Até 4 horas úteis', p_approved: true });
    s = await db.rpc(admin, 'support_settings_get');
    assert.equal(s.first_response_target, 'Até 4 horas úteis');

    // Auditoria sem conteúdo da mensagem.
    const audit = await db.sql("select data from audit_logs where action like 'support.%'");
    assert.ok(audit.length >= 5);
    assert.ok(!JSON.stringify(audit).includes('câmera'));
  } finally { await db.raw.close(); }
});
