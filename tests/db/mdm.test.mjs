// Dispositivos gerenciados: inscrição de uso único, anti-replay, política validada (câmera nunca
// bloqueada), piloto antes de lote, comandos com expiração/ACK, manutenção, recuperação offline,
// desativação pendente até ACK, isolamento entre condomínios e reautenticação.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

let db, T, T2, admin, admin2, port, dev, dev2, other;
const uuid = () => crypto.randomUUID();
const rejects = (p, re) => assert.rejects(p, (e) => re.test(e.message) || assert.fail(e.message));
const NOW = '2026-10-28T12:00:00Z';
const KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE' + 'A'.repeat(88);

// Como o PostgREST: claims completos (amr com horário do login) além do sub.
async function asFresh(uid, fn, args, { loginAt = NOW } = {}) {
  const keys = Object.keys(args);
  await db.raw.exec('begin');
  try {
    await db.raw.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await db.raw.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: uid, aal: 'aal1', amr: [{ method: 'password', timestamp: Math.floor(Date.parse(loginAt) / 1000) }] })]);
    await db.raw.query(`select set_config('app.test_now', $1, true)`, [NOW]);
    await db.raw.exec('set local role authenticated');
    const r = await db.raw.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
    await db.raw.exec('commit');
    return r.rows[0].r;
  } catch (e) { await db.raw.exec('rollback'); throw e; }
}
const svc = async (fn, args) => {
  const keys = Object.keys(args);
  return (await db.service(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k])))[0].r;
};
const sync = (device, counter, report = {}) => svc('mdm_agent_sync', { p_device: device, p_counter: counter, p_report: JSON.stringify({ managed: true, ...report }) });
const ack = (device, counter, cmd, status, detail = null) => svc('mdm_agent_ack', { p_device: device, p_counter: counter, p_command: cmd, p_status: status, p_detail: detail });
const enroll = async (device, owner = admin) => {
  const { token } = await asFresh(owner, 'mdm_enrollment_create', { p_device: device, p_minutes: 60 });
  return { token, res: await svc('mdm_agent_enroll', { p_token_hash: await sha(token), p_agent_id: uuid(), p_public_key: KEY,
    p_info: JSON.stringify({ managed: true, manufacturer: 'Samsung', model: 'SM-X200', release: '14', sdk: '34', agent_version: '1.0.0' }) }) };
};
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

before(async () => {
  db = await createDb();
  await db.sql(`update public.plans set published = true`);
  db.setNow(NOW);
  admin = await db.createUser('sindico@mdm.test');
  admin2 = await db.createUser('sindico2@mdm.test');
  port = await db.createUser('porteiro@mdm.test');
  T = (await db.rpc(admin, 'provision_tenant', { p_request_id: uuid(), p_name: 'Cond MDM', p_slug: 'cond-mdm',
    p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
  T2 = (await db.rpc(admin2, 'provision_tenant', { p_request_id: uuid(), p_name: 'Outro MDM', p_slug: 'outro-mdm',
    p_document: '11222333000181', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
  const inv = await db.rpc(admin, 'create_invitation', { p_tenant: T, p_email: 'porteiro@mdm.test', p_role: 'porteiro', p_unit: null, p_permissions: '{}' });
  await db.rpc(port, 'accept_invitation', { p_token: inv.token });
  dev = (await db.rpc(admin, 'mdm_device_create', { p_tenant: T, p_name: 'Tablet Portaria', p_purpose: 'portaria', p_concierge: null })).device_id;
  dev2 = (await db.rpc(admin, 'mdm_device_create', { p_tenant: T, p_name: 'Tablet 2', p_purpose: 'portaria', p_concierge: null })).device_id;
  other = (await db.rpc(admin2, 'mdm_device_create', { p_tenant: T2, p_name: 'Tablet Outro', p_purpose: 'portaria', p_concierge: null })).device_id;
});

test('somente síndico com settings gerencia; porteiro, morador e outro condomínio não; tabelas fechadas', async () => {
  await rejects(db.rpc(port, 'mdm_overview', { p_tenant: T }), /Sem permissão/);
  await rejects(db.rpc(admin2, 'mdm_device_detail', { p_device: dev }), /Sem permissão/);
  await rejects(db.rpc(admin2, 'mdm_device_create', { p_tenant: T, p_name: 'Intruso', p_purpose: 'portaria', p_concierge: null }), /Sem permissão/);
  await rejects(db.as(admin, `select * from mdm_devices`), /permission denied/);
  await rejects(db.as(null, `select public.mdm_agent_sync($1, 1, '{}')`, [dev]), /permission denied/);
  await rejects(db.as(admin, `select public.mdm_agent_sync($1, 1, '{}')`, [dev]), /permission denied/);
  const ov = await db.rpc(admin, 'mdm_overview', { p_tenant: T });
  assert.equal(ov.devices.length, 2);
  assert.equal(ov.devices[0].state, 'pendente_provisionamento');
  assert.equal(ov.policies[0].versions[0].config.mode, 'single_app');
  assert.ok(!ov.policies[0].versions[0].config.restrictions.some((r) => /camera/.test(r)));
});

test('ação sensível exige login recente', async () => {
  await rejects(db.rpc(admin, 'mdm_enrollment_create', { p_device: dev, p_minutes: 60 }), /Confirme sua senha/);
  await rejects(asFresh(admin, 'mdm_enrollment_create', { p_device: dev, p_minutes: 60 }, { loginAt: '2026-10-28T11:50:00Z' }), /Confirme sua senha/);
});

test('inscrição: uso único, expira, revoga anterior, outro tenant não usa', async () => {
  const a = await asFresh(admin, 'mdm_enrollment_create', { p_device: dev, p_minutes: 60 });
  const b = await asFresh(admin, 'mdm_enrollment_create', { p_device: dev, p_minutes: 60 });
  const info = JSON.stringify({ managed: true, sdk: '34' });
  const bad = (token) => svc('mdm_agent_enroll', { p_token_hash: token, p_agent_id: uuid(), p_public_key: KEY, p_info: info });
  assert.match((await bad(await sha(a.token))).error, /inválido, expirado ou já usado/);
  const ok = await svc('mdm_agent_enroll', { p_token_hash: await sha(b.token), p_agent_id: uuid(), p_public_key: KEY, p_info: info });
  assert.equal(ok.device_id, dev);
  assert.equal(ok.tenant_slug, 'cond-mdm');
  assert.match((await bad(await sha(b.token))).error, /já usado/);
  assert.match((await bad('0'.repeat(64))).error, /inválido/);
  // Token vencido.
  const c = await asFresh(admin, 'mdm_enrollment_create', { p_device: dev2, p_minutes: 10 });
  db.setNow('2026-10-28T12:11:00Z');
  assert.match((await bad(await sha(c.token))).error, /expirado/);
  db.setNow(NOW);
  const [{ n }] = await db.sql(`select count(*)::int n from mdm_audit_events where device_id = $1 and event = 'enrollment.rejected'`, [dev]);
  assert.ok(n >= 2);
  // Sem Device Owner: fica "falha", nunca "protegido".
  const { token } = await asFresh(admin, 'mdm_enrollment_create', { p_device: dev2, p_minutes: 60 });
  await svc('mdm_agent_enroll', { p_token_hash: await sha(token), p_agent_id: uuid(), p_public_key: KEY, p_info: JSON.stringify({ managed: false }) });
  const d2 = await db.rpc(admin, 'mdm_device_detail', { p_device: dev2 });
  assert.equal(d2.state, 'falha');
  assert.equal(d2.management, 'unmanaged');
  assert.equal(d2.compliant, false);
});

test('sync: anti-replay por contador, política desejada x aplicada, inventário só do catálogo', async () => {
  const r = await sync(dev, 10, { applied_version_id: null });
  assert.equal(r.policy.config.mode, 'single_app');
  await rejects(sync(dev, 10), /repetida ou fora de ordem/);
  await rejects(sync(dev, 9), /repetida ou fora de ordem/);
  let d = await db.rpc(admin, 'mdm_device_detail', { p_device: dev });
  assert.equal(d.state, 'politica_pendente');
  await sync(dev, 11, { applied_version_id: r.policy.version_id, battery_pct: 87, charging: true,
    apps: [{ package_name: 'com.whatsapp', version_code: 1 }, { package_name: 'com.google.android.calculator', version_code: 5 }] });
  d = await db.rpc(admin, 'mdm_device_detail', { p_device: dev });
  assert.equal(d.state, 'ativo');
  assert.equal(d.compliant, true);
  assert.equal(d.battery_pct, 87);
  assert.deepEqual(d.report.apps.map((a) => a.package_name), ['com.google.android.calculator']);
  // Offline pelo último contato.
  db.setNow('2026-10-28T12:30:00Z');
  assert.equal((await db.rpc(admin, 'mdm_device_detail', { p_device: dev })).state, 'offline');
  db.setNow(NOW);
});

test('política: câmera nunca bloqueada, campos desconhecidos, Single-App sem Início/Recentes, catálogo', async () => {
  const save = (config) => db.rpc(admin, 'mdm_policy_save', { p_tenant: T, p_policy: null, p_name: `P ${uuid().slice(0, 6)}`, p_config: JSON.stringify(config) });
  await rejects(save({ restrictions: ['camera'] }), /câmera não pode ser bloqueada/);
  await rejects(save({ shell: 'rm -rf /' }), /Campo de política desconhecido/);
  await rejects(save({ mode: 'single_app', lock_task_features: ['home', 'overview'] }), /Single-App não libera/);
  await rejects(save({ mode: 'multi_app', lock_task_features: ['overview'] }), /Recentes exige/);
  await rejects(save({ mode: 'multi_app', apps: ['com.whatsapp'] }), /fora do catálogo/);
  await rejects(save({ system_update: { type: 'postpone' } }), /adiar indefinidamente não é permitido/);
  await rejects(save({ start_path: 'https://evil.example' }), /Tela inicial/);
  const ok = await save({ mode: 'multi_app', apps: ['com.google.android.calculator'], lock_task_features: ['home', 'system_info', 'global_actions'],
    system_update: { type: 'windowed', start_min: 120, end_min: 300 } });
  assert.equal(ok.config.status_bar_disabled, false);
  assert.equal(ok.config.system_update.type, 'windowed');
  // Rascunho não atribui; lote sem piloto não; piloto primeiro.
  await rejects(asFresh(admin, 'mdm_assign', { p_devices: [dev], p_version: ok.version_id }), /Publique a versão/);
  await db.rpc(admin, 'mdm_policy_publish', { p_version: ok.version_id });
  await rejects(asFresh(admin, 'mdm_assign', { p_devices: [dev, dev2], p_version: ok.version_id }), /aparelho piloto/);
  await rejects(asFresh(admin, 'mdm_assign', { p_devices: [other], p_version: ok.version_id }), /inválido para este condomínio/);
  assert.equal(await asFresh(admin, 'mdm_assign', { p_devices: [dev], p_version: ok.version_id }), 1);
  const r = await sync(dev, 20);
  assert.equal(r.policy.version_id, ok.version_id);
  await sync(dev, 21, { applied_version_id: ok.version_id });
  assert.equal(await asFresh(admin, 'mdm_assign', { p_devices: [dev, dev2], p_version: ok.version_id }), 2);
});

test('comandos: enumerados, idempotentes, expiram; desbloqueio velho não vale após reconexão', async () => {
  const key = uuid();
  await rejects(asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'shell', p_params: '{}', p_idempotency_key: uuid(), p_secret: null }), /Ação desconhecida/);
  await rejects(asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'start_maintenance', p_params: JSON.stringify({ minutes: 999, scope: 'settings', reason: 'troca' }), p_idempotency_key: uuid(), p_secret: null }), /Duração/);
  const c = await asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'start_maintenance', p_params: JSON.stringify({ minutes: 15, scope: 'settings', reason: 'Ajuste de Wi-Fi' }), p_idempotency_key: key, p_secret: null });
  const again = await asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'start_maintenance', p_params: JSON.stringify({ minutes: 15, scope: 'settings', reason: 'Ajuste de Wi-Fi' }), p_idempotency_key: key, p_secret: null });
  assert.equal(again.id, c.id);
  assert.equal(again.replayed, true);
  // Pedido ainda não confirmado pelo aparelho: o painel não afirma "em manutenção".
  assert.notEqual((await db.rpc(admin, 'mdm_device_detail', { p_device: dev })).state, 'em_manutencao');
  // Aparelho reconecta 11 minutos depois: comando expirado, não é entregue.
  db.setNow('2026-10-28T12:11:00Z');
  const r = await sync(dev, 30);
  assert.ok(!r.commands.some((x) => x.id === c.id));
  const [cmd] = await db.sql(`select status from mdm_commands where id = $1`, [c.id]);
  assert.equal(cmd.status, 'expired');
  await rejects(ack(dev, 31, c.id, 'applied').then((x) => assert.equal(x.status, 'expired')).then(() => { throw new Error('ok-expired'); }), /ok-expired/);
  db.setNow(NOW);
});

test('ACK: ordem recebido → aplicando → aplicado; manutenção termina; repetição não regride', async () => {
  const c = await asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'start_maintenance', p_params: JSON.stringify({ minutes: 10, scope: 'wifi', reason: 'Trocar rede' }), p_idempotency_key: uuid(), p_secret: null });
  const r = await sync(dev, 40);
  const cmd = r.commands.find((x) => x.id === c.id);
  assert.equal(cmd.action, 'start_maintenance');
  assert.equal(cmd.params.minutes, 10);
  await ack(dev, 41, c.id, 'received');
  await ack(dev, 42, c.id, 'applied');
  assert.equal((await ack(dev, 43, c.id, 'received')).replayed, true);
  const results = await db.sql(`select status from mdm_command_results where command_id = $1 order by id`, [c.id]);
  assert.deepEqual(results.map((x) => x.status), ['received', 'applied']);
  const end = await asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'end_maintenance', p_params: '{}', p_idempotency_key: uuid(), p_secret: null });
  await sync(dev, 44);
  await ack(dev, 45, end.id, 'applied');
  const [m] = await db.sql(`select ended_at, end_reason from mdm_maintenance_sessions where command_id = $1`, [c.id]);
  assert.ok(m.ended_at);
});

test('Wi-Fi: senha não aparece no painel/eventos e é apagada após o ACK', async () => {
  await rejects(asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'wifi_apply', p_params: JSON.stringify({ ssid: 'Portaria', security: 'wpa2' }), p_idempotency_key: uuid(), p_secret: '123' }), /Senha do Wi-Fi/);
  const c = await asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'wifi_apply', p_params: JSON.stringify({ ssid: 'Portaria', security: 'wpa2' }), p_idempotency_key: uuid(), p_secret: 'senhaSecreta123' });
  const d = await db.rpc(admin, 'mdm_device_detail', { p_device: dev });
  assert.ok(!JSON.stringify(d).includes('senhaSecreta123'));
  const r = await sync(dev, 50);
  assert.equal(r.commands.find((x) => x.id === c.id).params.password, 'senhaSecreta123');
  await ack(dev, 51, c.id, 'failed', 'Sem conexão com o servidor pela nova rede; rede anterior mantida.');
  const [row] = await db.sql(`select secret_params from mdm_commands where id = $1`, [c.id]);
  assert.equal(row.secret_params, null);
  const ev = await db.sql(`select data::text t from mdm_audit_events where device_id = $1`, [dev]);
  assert.ok(!ev.some((e) => e.t.includes('senhaSecreta123')));
});

test('recuperação offline: só hashes; uso registrado; códigos não reaparecem como livres', async () => {
  const codes = Array.from({ length: 10 }, (_, i) => ({ salt: 'ab'.repeat(16), hash: (i.toString(16) + 'f').repeat(32).slice(0, 64), iterations: 120000 }));
  await rejects(asFresh(admin, 'mdm_recovery_set', { p_device: dev, p_codes: JSON.stringify([{ salt: 'x', hash: 'y', iterations: 1 }]) }), /de 5 a 20/);
  const ver = await asFresh(admin, 'mdm_recovery_set', { p_device: dev, p_codes: JSON.stringify(codes) });
  assert.equal(ver, 1);
  const r = await sync(dev, 60, { recovery_version: 0 });
  assert.equal(r.recovery.version, 1);
  assert.equal(r.recovery.codes.length, 10);
  assert.equal((await sync(dev, 61, { recovery_version: 1 })).recovery, null);
  await svc('mdm_agent_event', { p_device: dev, p_counter: 62, p_event: 'maintenance.offline_start', p_data: JSON.stringify({ idx: 3, version: 1, minutes: 15 }) });
  const d = await db.rpc(admin, 'mdm_device_detail', { p_device: dev });
  assert.equal(d.recovery.remaining, 9);
  assert.equal(d.state, 'em_manutencao');
  assert.deepEqual((await sync(dev, 63, { recovery_version: 1 })).used_recovery, [3]);
  await svc('mdm_agent_event', { p_device: dev, p_counter: 64, p_event: 'maintenance.end', p_data: JSON.stringify({ reason: 'expired' }) });
  await rejects(svc('mdm_agent_event', { p_device: dev, p_counter: 65, p_event: 'exec', p_data: '{}' }), /Evento desconhecido/);
});

test('desativação fica pendente até ACK; só então revoga credencial; dados preservados', async () => {
  const c = await asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'deactivate', p_params: '{}', p_idempotency_key: uuid(), p_secret: null });
  let d = await db.rpc(admin, 'mdm_device_detail', { p_device: dev });
  assert.equal(d.state, 'desativacao_pendente');
  await rejects(asFresh(admin, 'mdm_command_create', { p_device: dev, p_action: 'reboot', p_params: '{}', p_idempotency_key: uuid(), p_secret: null }), /Desativação em andamento/);
  await sync(dev, 70);
  await ack(dev, 71, c.id, 'applied', 'Restrições removidas; Device Owner liberado.');
  d = await db.rpc(admin, 'mdm_device_detail', { p_device: dev });
  assert.equal(d.state, 'desativado');
  await rejects(sync(dev, 72), /revogada/);
  assert.equal((await db.sql(`select count(*)::int n from mdm_devices where id = $1`, [dev]))[0].n, 1);
  // Aparelho perdido: desativação local declarada (sem ACK) exige descrição.
  const t2 = (await db.rpc(admin, 'mdm_device_create', { p_tenant: T, p_name: 'Perdido', p_purpose: 'portaria', p_concierge: null })).device_id;
  await enroll(t2);
  await asFresh(admin, 'mdm_command_create', { p_device: t2, p_action: 'deactivate', p_params: '{}', p_idempotency_key: uuid(), p_secret: null });
  await rejects(asFresh(admin, 'mdm_deactivation_confirm_local', { p_device: t2, p_statement: 'ok' }), /Descreva/);
  await asFresh(admin, 'mdm_deactivation_confirm_local', { p_device: t2, p_statement: 'Restaurado de fábrica pelo síndico na portaria.' });
  assert.equal((await db.rpc(admin, 'mdm_device_detail', { p_device: t2 })).state, 'desativado');
});

test('Admin Master: suporte vê a frota (leitura auditada), financeiro não; publicação do agente só owner', async () => {
  const owner = await db.createUser('owner@mdm.test');
  const support = await db.createUser('suporte@mdm.test');
  const finance = await db.createUser('fin@mdm.test');
  await db.sql(`insert into platform_admins (user_id, role) values ($1, 'owner'), ($2, 'support'), ($3, 'finance')`, [owner, support, finance]);
  const fleet = await db.rpc(support, 'platform_devices', { p_tenant: T });
  const mine = fleet.tenants.find((x) => x.tenant_id === T);
  assert.ok(mine.total >= 2 && Array.isArray(mine.devices));
  assert.ok(!JSON.stringify(fleet).includes('public_key'));
  assert.equal((await db.sql(`select count(*)::int n from audit_logs where action = 'platform.devices_view' and actor_id = $1`, [support]))[0].n, 1);
  await rejects(db.rpc(finance, 'platform_devices', { p_tenant: null }), /restrito/);
  await rejects(db.rpc(admin, 'platform_devices', { p_tenant: null }), /restrito/);
  await rejects(db.rpc(support, 'platform_agent_release', { p_version_code: 1, p_version_name: '1.0.0', p_apk_url: 'https://x.example/a.apk', p_signature_checksum: 'a'.repeat(43) }), /restrito/);
  await rejects(db.rpc(owner, 'platform_agent_release', { p_version_code: 1, p_version_name: '1.0.0', p_apk_url: 'http://x.example/a.apk', p_signature_checksum: 'a'.repeat(43) }), /Versão inválida/);
  await db.rpc(owner, 'platform_agent_release', { p_version_code: 1, p_version_name: '1.0.0', p_apk_url: 'https://x.example/a.apk', p_signature_checksum: 'a'.repeat(43) });
  assert.equal((await db.rpc(admin, 'mdm_overview', { p_tenant: T })).release.version_name, '1.0.0');
  // Suporte não tem RPC de comando: só o síndico do condomínio comanda aparelhos.
  await rejects(asFresh(support, 'mdm_command_create', { p_device: dev2, p_action: 'reboot', p_params: '{}', p_idempotency_key: uuid(), p_secret: null }), /Sem permissão/);
});

test('troca de turno: nonce do aparelho + operador do mesmo condomínio; outros não registram', async () => {
  const d = (await db.rpc(admin, 'mdm_device_create', { p_tenant: T, p_name: 'Turno', p_purpose: 'portaria', p_concierge: null })).device_id;
  await enroll(d);
  const nonce = await svc('mdm_shift_nonce', { p_device: d });
  assert.match(nonce, /^[0-9a-f]{64}$/);
  await rejects(db.rpc(port, 'mdm_shift_nonce', { p_device: d }), /permission denied/);
  assert.equal(await db.rpc(port, 'mdm_shift_event', { p_nonce: nonce, p_event: 'shift.start' }), true);
  assert.equal(await db.rpc(port, 'mdm_shift_event', { p_nonce: nonce, p_event: 'shift.start' }), true, 'recarregar não duplica');
  assert.equal(await db.rpc(port, 'mdm_shift_event', { p_nonce: nonce, p_event: 'shift.end' }), true);
  assert.equal(await db.rpc(admin2, 'mdm_shift_event', { p_nonce: nonce, p_event: 'shift.start' }), false, 'outro condomínio');
  assert.equal(await db.rpc(port, 'mdm_shift_event', { p_nonce: 'f'.repeat(64), p_event: 'shift.start' }), false, 'nonce inválido');
  assert.equal(await db.rpc(port, 'mdm_shift_event', { p_nonce: nonce, p_event: 'exec' }), false);
  const rows = await db.sql(`select event, actor_id, tenant_id, data->>'role' r from mdm_audit_events where device_id = $1 and event like 'shift.%' order by id`, [d]);
  assert.deepEqual(rows.map((r) => [r.event, r.actor_id, r.tenant_id, r.r]), [['shift.start', port, T, 'porteiro'], ['shift.end', port, T, 'porteiro']]);
  // Rotação: após 24 h novo nonce; o anterior ainda vale mais 24 h; depois expira.
  db.setNow('2026-10-29T12:30:00Z');
  const n2 = await svc('mdm_shift_nonce', { p_device: d });
  assert.notEqual(n2, nonce);
  assert.equal(await db.rpc(port, 'mdm_shift_event', { p_nonce: nonce, p_event: 'shift.start' }), true);
  db.setNow('2026-10-30T13:00:00Z');
  assert.equal(await db.rpc(port, 'mdm_shift_event', { p_nonce: nonce, p_event: 'shift.end' }), false, 'anterior expirado');
  db.setNow(NOW);
});

test('manutenção pedida que expira sem o aparelho aplicar não deixa o painel "em manutenção"', async () => {
  const d = (await db.rpc(admin, 'mdm_device_create', { p_tenant: T, p_name: 'Expira', p_purpose: 'portaria', p_concierge: null })).device_id;
  await enroll(d);
  const r1 = await sync(d, 1);
  await sync(d, 2, { applied_version_id: r1.policy.version_id });
  await asFresh(admin, 'mdm_command_create', { p_device: d, p_action: 'start_maintenance', p_params: JSON.stringify({ minutes: 15, scope: 'settings', reason: 'Pedido não aplicado' }), p_idempotency_key: uuid(), p_secret: null });
  assert.notEqual((await db.rpc(admin, 'mdm_device_detail', { p_device: d })).state, 'em_manutencao', 'pedido não confirmado não é manutenção');
  db.setNow('2026-10-28T12:11:00Z');
  await sync(d, 3, { applied_version_id: r1.policy.version_id });
  const det = await db.rpc(admin, 'mdm_device_detail', { p_device: d });
  assert.equal(det.state, 'ativo');
  assert.ok(det.maintenance[0].ended_at, 'sessão encerrada');
  db.setNow(NOW);
});
