/**
 * POST /api/funnel  { event, visitor, plan?, utm_source?, utm_campaign? }
 * Funil da landing sem dados pessoais: visitante é um UUID aleatório do navegador.
 * Repetição do mesmo evento pelo mesmo visitante no mesmo dia é ignorada (unique).
 * Falha de gravação não quebra a página: responde 204 mesmo assim.
 */
import { handler, readJson } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';

const EVENTS = new Set(['landing_view', 'pricing_view', 'cta_trial_click', 'signup_started', 'signup_completed', 'trial_started']);
const tag = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : null);

export const POST = handler(async (request) => {
  const b = await readJson(request, 1024).catch(() => ({}));
  const event = typeof b.event === 'string' && EVENTS.has(b.event) ? b.event : null;
  const visitor = tag(b.visitor, /^[a-f0-9-]{36}$/);
  if (event && visitor) {
    const { error } = await serviceClient().from('funnel_events').upsert({
      event, visitor, plan: tag(b.plan, /^[a-z-]{2,30}$/),
      utm_source: tag(b.utm_source, /^[A-Za-z0-9._-]{1,60}$/), utm_campaign: tag(b.utm_campaign, /^[A-Za-z0-9._-]{1,60}$/),
    }, { onConflict: 'visitor,event,day', ignoreDuplicates: true });
    if (error) console.error('[funnel] falha ao gravar', error.code);
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
});
