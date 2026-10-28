// Laboratório: dirige a WebView REAL do quiosque no emulador pelo DevTools (só build lab), via CDP
// direto no alvo da página. Verifica navegação interna (pushState), isolamento de condomínio, área
// administrativa, links externos, autorização no servidor e troca de turno auditada.
//
//   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
//   PP_E2E_ALLOW=1 node --env-file=.env.stack.local tests/e2e/kiosk-webview.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1') throw new Error('Defina PP_E2E_ALLOW=1.');
assertLocalSupabase(url);
const lab = JSON.parse(readFileSync('tests/evidence/kiosk-lab.json', 'utf8'));
const svc = createClient(url, secret, { auth: { persistSession: false } });
const ADB = process.env.ADB || 'J:/android-toolchain/sdk/platform-tools/adb.exe';
const lock = () => execFileSync(ADB, ['shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' }).match(/mLockTaskModeState=(\w+)/)[1];
const save = (n) => writeFileSync(`tests/evidence/emu-${n}.png`, execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64e6 }));
const step = (s) => console.log(`- ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CDP mínimo ---------------------------------------------------------------
const target = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find((t) => t.type === 'page' && t.url.startsWith('http'));
assert.ok(target, 'página da WebView não encontrada');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expression) {
  for (let i = 0; i < 20; i++) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (!r.error && !r.result?.exceptionDetails) return r.result.result.value;
    await sleep(500);   // contexto trocando durante navegação
  }
  throw new Error(`falha ao avaliar: ${expression.slice(0, 80)}`);
}
const path = () => ev('location.pathname');
async function waitFor(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(400); } throw new Error('tempo esgotado'); }
const hasText = (t) => ev(`document.body && document.body.innerText.includes(${JSON.stringify(t)})`);
const setInput = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickText = (sel, t) => ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(t)})); if (!el) return false; el.click(); return true; })()`);
async function login(u) {
  await waitFor(() => ev(`!!document.querySelector('input[type=email]')`));
  await setInput('input[type=email]', u.email); await setInput('input[type=password]', u.password);
  assert.ok(await clickText('button', 'Entrar'), 'botão Entrar');
}
const inTenant = new RegExp(`^/c/${lab.slug}(/|$)`);

// --- Roteiro --------------------------------------------------------------------
step(`quiosque aberto no condomínio inscrito (${await path()})`);
assert.match(await path(), inTenant);
assert.equal(lock(), 'LOCKED');

step('porteiro A entra pela tela de login dentro do quiosque');
// Começa sem sessão (execuções anteriores podem ter deixado alguém logado nesta WebView).
await ev(`(async () => { for (const k of Object.keys(localStorage)) if (k.startsWith('sb-')) localStorage.removeItem(k); return true; })()`);
await ev(`location.href = '/entrar?next=' + encodeURIComponent('/c/${lab.slug}/portaria'); true`);
await login(lab.porteiro);
await waitFor(async () => /\/portaria$/.test(await path()));
await sleep(2500);
save('10-porteiro-a');

step('pushState para outro condomínio, /admin, /org e /contratar: o quiosque devolve ao condomínio inscrito');
for (const p of [`/c/${lab.slug2}/portaria`, `/c/${lab.slug2}/painel`, '/admin', '/org', '/contratar', '/planos']) {
  await ev(`history.pushState({}, '', ${JSON.stringify(p)}); dispatchEvent(new PopStateEvent('popstate')); true`);
  await waitFor(async () => inTenant.test(await path()), 15000).catch(() => {});
  const now = await path();
  assert.match(now, inTenant, `${p} -> ${now}`);
  console.log(`   ${p} → ${now}`);
}

step('navegação por location.href para outro condomínio e para site externo bloqueada');
for (const p of [`/c/${lab.slug2}/painel`, 'https://example.com/', 'intent://x#Intent;scheme=https;end']) {
  await ev(`location.href = ${JSON.stringify(p)}; true`).catch(() => {});
  await sleep(2500);
  assert.match(await path(), inTenant, `${p} -> ${await path()}`);
}
await ev(`window.open('https://example.com'); const a = document.createElement('a'); a.href = 'https://example.com'; a.target = '_blank'; document.body.appendChild(a); a.click(); true`);
await sleep(2000);
assert.match(await path(), inTenant);
assert.equal(lock(), 'LOCKED');

step('servidor: com a sessão do porteiro, administração e outro condomínio são negados');
const pc = createClient(url, anon, { auth: { persistSession: false } });
await pc.auth.signInWithPassword({ email: lab.porteiro.email, password: lab.porteiro.password });
const { data: otherT } = await svc.from('tenants').select('id').eq('slug', lab.slug2).single();
for (const [fn, args] of [['mdm_overview', { p_tenant: lab.tenant }], ['mdm_overview', { p_tenant: otherT.id }],
  ['create_invitation', { p_tenant: lab.tenant, p_email: 'x@e2e.portariaprime.invalid', p_role: 'admin', p_unit: null, p_permissions: '{}' }],
  ['mdm_command_create', { p_device: lab.device, p_action: 'reboot', p_params: {}, p_idempotency_key: crypto.randomUUID(), p_secret: null }]]) {
  const r = await pc.rpc(fn, args);
  assert.ok(r.error, `${fn} deveria ser negado ao porteiro`);
}
const ctxp = await pc.rpc('platform_context');
assert.deepEqual(ctxp.data?.capabilities ?? [], [], 'porteiro sem capacidades globais');
assert.equal(((await pc.from('packages').select('id').eq('tenant_id', otherT.id)).data || []).length, 0, 'sem dados de outro condomínio');
assert.equal(((await pc.from('mdm_devices').select('id')).data || []).length, 0, 'tabela de aparelhos fechada');

step('troca de turno: sair → porteira B entra, sem sair do quiosque; auditoria com operador, aparelho, condomínio e hora');
const before = new Date().toISOString();
assert.ok(await ev(`(() => { const b = document.querySelector('button[aria-label="Conta"]'); if (!b) return false; b.click(); return true; })()`), 'menu da conta');
await sleep(500);
assert.ok(await clickText('[role=menuitem]', 'Sair'), 'menu Sair');
await waitFor(async () => (await path()) === '/entrar');
assert.equal(lock(), 'LOCKED');
await login(lab.porteiro2);
await waitFor(async () => /^\/(app|c\/)/.test(await path()));
await ev(`location.href = '/c/${lab.slug}/portaria'; true`);
await waitFor(async () => /\/portaria$/.test(await path()));
await sleep(3000);
save('11-porteira-b');
const { data: shifts } = await svc.from('mdm_audit_events').select('event, actor_id, tenant_id, device_id, created_at, data')
  .eq('device_id', lab.device).like('event', 'shift.%').gte('created_at', before).order('id');
console.log(JSON.stringify(shifts.map((s) => ({ ...s, actor: s.actor_id === lab.porteiro.id ? 'porteiro A' : s.actor_id === lab.porteiro2.id ? 'porteira B' : s.actor_id }))));
assert.ok(shifts.some((s) => s.event === 'shift.end' && s.actor_id === lab.porteiro.id && s.tenant_id === lab.tenant), 'fim do turno A auditado');
assert.ok(shifts.some((s) => s.event === 'shift.start' && s.actor_id === lab.porteiro2.id && s.tenant_id === lab.tenant), 'início do turno B auditado');
assert.equal(lock(), 'LOCKED');
console.log('OK kiosk-webview');
ws.close();
