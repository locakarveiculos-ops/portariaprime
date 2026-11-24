// Webhook das conversas (Evolution -> Portaria Prime): segredo por instância conferido antes de tudo, só eventos de
// mensagem, só conversas individuais, sem duplicar; falha de gravação pede nova tentativa (500).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../../api/webhooks/infinitepay.ts';
import { chatRow } from '../../api/_lib/whatsapp-chat.ts';

const T = '11111111-2222-4333-8444-555555555555';
const SECRET = 'b'.repeat(64);
const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
const msg = (id, extra = {}) => ({ key: { id, remoteJid: '123456789012345@lid', fromMe: false, remoteJidAlt: '5511988887777@s.whatsapp.net' },
  pushName: 'Ana', messageType: 'conversation', message: { conversation: 'oi, chegou?' }, messageTimestamp: 1795600000, ...extra });

async function hit(body, { secret = SECRET, hook = { tenant_id: T, secret: SECRET }, failStore = false } = {}) {
  const saved = { ...process.env }; Object.assign(process.env, ENV);
  const fetch0 = globalThis.fetch; const log = { stored: [], lookups: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/whatsapp_chat_hooks')) { log.lookups++; return Response.json(hook ? [hook] : []); }
    if (u.includes('/rest/v1/whatsapp_chat_messages')) {
      if (failStore) return Response.json({ message: 'down' }, { status: 503 });
      log.stored.push(...[].concat(JSON.parse(init.body))); return new Response(null, { status: 201 });
    }
    return Response.json({});
  };
  try {
    const r = await POST(new Request('https://portariaprime.com.br/api/webhooks/infinitepay?a=evolution-chat', { method: 'POST',
      headers: secret ? { 'x-pp-secret': secret } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) }));
    return { status: r.status, json: await r.json(), ...log };
  } finally { globalThis.fetch = fetch0; process.env = saved; }
}

test('mensagem recebida é guardada no condomínio da instância, com o número real', async () => {
  const r = await hit({ event: 'messages.upsert', instance: 'pp-11111111-5555', data: msg('3EB0AAAA1111') });
  assert.equal(r.status, 200);
  assert.equal(r.stored.length, 1);
  const s = r.stored[0];
  assert.deepEqual([s.tenant_id, s.id, s.jid, s.alt_jid, s.from_me, s.text, s.push_name],
    [T, '3EB0AAAA1111', '123456789012345@lid', '5511988887777@s.whatsapp.net', false, 'oi, chegou?', 'Ana']);
});

test('enviada pelo celular do condomínio (SEND_MESSAGE) também entra', async () => {
  const r = await hit({ event: 'send.message', instance: 'pp-11111111-5555',
    data: msg('3EB0BBBB2222', { key: { id: '3EB0BBBB2222', remoteJid: '123456789012345@lid', fromMe: true } }) });
  assert.equal(r.stored[0].from_me, true);
  assert.equal(r.stored[0].push_name, null, 'nome só de quem escreve para o condomínio');
});

test('segredo errado, ausente ou instância sem cadastro: 401 sem gravar', async () => {
  for (const secret of ['c'.repeat(64), null]) {
    const r = await hit({ event: 'messages.upsert', instance: 'pp-11111111-5555', data: msg('3EB0CCCC3333') }, { secret });
    assert.equal(r.status, 401); assert.equal(r.stored.length, 0);
  }
  const semHook = await hit({ event: 'messages.upsert', instance: 'pp-11111111-5555', data: msg('3EB0CCCC3334') }, { hook: null });
  assert.equal(semHook.status, 401);
});

test('instância fora do padrão do Portaria Prime é ignorada sem consultar o banco', async () => {
  const r = await hit({ event: 'messages.upsert', instance: 'Tubarao', data: msg('3EB0DDDD4444') });
  assert.deepEqual(r.json, { ok: true, ignored: 'instance' }); assert.equal(r.lookups, 0);
});

test('outros eventos, grupos, reações e mensagens vazias não são guardados', async () => {
  assert.deepEqual((await hit({ event: 'connection.update', instance: 'pp-11111111-5555', data: {} })).json, { ok: true, ignored: 'event' });
  const r = await hit({ event: 'messages.upsert', instance: 'pp-11111111-5555', data: [
    msg('3EB0EEEE5555', { key: { id: '3EB0EEEE5555', remoteJid: '120363000000000000@g.us', fromMe: false } }),
    msg('3EB0EEEE6666', { messageType: 'reactionMessage', message: { reactionMessage: { text: '👍' } } }),
    msg('3EB0EEEE7777', { messageType: 'conversation', message: {} }),
  ] });
  assert.equal(r.stored.length, 0);
});

test('falha ao gravar devolve 500 para a Evolution tentar de novo; corpo inválido 400', async () => {
  assert.equal((await hit({ event: 'messages.upsert', instance: 'pp-11111111-5555', data: msg('3EB0FFFF8888') }, { failStore: true })).status, 500);
  assert.equal((await hit('isto nao e json')).status, 400);
});

test('chatRow: mídia com legenda e documento com nome', () => {
  const img = chatRow(T, { key: { id: '3EB0IMG00001', remoteJid: '5511988887777@s.whatsapp.net', fromMe: false }, messageType: 'imageMessage',
    message: { imageMessage: { caption: 'foto da caixa' } }, messageTimestamp: 1795600000 });
  assert.deepEqual([img.media, img.text], ['image', 'foto da caixa']);
  const doc = chatRow(T, { key: { id: '3EB0DOC00001', remoteJid: '5511988887777@s.whatsapp.net', fromMe: true }, messageType: 'documentMessage',
    message: { documentMessage: { fileName: 'boleto.pdf' } }, messageTimestamp: 1795600000 });
  assert.deepEqual([doc.media, doc.file_name], ['document', 'boleto.pdf']);
});
