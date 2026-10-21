import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { POST } from '../../api/platform/users.ts';

const userId = '11111111-1111-4111-8111-111111111111';
const request = (token, extra = {}) => new Request('http://localhost/api/platform/users', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ action: 'password_reset', userId, reason: 'Recuperação solicitada pelo usuário', ...extra }),
});

test('recuperação administrativa usa Auth oficial, autorização persistente e não expõe token', async () => {
  let allowed = false, sent = 0, cooldown = false, fail = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/v1/user') return res.end(JSON.stringify({ id: userId, email: 'operator@example.invalid' }));
    if (req.url === '/rest/v1/rpc/platform_authorize_user_action') {
      assert.equal(body.p_user, userId);
      assert.equal(body.p_action, 'password_reset');
      if (!allowed || cooldown) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ code: !allowed ? '42501' : 'P0001', message: !allowed ? 'Acesso negado.' : 'Aguarde cinco minutos.' }));
      }
      cooldown = true;
      return res.end(JSON.stringify({ email: 'target@example.invalid' }));
    }
    if (req.url.startsWith('/auth/v1/recover')) {
      sent++;
      assert.equal(body.email, 'target@example.invalid');
      assert.match(req.url, /redirect_to=http%3A%2F%2F127.0.0.1%3A3017%2Fnova-senha/);
      res.statusCode = fail ? 429 : 200;
      return res.end(JSON.stringify(fail ? { msg: 'rate limited' } : {}));
    }
    res.statusCode = 404; res.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY, APP_URL: process.env.APP_URL };
  Object.assign(process.env, { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_ANON_KEY: 'public-test', APP_URL: 'http://127.0.0.1:3017' });
  try {
    assert.equal((await POST(request(null))).status, 401);
    assert.equal((await POST(request('fixture'))).status, 403);
    assert.equal(sent, 0);
    allowed = true;
    assert.equal((await POST(request('fixture', { userId: 'bad' }))).status, 400);
    assert.equal((await POST(request('fixture', { reason: 'curto' }))).status, 400);
    const ok = await POST(request('fixture'));
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(await ok.json()).sort(), ['message', 'ok']);
    assert.equal(sent, 1);
    assert.equal((await POST(request('fixture'))).status, 409);
    assert.equal(sent, 1, 'cooldown impede segundo envio');
    cooldown = false; fail = true;
    assert.equal((await POST(request('fixture'))).status, 429);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
