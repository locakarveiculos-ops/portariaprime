import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as tick } from '../../api/jobs/tick.ts';
import { sendWhatsAppVideo } from '../../api/_lib/channels.ts';

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', CRON_SECRET: 'cron', APP_URL: 'https://portariaprime.com.br',
  EVOLUTION_API_URL: 'https://evo.test', EVOLUTION_API_KEY: 'key' };
async function run({ event = 'resident_training', approved = true, authorized = true, state = 'open', mediaStatus = 200, timeout = false, platform = false } = {}) {
  const saved = { ...process.env }, original = globalThis.fetch;
  Object.assign(process.env, ENV); delete process.env.PLATFORM_WHATSAPP_INSTANCE;
  if (platform) process.env.PLATFORM_WHATSAPP_INSTANCE = 'central';
  const calls = [], media = [], texts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), b = init.body ? JSON.parse(init.body) : {};
    if (u.includes('/instance/connectionState/')) return Response.json({ instance: { state } });
    if (u.includes('/message/sendMedia/')) {
      media.push({ url: u, body: b });
      if (timeout) throw new DOMException('timeout', 'TimeoutError');
      return Response.json({ key: { id: 'video-id' } }, { status: mediaStatus });
    }
    if (u.includes('/message/sendText/')) { texts.push(b); return Response.json({ key: { id: 'text-id' } }); }
    const fn = u.split('/rpc/')[1]; calls.push([fn, b]);
    if (fn === 'claim_notification_jobs') return Response.json([{ id: 'job', tenant_id: 'tenant', channel: 'whatsapp', event, recipient: '5511988887777', payload: { approved } }]);
    if (fn === 'notification_is_authorized') return Response.json(authorized);
    if (fn === 'notification_context') return Response.json({ tenant_name: 'Condomínio A', tenant_slug: 'cond-a', resident: { name: 'Ana' }, whatsapp: { enabled: !platform, instance: platform ? null : 'pp-cond-a' } });
    if (fn === 'consume_whatsapp') return Response.json(true);
    if (fn === 'defer_notification_job') return Response.json('waiting');
    if (fn === 'claim_payment_events') return Response.json([]);
    return Response.json(null);
  };
  try { const r = await tick(new Request('https://portariaprime.com.br/api/jobs/tick', { headers: { authorization: 'Bearer cron' } })); return { status: r.status, calls, media, texts }; }
  finally { process.env = saved; globalThis.fetch = original; }
}
const complete = (r) => r.calls.find(([f]) => f === 'complete_notification_job')?.[1];

test('treinamento é vídeo por URL fixa, com legenda e franquia própria', async () => {
  const r = await run();
  assert.equal(r.status, 200); assert.equal(r.media.length, 1); assert.equal(r.texts.length, 0);
  assert.equal(r.media[0].url, 'https://evo.test/message/sendMedia/pp-cond-a');
  assert.equal(r.media[0].body.mediatype, 'video'); assert.equal(r.media[0].body.mimetype, 'video/mp4');
  assert.equal(r.media[0].body.media, 'https://portariaprime.com.br/video/treinamento-moradores.mp4');
  assert.match(r.media[0].body.caption, /Condomínio A/);
  assert.equal(r.calls.filter(([f]) => f === 'consume_whatsapp').length, 1);
  assert.equal(complete(r).p_provider_ref, 'video-id');
});
test('boas-vindas e recusa continuam sendo texto, sem vídeo imediato duplicado', async () => {
  for (const approved of [true, false]) {
    const r = await run({ event: 'access_decision', approved });
    assert.equal(r.texts.length, 1); assert.equal(r.media.length, 0);
  }
});
test('treinamento sem autorização não é enviado', async () => {
  const r = await run({ authorized: false }); assert.equal(r.media.length, 0); assert.equal(complete(r).p_status, 'disabled');
});
test('treinamento aguarda reconexão; não gasta franquia desconectado', async () => {
  const r = await run({ state: 'close' }); assert.equal(r.media.length, 0);
  assert.ok(r.calls.some(([f]) => f === 'defer_notification_job'));
  assert.ok(!r.calls.some(([f]) => f === 'consume_whatsapp'));
});
test('canal central também envia treinamento como vídeo', async () => {
  const r = await run({ platform: true }); assert.equal(r.media.length, 1);
  assert.equal(r.media[0].url, 'https://evo.test/message/sendMedia/central');
});
test('falha ou timeout do vídeo afeta só o job do treinamento', async () => {
  for (const opts of [{ mediaStatus: 502 }, { timeout: true }]) {
    const r = await run(opts); assert.equal(r.texts.length, 0); assert.equal(complete(r).p_status, 'failed');
    if (opts.timeout) assert.match(complete(r).p_error, /^ambiguous:/);
  }
});
test('vídeo sem configuração não finge envio', async () => {
  const saved = { ...process.env }; delete process.env.EVOLUTION_API_URL; delete process.env.EVOLUTION_API_KEY;
  try { assert.equal((await sendWhatsAppVideo('x', '11988887777', 'https://site.invalid/video.mp4', 'x', 'x.mp4')).status, 'disabled'); }
  finally { process.env = saved; }
});
