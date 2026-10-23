// Administradoras: vínculo só com aprovação do síndico, isolamento entre carteiras, revogação imediata,
// convites de uso único, carteira só com agregados e dashboard_operation ainda restrito ao admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const provision = (db, uid, slug, doc) => db.rpc(uid, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: slug, p_slug: slug,
  p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);

test('administradoras e carteira de condomínios', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    db.setNow('2026-03-10T15:00:00Z');
    const sindico = await db.createUser('sindico@org.invalid');
    const sindico2 = await db.createUser('sindico2@org.invalid');
    const port = await db.createUser('porteiro@org.invalid');
    const adminNoSettings = await db.createUser('adm@org.invalid');
    const orgAdmin = await db.createUser('gestor@adm.invalid');
    const viewer = await db.createUser('analista@adm.invalid');
    const rival = await db.createUser('rival@outra.invalid');
    const owner = await db.createUser('owner@plat.invalid');
    const auditor = await db.createUser('auditor@plat.invalid');
    await db.sql("insert into platform_admins(user_id, role) values ($1, 'owner'), ($2, 'auditor')", [owner, auditor]);
    const T = await provision(db, sindico, 'org-cond-a', '11444777000161');
    const T2 = await provision(db, sindico2, 'org-cond-b', '11222333000181');
    const inv = await db.rpc(sindico, 'create_invitation', { p_tenant: T, p_email: 'porteiro@org.invalid', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
    await db.rpc(port, 'accept_invitation', { p_token: inv.token });
    const inv2 = await db.rpc(sindico, 'create_invitation', { p_tenant: T, p_email: 'adm@org.invalid', p_role: 'admin', p_unit: null, p_permissions: '{approve}' });
    await db.rpc(adminNoSettings, 'accept_invitation', { p_token: inv2.token });

    // Dados conhecidos: 2 aguardando (1 acima de 72 h), local com capacidade 4.
    const [{ id: unit }] = await db.as(sindico, "insert into units(tenant_id,label) values($1,'101') returning id", [T]);
    const [{ id: conc }] = await db.sql('select id from concierge_locations where tenant_id=$1', [T]);
    const [{ id: loc }] = await db.sql("insert into storage_locations(tenant_id,concierge_location_id,code,capacity) values($1,$2,'A1',4) returning id", [T, conc]);
    for (const at of ['2026-03-10T12:00:00Z', '2026-03-05T12:00:00Z']) {
      await db.service(`insert into packages(tenant_id,unit_id,status,carrier,idempotency_key,received_at,storage_location_id,recipient_name)
        values($1,$2,'ARMAZENADA','Correios',$3,$4,$5,'Maria Moradora')`, [T, unit, crypto.randomUUID(), at, loc]);
    }

    // Administradora criada por usuário comum (não é superadmin da plataforma).
    const { id: org } = await db.rpc(orgAdmin, 'org_create', { p_name: 'Administradora Alfa', p_document: '11.444.777/0001-61' });
    const { id: org2 } = await db.rpc(rival, 'org_create', { p_name: 'Administradora Beta', p_document: null });
    assert.equal((await db.as(orgAdmin, 'select app.is_platform_admin() ok'))[0].ok, false);
    await assert.rejects(db.as(orgAdmin, 'select * from organizations'), /permission denied/);

    // Pedido de vínculo: pendente não dá acesso.
    const link = await db.rpc(orgAdmin, 'org_request_link', { p_org: org, p_slug: 'org-cond-a' });
    assert.equal(link.status, 'pending');
    assert.deepEqual(await db.rpc(orgAdmin, 'org_portfolio', { p_org: org }), []);
    await assert.rejects(db.rpc(orgAdmin, 'org_tenant_overview', { p_org: org, p_tenant: T }), /vínculo ativo/);
    assert.equal((await db.as(orgAdmin, 'select app.org_can_view($1) ok', [T]))[0].ok, false);

    // Só admin com "settings" do próprio condomínio decide; porteiro, admin sem settings e síndico de outro não.
    await assert.rejects(db.rpc(port, 'tenant_org_decide', { p_link: link.id, p_decision: 'approve' }), /permissão/i);
    await assert.rejects(db.rpc(adminNoSettings, 'tenant_org_decide', { p_link: link.id, p_decision: 'approve' }), /permissão/i);
    await assert.rejects(db.rpc(sindico2, 'tenant_org_decide', { p_link: link.id, p_decision: 'approve' }), /permissão/i);
    await assert.rejects(db.rpc(orgAdmin, 'tenant_org_decide', { p_link: link.id, p_decision: 'approve' }), /permissão/i);
    const pend = await db.rpc(sindico, 'tenant_org_links', { p_tenant: T });
    assert.deepEqual(pend.map((l) => [l.org_name, l.status]), [['Administradora Alfa', 'pending']]);
    await db.rpc(sindico, 'tenant_org_decide', { p_link: link.id, p_decision: 'approve' });

    // Carteira: somente agregados.
    const pf = await db.rpc(orgAdmin, 'org_portfolio', { p_org: org });
    assert.equal(pf.length, 1);
    assert.equal(pf[0].waiting_now, 2);
    assert.equal(pf[0].stale_now, 1);
    assert.deepEqual(pf[0].occupancy, { used: 2, capacity: 4 });
    assert.equal(pf[0].notification_failures, 0);
    assert.equal(pf[0].commercial_state, 'full');
    const ov = await db.rpc(orgAdmin, 'org_tenant_overview', { p_org: org, p_tenant: T });
    assert.equal(ov.units_active, 1);
    assert.deepEqual(ov.locations, [{ code: 'A1', capacity: 4, used: 2, is_contingency: false }]);
    const dump = JSON.stringify([pf, ov]);
    assert.doesNotMatch(dump, /Maria|Moradora|recent|signature|photo|"unit"|"label"|recipient|email|carrier|tracking/i);

    // Outra carteira não vê; drill-down em condomínio sem vínculo falha.
    assert.deepEqual(await db.rpc(rival, 'org_portfolio', { p_org: org2 }), []);
    await assert.rejects(db.rpc(rival, 'org_portfolio', { p_org: org }), /não faz parte/);
    await assert.rejects(db.rpc(rival, 'org_tenant_overview', { p_org: org2, p_tenant: T }), /vínculo ativo/);
    await assert.rejects(db.rpc(orgAdmin, 'org_tenant_overview', { p_org: org, p_tenant: T2 }), /vínculo ativo/);

    // dashboard_operation continua exigindo admin do condomínio (a administradora não ganha acesso).
    await assert.rejects(db.rpc(orgAdmin, 'dashboard_operation', { p_tenant: T }), /permissão/i);
    await assert.rejects(db.rpc(port, 'dashboard_operation', { p_tenant: T }), /permissão/i);
    assert.equal((await db.rpc(sindico, 'dashboard_operation', { p_tenant: T })).waiting_now, 2);
    await assert.rejects(db.as(orgAdmin, 'select app.dashboard_operation_core($1)', [T]), /permission denied/);
    // Porteiro e morador nada ganham com o vínculo.
    await assert.rejects(db.rpc(port, 'org_portfolio', { p_org: org }), /não faz parte/);
    await assert.rejects(db.rpc(port, 'tenant_org_links', { p_tenant: T }), /permissão/i);

    // Convite: uso único, e-mail certo, expiração.
    const ci = await db.rpc(orgAdmin, 'org_invite', { p_org: org, p_email: 'analista@adm.invalid', p_role: 'org_viewer' });
    assert.equal((await db.rpc(null, 'org_invitation_preview', { p_token: ci.token })).valid, true);
    await assert.rejects(db.rpc(rival, 'org_accept_invitation', { p_token: ci.token }), /outro e-mail/);
    await db.rpc(viewer, 'org_accept_invitation', { p_token: ci.token });
    await assert.rejects(db.rpc(viewer, 'org_accept_invitation', { p_token: ci.token }), /já foi utilizado/);
    assert.equal((await db.rpc(viewer, 'org_portfolio', { p_org: org })).length, 1);
    await assert.rejects(db.rpc(viewer, 'org_invite', { p_org: org, p_email: 'x@y.invalid', p_role: 'org_admin' }), /Somente administradores/);
    await assert.rejects(db.rpc(viewer, 'org_request_link', { p_org: org, p_slug: 'org-cond-b' }), /Somente administradores/);
    const [{ n: hashOnly }] = await db.sql('select count(*)::int n from organization_invitations where token_hash = $1', [ci.token]);
    assert.equal(hashOnly, 0, 'token cru nunca é guardado');
    const expired = await db.rpc(orgAdmin, 'org_invite', { p_org: org, p_email: 'rival@outra.invalid', p_role: 'org_viewer' });
    db.setNow('2026-03-18T15:00:01Z');
    assert.equal((await db.rpc(null, 'org_invitation_preview', { p_token: expired.token })).valid, false);
    await assert.rejects(db.rpc(rival, 'org_accept_invitation', { p_token: expired.token }), /expirado/);
    db.setNow('2026-03-10T16:00:00Z');
    await assert.rejects(db.rpc(viewer, 'org_accept_invitation', { p_token: 'invalido' }), /inválido/);

    // Revogação imediata do membro.
    await db.rpc(orgAdmin, 'org_set_member_status', { p_org: org, p_user: viewer, p_status: 'revoked' });
    await assert.rejects(db.rpc(viewer, 'org_portfolio', { p_org: org }), /não faz parte/);
    await assert.rejects(db.rpc(orgAdmin, 'org_set_member_status', { p_org: org, p_user: orgAdmin, p_status: 'revoked' }), /pelo menos um administrador/);

    // Revogação imediata do vínculo pelo síndico.
    await db.rpc(sindico, 'tenant_org_decide', { p_link: link.id, p_decision: 'revoke' });
    assert.deepEqual(await db.rpc(orgAdmin, 'org_portfolio', { p_org: org }), []);
    await assert.rejects(db.rpc(orgAdmin, 'org_tenant_overview', { p_org: org, p_tenant: T }), /vínculo ativo/);
    // Novo pedido volta a ficar pendente (não reativa sozinho).
    assert.equal((await db.rpc(orgAdmin, 'org_request_link', { p_org: org, p_slug: 'org-cond-a' })).status, 'pending');
    assert.deepEqual(await db.rpc(orgAdmin, 'org_portfolio', { p_org: org }), []);

    // Plataforma: auditor lê, não vincula; owner vincula com justificativa e auditoria.
    assert.equal((await db.rpc(auditor, 'org_platform_list', {})).length, 2);
    await assert.rejects(db.rpc(auditor, 'org_platform_link', { p_org: org2, p_tenant: T2, p_reason: 'Contrato assinado com a administradora' }), /restrito/);
    await assert.rejects(db.rpc(owner, 'org_platform_link', { p_org: org2, p_tenant: T2, p_reason: 'curta' }), /Justifique/);
    await db.rpc(owner, 'org_platform_link', { p_org: org2, p_tenant: T2, p_reason: 'Contrato assinado com a administradora' });
    assert.equal((await db.rpc(rival, 'org_portfolio', { p_org: org2 })).length, 1);
    assert.equal((await db.sql("select count(*)::int n from audit_logs where action='platform.org_link' and tenant_id=$1", [T2]))[0].n, 1);
    // Síndico enxerga e pode revogar o vínculo criado pela plataforma.
    const l2 = (await db.rpc(sindico2, 'tenant_org_links', { p_tenant: T2 }))[0];
    assert.equal(l2.source, 'platform');
    await db.rpc(sindico2, 'tenant_org_decide', { p_link: l2.id, p_decision: 'revoke' });
    assert.deepEqual(await db.rpc(rival, 'org_portfolio', { p_org: org2 }), []);
    // Organização suspensa perde acesso.
    await db.rpc(owner, 'org_platform_link', { p_org: org2, p_tenant: T2, p_reason: 'Reativação após revisão contratual' });
    await db.rpc(owner, 'org_platform_set_status', { p_org: org2, p_status: 'suspended', p_reason: 'Contrato encerrado pela administradora' });
    await assert.rejects(db.rpc(rival, 'org_portfolio', { p_org: org2 }), /não faz parte/);
    assert.equal((await db.as(rival, 'select app.org_can_view($1) ok', [T2]))[0].ok, false);

    // Trilhas de auditoria do fluxo.
    const actions = (await db.sql("select action from audit_logs where action like 'org.%' order by id")).map((r) => r.action);
    for (const a of ['org.created', 'org.link_requested', 'org.link_approve', 'org.invitation_created', 'org.invitation_accepted', 'org.member_revoked', 'org.link_revoke']) {
      assert.ok(actions.includes(a), `auditoria ${a}`);
    }
  } finally { await db.raw.close(); }
});
