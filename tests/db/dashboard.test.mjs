// Indicadores conferidos contra registros conhecidos: limites de data no fuso,
// período anterior zerado, exceções, estoque agora, capacidade e amostra vazia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('indicadores com base conhecida', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    db.setNow('2026-03-10T15:00:00Z'); // 12:00 em São Paulo
    const admin = await db.createUser('sindico@dash.invalid');
    const port = await db.createUser('porteiro@dash.invalid');
    const other = await db.createUser('outro@dash.invalid');
    const T = (await db.rpc(admin, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Dash', p_slug: 'dash-cond',
      p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const O = (await db.rpc(other, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Outro', p_slug: 'outro-cond',
      p_document: '11222333000181', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
    const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: 'porteiro@dash.invalid', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
    await db.rpc(port, 'accept_invitation', { p_token: inv.token });
    const [{ id: u }] = await db.as(admin, "insert into units(tenant_id,label) values($1,'101') returning id", [T]);
    await db.as(admin, "insert into units(tenant_id,label) values($1,'102')", [T]);
    const [{ id: conc }] = await db.sql('select id from concierge_locations where tenant_id=$1', [T]);

    // Antes de haver locais: capacidade "não definida" (null), não 0%.
    assert.equal((await db.rpc(admin, 'dashboard_operation', { p_tenant: T })).occupancy.capacity, null);
    const [{ id: loc }] = await db.sql("insert into storage_locations(tenant_id,concierge_location_id,code,capacity) values($1,$2,'A1',4) returning id", [T, conc]);

    // Registros com datas controladas (fuso -03).
    const ins = (received, status, extra = {}) => db.service(`insert into packages(tenant_id,unit_id,status,carrier,idempotency_key,received_at,storage_location_id,picked_up_at,picked_up_by_name,pickup_method,resolution_reason,resolved_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [T, u, status, extra.carrier || 'Correios', crypto.randomUUID(), received,
      ['RECEBIDA', 'ARMAZENADA'].includes(status) ? loc : null, extra.picked || null, extra.picked ? 'X' : null, extra.picked ? 'qr' : null,
      extra.reason || null, extra.resolved || null]);
    await ins('2026-03-10T02:59:00Z', 'ARMAZENADA');                    // 09/03 23:59 local -> fora de "hoje"
    await ins('2026-03-10T03:00:00Z', 'ARMAZENADA', { carrier: 'Shopee' }); // 10/03 00:00 local -> hoje
    await ins('2026-03-06T12:00:00Z', 'ARMAZENADA');                    // > 72 h
    await ins('2026-03-09T12:00:00Z', 'RETIRADA', { picked: '2026-03-10T14:00:00Z' }); // retirada hoje, 26 h
    await ins('2026-03-09T12:00:00Z', 'DEVOLVIDA', { reason: 'Endereço errado', resolved: '2026-03-10T13:00:00Z' });
    await ins('2026-03-10T12:00:00Z', 'PRE_REGISTRADA');                 // não conta como entrada

    const op = await db.rpc(admin, 'dashboard_operation', { p_tenant: T });
    assert.equal(op.waiting_now, 3, 'estoque agora = RECEBIDA/ARMAZENADA');
    assert.equal(op.stale_now, 1);
    assert.equal(op.received_today, 1, 'limite de meia-noite no fuso do condomínio');
    assert.equal(op.picked_today, 1);
    assert.deepEqual(op.occupancy, { used: 3, capacity: 4 });
    assert.equal(op.attention.near_capacity, 0); // 3/4 = 75% < 85%
    assert.equal(op.attention.preregistered, 1);
    assert.equal(op.attention.stale_packages, 1);

    // Período 09–10/03 (local). Entradas: 09/03 23:59, 10/03 00:00, retirada (09/03 09:00), devolvida (09/03 09:00) = 4.
    // Período anterior 07–08/03: nenhuma (06/03 está antes) -> variação sem base (null), nunca infinito.
    const an = await db.rpc(admin, 'dashboard_analysis', { p_tenant: T, p_from: '2026-03-09', p_to: '2026-03-10' });
    assert.deepEqual(an.entries, { value: 4, previous: 0, change: null });
    assert.deepEqual(an.pickups, { value: 1, previous: 0, change: null });
    assert.deepEqual(an.daily.map((d) => [d.day, d.in, d.out]), [['2026-03-09', 3, 0], ['2026-03-10', 1, 1]]);
    assert.equal(an.dwell.n, 1); assert.equal(an.dwell.median_h, 26); assert.equal(an.dwell.p90_h, null, 'p90 só com amostra >= 10');
    assert.deepEqual(an.aging_now, { lt24: 2, h24_48: 0, h48_72: 0, gt72: 1 }); // agora 15:00Z: 02:59Z e 03:00Z têm ~12 h
    assert.deepEqual(an.exceptions, [{ status: 'DEVOLVIDA', n: 1 }]);
    assert.deepEqual(an.carriers.map((c) => [c.carrier, c.n]), [['Correios', 3], ['Shopee', 1]]);
    assert.equal(an.heatmap.reduce((s, h) => s + h.n, 0), 4, 'mapa de calor soma as entradas');
    assert.deepEqual(an.adoption, { units_active: 2, units_with_resident: 0, pending_requests: 0 });
    // Período vazio: amostra 0, médias nulas (não zero).
    const empty = await db.rpc(admin, 'dashboard_analysis', { p_tenant: T, p_from: '2025-01-01', p_to: '2025-01-02' });
    assert.deepEqual([empty.entries.value, empty.dwell.n, empty.dwell.median_h], [0, 0, null]);
    await assert.rejects(db.rpc(admin, 'dashboard_analysis', { p_tenant: T, p_from: '2026-03-10', p_to: '2026-03-01' }), /Período/);
    // Permissão e isolamento: porteiro e síndico de outro condomínio não leem.
    await assert.rejects(db.rpc(port, 'dashboard_operation', { p_tenant: T }), /permissão/i);
    await assert.rejects(db.rpc(other, 'dashboard_analysis', { p_tenant: T, p_from: '2026-03-09', p_to: '2026-03-10' }), /permissão/i);
    assert.equal((await db.rpc(other, 'dashboard_operation', { p_tenant: O })).waiting_now, 0);
    // Central de notificações: só as do próprio usuário, leitura individual.
    await db.sql("insert into notifications(tenant_id,user_id,kind,title,body) values($1,$2,'ops_alert','A','a'),($1,$3,'ops_alert','B','b')", [T, admin, port]);
    const mine = await db.rpc(admin, 'my_notifications', { p_tenant: T, p_unread: true, p_before: null, p_limit: 20 });
    assert.equal(mine.unread, 1); assert.deepEqual(mine.items.map((n) => n.title), ['A']);
    await db.as(admin, 'update notifications set read_at=now() where tenant_id=$1', [T]);
    assert.equal((await db.rpc(port, 'my_notifications', { p_tenant: T, p_unread: true, p_before: null, p_limit: 20 })).unread, 1, 'leitura não afeta outro usuário');
    assert.equal(await db.rpc(other, 'my_notifications', { p_tenant: T, p_unread: false, p_before: null, p_limit: 20 }), null);
  } finally { await db.raw.close(); }
});
