// api(): 401 renova a sessão uma vez; sessão encerrada no Auth sai só deste aparelho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callApi } from '../src/lib/call-api.ts';

test('401 renova e repete; sessão encerrada sai localmente com mensagem clara', async () => {
  const calls = { signOut: [] };
  let refresh = { data: { session: { access_token: 'novo' } }, error: null };
  const auth = {
    getSession: async () => ({ data: { session: { access_token: 'velho' } } }),
    refreshSession: async () => refresh,
    signOut: async (o) => { calls.signOut.push(o); return { error: null }; },
  };
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    seen.push(init.headers.Authorization);
    return init.headers.Authorization === 'Bearer novo' ? Response.json({ ok: true }) : Response.json({ error: 'Sessão inválida' }, { status: 401 });
  };
  assert.deepEqual(await callApi(auth, '/api/x', {}), { ok: true });
  assert.deepEqual(seen, ['Bearer velho', 'Bearer novo']);
  refresh = { data: { session: null }, error: new Error('revoked') };
  await assert.rejects(callApi(auth, '/api/x', {}), /sessão foi encerrada/);
  assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
  // 403 não dispara renovação nem logout.
  globalThis.fetch = async () => Response.json({ error: 'Sem permissão' }, { status: 403 });
  await assert.rejects(callApi(auth, '/api/x', {}), /Sem permissão/);
  assert.equal(calls.signOut.length, 1);
});
