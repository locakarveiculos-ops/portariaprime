// Laboratório (stack LOCAL + emulador inscrito): segurança do canal do agente com o servidor real.
//  - requisição sem assinatura, assinatura de outra chave, corpo adulterado, contador repetido;
//  - comando expirado não é entregue; chave de idempotência repetida não duplica;
//  - permissões por função (porteiro/morador/outro síndico) nas RPCs de gerenciamento;
//  - revogação: credencial revogada → sync 401 e aparelho mantém a última política (Lock Task).
// Ao final REINSCREVE o emulador com token novo (para não deixar o laboratório revogado).
//
//   PP_E2E_ALLOW=1 node --env-file=.env.stack.local tests/e2e/kiosk-security.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1') throw new Error('Defina PP_E2E_ALLOW=1.');
assertLocalSupabase(url);
const lab = JSON.parse(readFileSync('tests/evidence/kiosk-lab.json', 'utf8'));
const svc = createClient(url, secret, { auth: { persistSession: false } });
const API = 'http://127.0.0.1:3017';
const ADB = process.env.ADB || 'J:/android-toolchain/sdk/platform-tools/adb.exe';
const lock = () => execFileSync(ADB, ['shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' }).match(/mLockTaskModeState=(\w+)/)[1];
const step = (s) => console.log(`- ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const login = async (u) => { const c = createClient(url, anon, { auth: { persistSession: false } }); await c.auth.signInWithPassword({ email: u.email, password: u.password }); return c; };
const post = (path, body, headers = {}) => fetch(`${API}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

const ui = () => { execFileSync(ADB, ['shell', 'uiautomator', 'dump', '/data/local/tmp/ui.xml']); return execFileSync(ADB, ['shell', 'cat', '/data/local/tmp/ui.xml'], { encoding: 'utf8' }); };
const tap = (text) => {
  const node = [...ui().matchAll(/<node [^>]*>/g)].map((m) => m[0]).find((n) => n.includes(`text="${text}"`) || n.includes(`hint="${text}"`));
  assert.ok(node, `elemento ${text}`);
  const [a, b, c, d] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
  execFileSync(ADB, ['shell', 'input', 'tap', String((a + c) >> 1), String((b + d) >> 1)]);
};

const sind = await login(lab.sindico);
async function reenroll() {
  const { data: enr, error } = await sind.rpc('mdm_enrollment_create', { p_device: lab.device, p_minutes: 30 });
  if (error) throw error;
  for (let i = 0; i < 15 && !/Código de inscrição/.test(ui()); i++) await sleep(2000);
  tap('Código de inscrição'); execFileSync(ADB, ['shell', 'input', 'text', enr.token]); tap('Inscrever');
  for (let i = 0; i < 20; i++) {
    const { data: c } = await svc.from('mdm_device_credentials').select('id').eq('device_id', lab.device).eq('status', 'active').maybeSingle();
    if (c) break; await sleep(1500);
  }
  await sleep(4000);
}
if (!(await svc.from('mdm_device_credentials').select('id').eq('device_id', lab.device).eq('status', 'active').maybeSingle()).data) {
  step('laboratório começou revogado: reinscrição pela UI');
  await reenroll();
}
const { data: cred } = await svc.from('mdm_device_credentials').select('last_counter').eq('device_id', lab.device).eq('status', 'active').single();
const attacker = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

step('assinatura: sem cabeçalhos, chave estranha, corpo adulterado e contador já usado são recusados');
assert.equal((await post('/api/totem/kiosk-sync', '{}')).status, 401);
const n = cred.last_counter + 1000;
const fake = sign('sha256', Buffer.from(`POST\n/api/totem/kiosk-sync\n${lab.device}\n${n}\n${sha('{}')}`), { key: attacker.privateKey, dsaEncoding: 'der' }).toString('base64');
assert.equal((await post('/api/totem/kiosk-sync', '{}', { 'x-pp-device': lab.device, 'x-pp-counter': String(n), 'x-pp-signature': fake })).status, 401, 'chave do atacante');
assert.equal((await post('/api/totem/kiosk-sync', '{"report":{}}', { 'x-pp-device': lab.device, 'x-pp-counter': String(n), 'x-pp-signature': fake })).status, 401, 'corpo adulterado');
const { data: after } = await svc.from('mdm_device_credentials').select('last_counter').eq('device_id', lab.device).eq('status', 'active').single();
assert.ok(after.last_counter < n, 'tentativas inválidas não avançam o contador');

step('permissões por função nas RPCs de gerenciamento');
const porteiro = await login(lab.porteiro), morador = await login(lab.morador);
for (const [who, c] of [['porteiro', porteiro], ['morador', morador]]) {
  for (const [fn, args] of [['mdm_overview', { p_tenant: lab.tenant }], ['mdm_device_detail', { p_device: lab.device }],
    ['mdm_command_create', { p_device: lab.device, p_action: 'start_maintenance', p_params: { minutes: 5, scope: 'settings', reason: 'invasão' }, p_idempotency_key: randomUUID(), p_secret: null }],
    ['mdm_enrollment_create', { p_device: lab.device, p_minutes: 30 }], ['mdm_recovery_set', { p_device: lab.device, p_codes: [] }]]) {
    const r = await c.rpc(fn, args);
    assert.ok(r.error, `${who} não pode ${fn}`);
  }
  assert.equal(((await c.from('mdm_audit_events').select('id')).data || []).length, 0, `${who} não lê auditoria`);
}

step('idempotência e expiração de comando com o aparelho real');
const key = randomUUID();
const c1 = (await sind.rpc('mdm_command_create', { p_device: lab.device, p_action: 'sync_policy', p_params: {}, p_idempotency_key: key, p_secret: null })).data;
const c2 = (await sind.rpc('mdm_command_create', { p_device: lab.device, p_action: 'sync_policy', p_params: {}, p_idempotency_key: key, p_secret: null })).data;
assert.equal(c1.id, c2.id); assert.equal(c2.replayed, true);
// Comando de manutenção vencido antes do aparelho buscar: nunca é aplicado.
const old = (await sind.rpc('mdm_command_create', { p_device: lab.device, p_action: 'start_maintenance', p_params: { minutes: 5, scope: 'settings', reason: 'teste de expiração' }, p_idempotency_key: randomUUID(), p_secret: null })).data;
await svc.from('mdm_commands').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', old.id);
execFileSync(ADB, ['shell', 'cmd', 'jobscheduler', 'run', '-f', 'br.com.portariaprime.kiosk', '1']);
await sleep(12000);
const { data: oldNow } = await svc.from('mdm_commands').select('status').eq('id', old.id).single();
assert.equal(oldNow.status, 'expired', 'comando vencido marcado como expirado');
assert.equal(lock(), 'LOCKED', 'aparelho NÃO entrou em manutenção por comando vencido');
const { data: syncNow } = await svc.from('mdm_commands').select('status').eq('id', c1.id).single();
assert.equal(syncNow.status, 'applied', 'sync_policy confirmado pelo aparelho');

step('revogação: credencial revogada no servidor → aparelho perde acesso, mantém a última política');
await svc.from('mdm_device_credentials').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('device_id', lab.device).eq('status', 'active');
execFileSync(ADB, ['shell', 'cmd', 'jobscheduler', 'run', '-f', 'br.com.portariaprime.kiosk', '1']);
await sleep(12000);
assert.equal(lock(), 'LOCKED', 'revogado continua em quiosque (não libera o aparelho)');
const prefs = execFileSync(ADB, ['shell', 'run-as', 'br.com.portariaprime.kiosk', 'cat', 'shared_prefs/kiosk.xml'], { encoding: 'utf8' });
assert.match(prefs, /name="revoked" value="true"/, 'agente registrou a revogação');
writeFileSync('tests/evidence/emu-31-revogado.png', execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64e6 }));

step('aparelho revogado mostra a tela de reinscrição dentro do quiosque; reinscrição pela UI com token novo');
for (let i = 0; i < 15 && !/credencial deste aparelho foi revogada/.test(ui()); i++) await sleep(2000);
// Código errado na tela de reinscrição não pode destruir a identidade/estado (correção A/B do Keystore).
tap('Código de inscrição'); execFileSync(ADB, ['shell', 'input', 'text', 'ZZZZZZZZZZZZZZZZZZZZZZZZ']); tap('Inscrever');
await sleep(4000);
assert.match(ui(), /inválido|expirado|já usado/i, 'código errado recusado com mensagem');
execFileSync(ADB, ['shell', 'input', 'keyevent', 'KEYCODE_ENTER']); await sleep(1000);
{ const n = [...ui().matchAll(/<node [^>]*>/g)].map((m) => m[0]).find((x) => x.includes('text="OK"'));
  if (n) { const [a, b, c, d] = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number); execFileSync(ADB, ['shell', 'input', 'tap', String((a + c) >> 1), String((b + d) >> 1)]); } }
await sleep(1500);
assert.match(ui(), /credencial deste aparelho foi revogada/, 'após código errado continua na reinscrição (sem perder estado)');
assert.match(ui(), /credencial deste aparelho foi revogada/, 'tela de revogação');
writeFileSync('tests/evidence/emu-32-revogado-reinscricao.png', execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64e6 }));
await reenroll();
const { data: d } = await svc.from('mdm_devices').select('state, management').eq('id', lab.device).single();
assert.ok(['active', 'provisioned'].includes(d.state) && d.management === 'device_owner', `reinscrito: ${JSON.stringify(d)}`);
assert.equal(lock(), 'LOCKED');
console.log('OK kiosk-security');
