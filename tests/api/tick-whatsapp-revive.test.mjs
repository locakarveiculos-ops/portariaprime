// Fila de avisos: WhatsApp do condomínio marcado como desligado no banco, mas a instância já está "open" na Evolution
// (o síndico reconectou e não tocou em "Verificar conexão"). O worker confere, religa a integração e envia,
// em vez de adiar o aviso até vencer. Desconectado de verdade continua esperando. Supabase e Evolution simulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as tick } from '../../api/jobs/tick.ts';

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', CRON_SECRET: 'c'.repeat(40),
  APP_URL: 'https://portariaprime.com.br', EVOLUTION_API_URL: 'https://evo.test', EVOLUTION_API_KEY: 'k' };
const job = (id, event = 'package_received') => ({ id, tenant_id: 'T1', event, channel: 'whatsapp', recipient: '5511988887777', ref_id: 'P1', payload: { package_id: 'P1' } });
const ctx = { tenant: { name: 'Cond A', timezone: 'America/Sao_Paulo' }, unit: { label: '101' }, package: { carrier: 'Shopee', ref: 'A1B2C3' },
  whatsapp: { instance: 'pp-11111111-aaaa', enabled: false } };

async function run(evoState, event = 'package_received') {
  const saved = { ...process.env }; Object.assign(process.env, ENV);
  const fetch0 = globalThis.fetch; const log = { rpc: [], sent: [], states: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); const body = init.body ? JSON.parse(init.body) : {};
    if (u.startsWith('https://evo.test/instance/connectionState/')) { log.states++; return Response.json({ instance: { state: evoState } }); }
    if (u.startsWith('https://evo.test/message/sendText/')) { log.sent.push({ inst: u.split('/').pop(), ...body }); return Response.json({ key: { id: 'WA1' } }); }
    const m = /\/rpc\/([a-z_]+)$/.exec(u);
    if (m) {
      log.rpc.push([m[1], body]);
      if (m[1] === 'claim_notification_jobs') return Response.json([job('J1', event), job('J2', event)]);
      if (m[1] === 'notification_is_authorized') return Response.json(true);
      if (m[1] === 'notification_context') return Response.json(structuredClone(ctx));
      if (m[1] === 'consume_whatsapp') return Response.json(true);
      if (m[1] === 'defer_notification_job') return Response.json('waiting');
      if (m[1] === 'claim_payment_events') return Response.json([]);
      return Response.json(null);
    }
    return Response.json([]);
  };
  try {
    const r = await tick(new Request('https://portariaprime.com.br/api/jobs/tick', { headers: { authorization: `Bearer ${'c'.repeat(40)}` } }));
    return { status: r.status, ...log };
  } finally { globalThis.fetch = fetch0; process.env = saved; }
}
const calls = (log, fn) => log.rpc.filter(([f]) => f === fn).map(([, a]) => a);

test('instância já reconectada: religa a integração uma vez e envia os avisos parados', async () => {
  const r = await run('open');
  assert.equal(r.status, 200);
  assert.deepEqual(calls(r, 'set_whatsapp_instance'), [{ p_tenant: 'T1', p_instance: 'pp-11111111-aaaa', p_enabled: true }]);
  assert.equal(r.states, 1, 'consulta a Evolution uma vez por instância na rodada');
  assert.deepEqual(r.sent.map((s) => [s.inst, s.number]), [['pp-11111111-aaaa', '5511988887777'], ['pp-11111111-aaaa', '5511988887777']]);
  assert.equal(calls(r, 'defer_notification_job').length, 0, 'nada fica esperando');
  assert.deepEqual(calls(r, 'complete_notification_job').map((c) => c.p_status), ['accepted', 'accepted']);
});

test('desconectado de verdade: continua esperando na fila, sem enviar nem religar', async () => {
  const r = await run('close');
  assert.equal(calls(r, 'set_whatsapp_instance').length, 0);
  assert.equal(r.sent.length, 0);
  assert.equal(calls(r, 'defer_notification_job').length, 2);
  assert.equal(r.states, 1);
});

test('aviso do cadastro (access_received) também sai pelo WhatsApp do condomínio quando a instância voltou', async () => {
  const r = await run('open', 'access_received');
  assert.deepEqual(calls(r, 'set_whatsapp_instance').map((c) => c.p_enabled), [true]);
  assert.ok(r.sent.length >= 1 && r.sent.every((s) => s.inst === 'pp-11111111-aaaa'), 'enviado pela instância do condomínio');
  assert.equal(calls(r, 'defer_notification_job').length, 0);
});
