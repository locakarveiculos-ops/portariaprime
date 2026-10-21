// Administração global: usuários sintéticos em Supabase LOCAL, nunca a sessão do proprietário real.
// PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/platform.mjs
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { assertLocalSupabase } from './environment.mjs';

const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
assert.equal(process.env.PP_E2E_ALLOW, '1', 'Confirme PP_E2E_ALLOW=1 somente na stack local');
assertLocalSupabase(url);
const APP = process.env.APP || 'http://127.0.0.1:3017';
assertLocalSupabase(APP);
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(url, secret, opts);
const stamp = Date.now().toString(36);
const users = {};
const check = (r) => { if (r.error) throw r.error; return r.data; };
const rpc = async (who, name, params = {}) => check(await users[who].client.rpc(name, params));
async function account(role) {
  const email = `platform-${stamp}-${role}@qa.portariaprime.invalid`, password = `Q${crypto.randomUUID()}!`;
  const user = check(await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `QA ${role}` } })).user;
  const client = createClient(url, anon, opts);
  check(await client.auth.signInWithPassword({ email, password }));
  users[role] = { ...user, email, password, client };
  if (['owner', 'support', 'finance', 'auditor'].includes(role)) check(await service.from('platform_admins').insert({ user_id: user.id, role, active: true }));
}
const request = () => crypto.randomUUID();
const action = (who, name, target, data = {}, id = request()) => rpc(who, 'platform_action', {
  p_action: name, p_target: target, p_reason: 'Teste administrativo em ambiente isolado', p_data: data, p_request: id,
});
await mkdir('tests/evidence/platform', { recursive: true });
for (const role of ['owner', 'support', 'finance', 'auditor', 'tenant', 'outsider']) await account(role);
check(await service.from('plans').update({ published: true }).in('code', ['essencial','profissional','prime']));
const tenant = await rpc('tenant', 'provision_tenant', {
  p_request_id: request(), p_name: 'Condomínio QA Plataforma', p_slug: `e2e-platform-${stamp}`,
  p_document: String(50000000000000 + Date.now() % 9000000000000), p_timezone: 'America/Sao_Paulo',
  p_plan_code: 'profissional', p_cycle: 'monthly', p_contact_phone: null,
});
const tid = tenant.tenant_id;
const before = check(await service.from('subscriptions').select('trial_ends_at').eq('tenant_id', tid).single());
console.log('Fixture local criada; nenhum envio externo autorizado.');
for (const who of ['owner','support','finance','auditor']) assert.equal((await rpc(who, 'platform_context')).role, who);
for (const who of ['tenant', 'outsider']) {
  assert.equal((await rpc(who, 'platform_context')).role, null);
  await assert.rejects(rpc(who, 'platform_list', { p_section: 'tenants' }));
  await assert.rejects(action(who, 'team_role', users[who].id, { role: 'owner', active: true }));
}
await assert.rejects(action('support', 'team_role', users.support.id, { role: 'owner', active: true }));
await assert.rejects(action('auditor', 'tenant_status', tid, { status: 'suspended' }));
const end = new Date(new Date(before.trial_ends_at).getTime() + 3 * 86400000).toISOString();
const id = request();
const results = await Promise.allSettled([
  action('owner', 'trial_extend', tid, { ends_at: end, trial_state: 'active' }, id),
  action('owner', 'trial_extend', tid, { ends_at: end, trial_state: 'active' }, id),
]);
assert.equal(results.filter(x => x.status === 'fulfilled').length, 2, 'mesma solicitação concorrente é idempotente');
const after = check(await service.from('subscriptions').select('trial_ends_at').eq('tenant_id', tid).single());
assert.equal(new Date(after.trial_ends_at).toISOString(), end);
await action('owner', 'tenant_status', tid, { status: 'suspended' });
await assert.rejects(rpc('tenant', 'subscription_overview', { p_tenant: tid }));
await action('owner', 'tenant_status', tid, { status: 'active' });
const overview = await rpc('tenant', 'subscription_overview', { p_tenant: tid });
assert.equal(overview.status, 'trialing', 'reativar não inventa pagamento');
assert.equal(check(await service.from('payments').select('id').eq('tenant_id', tid)).length, 0);
for (const who of ['owner','support','finance','auditor']) {
  const { data } = await users[who].client.from('packages').select('*').eq('tenant_id', tid);
  assert.equal(data?.length || 0, 0, 'papel global não lê encomendas privadas');
}
console.log('PASS API: papéis, negação global, autoelevação, trial concorrente, suspensão e privacidade.');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [390,768,1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${APP}/entrar?next=%2Fadmin`);
    await page.getByLabel('E-mail', { exact: true }).fill(users.owner.email);
    await page.getByLabel('Senha', { exact: true }).fill(users.owner.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await page.waitForURL(/\/admin/);
    await page.getByRole('heading', { name: /Administração|Visão geral|Plataforma/ }).first().waitFor({ timeout: 15000 })
      .catch(async (e) => { await page.screenshot({ path: `tests/evidence/platform/falha-${width}.png`, fullPage: true }); throw e; });
    await page.reload();
    await page.getByRole('heading', { name: /Administração|Visão geral|Plataforma/ }).first().waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `sem rolagem horizontal ${width}`);
    assert.deepEqual(errors, [], `sem erro JS ${width}`);
    await page.screenshot({ path: `tests/evidence/platform/overview-${width}.png`, fullPage: true });
    await context.close();
  }
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`${APP}/entrar?next=%2Fadmin`);
  await page.getByLabel('E-mail', { exact: true }).fill(users.outsider.email);
  await page.getByLabel('Senha', { exact: true }).fill(users.outsider.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByText('Acesso restrito à administração da plataforma.').waitFor();
  console.log('PASS navegador: owner em 3 larguras e refresh; conta comum negada.');
} finally { await browser.close(); }
console.log(`Fixtures preservadas: e2e-platform-${stamp}.`);
