import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as portal from '../../api/portal/[action].ts';

const origin = 'https://app.example';
const token = 'a'.repeat(64), code = 'b'.repeat(40);
const valid = { valid: true, slug: 'cond-a', tenant_name: 'Condomínio A', email: 'private@example.test', user_id: '11111111-1111-4111-8111-111111111111', expires_at: '2099-01-01T00:00:00Z' };
const qr = { token: 'pickup-secret', expires_at: valid.expires_at, carrier: 'Correios', unit: '101', tenant_name: valid.tenant_name };

async function boundary(t, replies = {}) {
  const saved = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { APP_URL: origin, SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_ROLE_KEY: 'test-service' });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.origin, 'https://sb.example');
    const name = u.pathname.split('/').pop();
    calls.push({ name, method: init.method, body: JSON.parse(init.body) });
    const reply = replies[name] ?? (name === 'resident_bot_qr_open' ? qr : name.startsWith('resident_password_link_') ? valid : { user: { id: valid.user_id } });
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply : Response.json(typeof reply === 'function' ? await reply() : reply);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of ['APP_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  return calls;
}
function post(action, body, headers = {}) {
  return portal.POST(new Request(`${origin}/api/portal/${action}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
}
function noCache(response) { assert.match(response.headers.get('cache-control'), /no-store/); }

test('QR GET never consumes, POST exchanges only hex40 with no cache', async t => {
  const calls = await boundary(t);
  const get = await portal.GET(new Request(`${origin}/api/portal/qr?c=${code}`));
  assert.equal(get.status, 405); noCache(get); assert.equal(calls.length, 0);
  const response = await post('qr', { c: code });
  assert.equal(response.status, 200); noCache(response);
  assert.deepEqual(await response.json(), qr);
  assert.deepEqual(calls, [{ name: 'resident_bot_qr_open', method: 'POST', body: { p_code: code } }]);
});
for (const state of ['invalid', 'used', 'unavailable']) test(`QR ${state} does not expose token`, async t => {
  await boundary(t, { resident_bot_qr_open: { [state]: true, token: 'must-not-leak' } });
  const response = await post('qr', { c: code }); noCache(response);
  assert.deepEqual(await response.json(), { [state]: true });
});

test('invalid bodies, origins, types and lengths fail before RPC', async t => {
  const calls = await boundary(t);
  for (const [action, body, headers, status] of [
    ['qr', { c: code }, { origin: 'https://evil.example' }, 403],
    ['qr', { c: code }, { origin: '' }, 403],
    ['qr', { c: code }, { origin: 'null' }, 403],
    ['qr', { c: code }, { 'content-type': 'text/plain' }, 415],
    ['qr', { c: 'B'.repeat(40) }, {}, 400],
    ['qr', { c: `${code}0` }, {}, 400],
    ['qr', { c: [code] }, {}, 400],
    ['qr', 'null', {}, 400], ['qr', '[]', {}, 400], ['qr', '{', {}, 400],
    ['qr', JSON.stringify({ c: code, padding: 'x'.repeat(5000) }), {}, 413],
    ['password-peek', { token }, {}, 400],
    ['password-peek', { token: 'A'.repeat(64), slug: 'cond-a' }, {}, 400],
    ['password-set', { token, slug: 'cond-a', password: 'short' }, {}, 400],
    ['password-set', { token, slug: 'cond-a', password: 'x'.repeat(129) }, {}, 400],
  ]) {
    const response = await post(action, body, headers);
    assert.equal(response.status, status, `${action}: ${status}`); noCache(response);
  }
  assert.equal(calls.length, 0);
});

test('password peek exposes only public metadata; never consumes', async t => {
  const calls = await boundary(t);
  const response = await post('password-peek', { token, slug: 'cond-a' }); noCache(response);
  assert.deepEqual(await response.json(), { valid: true, slug: valid.slug, tenant_name: valid.tenant_name, expires_at: valid.expires_at });
  assert.deepEqual(calls.map(c => c.name), ['resident_password_link_peek']);
});
for (const action of ['password-peek', 'password-set']) test(`${action} wrong slug fails before consumption`, async t => {
  const calls = await boundary(t);
  const response = await post(action, { token, slug: 'cond-b', password: 'secret123' });
  assert.deepEqual(await response.json(), { invalid: true });
  assert.deepEqual(calls.map(c => c.name), ['resident_password_link_peek']);
});
for (const state of ['invalid', 'used', 'expired', 'unavailable']) test(`password ${state} never updates Auth`, async t => {
  const calls = await boundary(t, { resident_password_link_peek: { [state]: true, slug: 'cond-a', email: valid.email, user_id: valid.user_id } });
  const response = await post('password-set', { token, slug: 'cond-a', password: 'secret123' });
  assert.deepEqual(await response.json(), { [state]: true });
  assert.equal(calls.length, 1);
});
test('password update follows atomic use; ignores supplied user_id', async t => {
  const calls = await boundary(t);
  const response = await post('password-set', { token, slug: 'cond-a', password: 'secret123', user_id: 'attacker' });
  assert.deepEqual(await response.json(), { ok: true }); noCache(response);
  assert.deepEqual(calls.map(c => c.name), ['resident_password_link_peek', 'resident_password_link_use', valid.user_id]);
  assert.deepEqual(calls[1].body, { p_token: token });
  assert.equal(calls[2].method, 'PUT'); assert.deepEqual(calls[2].body, { password: 'secret123' });
});
test('lost race at atomic use does not update Auth', async t => {
  const calls = await boundary(t, { resident_password_link_use: { used: true, slug: 'cond-a' } });
  assert.deepEqual(await (await post('password-set', { token, slug: 'cond-a', password: 'secret123' })).json(), { used: true });
  assert.equal(calls.length, 2);
});
test('concurrent requests update Auth once', async t => {
  let consumed = false;
  const calls = await boundary(t, { resident_password_link_use: () => {
    if (consumed) return { used: true, slug: 'cond-a' };
    consumed = true; return valid;
  } });
  const results = await Promise.all([post('password-set', { token, slug: 'cond-a', password: 'secret123' }), post('password-set', { token, slug: 'cond-a', password: 'secret456' })]);
  const bodies = await Promise.all(results.map(r => r.json()));
  assert.equal(bodies.filter(b => b.ok).length, 1);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 1);
});
for (const failure of ['resident_password_link_use', valid.user_id]) test(`ambiguous failure at ${failure} never releases token or logs secrets`, async t => {
  const calls = await boundary(t, { [failure]: new Error(`network ${token} secret123`) });
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
  const response = await post('password-set', { token, slug: 'cond-a', password: 'secret123' });
  assert.equal(response.status, 503); noCache(response);
  const text = await response.text(); assert.match(text, /recuperar senha/i);
  assert.doesNotMatch(text + JSON.stringify(logs), new RegExp(`${token}|secret123|${valid.email}`));
  assert.equal(calls.some(c => c.name.includes('release')), false);
});
test('public privacy term comes from slug RPC; strips internal fields', async t => {
  const term = { title: 'Termo', content: '<script>alert(1)</script>\nTexto', version: '1', hash: 'hash', template_hash: 'private' };
  const calls = await boundary(t, { privacy_term_current: term });
  const response = await portal.GET(new Request(`${origin}/api/portal/term?slug=cond-a`));
  assert.equal(response.status, 200); noCache(response);
  assert.deepEqual(await response.json(), { title: term.title, content: term.content, version: term.version, hash: term.hash });
  assert.deepEqual(calls[0].body, { p_slug: 'cond-a' });
});
test('public routes precede login; sensitive pages do not persist or render HTML', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../../src/pages/ResidentBotPages.tsx', import.meta.url), 'utf8');
  assert.ok(app.indexOf("path === '/qr'") < app.indexOf('if (loading)'));
  assert.ok(app.indexOf('termo-dados') < app.indexOf('if (loading)'));
  assert.ok(app.indexOf('criar-senha') < app.indexOf('if (loading)'));
  assert.doesNotMatch(page, /localStorage|sessionStorage|dangerouslySetInnerHTML|console\./);
  assert.match(page, /location\.hash/); assert.match(page, /replaceState/);
  assert.match(page, /QRCodeDisplay/); assert.match(page, /onClick=\{openQr\}/);
  assert.match(page, /maxLength=\{128\}/); assert.match(page, /password !== confirmation/);
});
