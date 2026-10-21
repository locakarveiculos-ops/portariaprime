/**
 * Eventos do funil da landing. Visitante = UUID aleatório local, sem nome/e-mail/IP.
 * UTM só de origem/campanha. Deduplicado no servidor por visitante+evento+dia.
 */
export type FunnelEvent = 'landing_view' | 'pricing_view' | 'cta_trial_click' | 'signup_started' | 'signup_completed' | 'trial_started';

function visitor(): string {
  try {
    let v = localStorage.getItem('pp_visitor');
    if (!v) { v = crypto.randomUUID(); localStorage.setItem('pp_visitor', v); }
    return v;
  } catch { return crypto.randomUUID(); }
}

function utm() {
  try {
    const p = new URLSearchParams(location.search);
    const cur = { utm_source: p.get('utm_source'), utm_campaign: p.get('utm_campaign') };
    if (cur.utm_source || cur.utm_campaign) sessionStorage.setItem('pp_utm', JSON.stringify(cur));
    return JSON.parse(sessionStorage.getItem('pp_utm') || '{}');
  } catch { return {}; }
}

export function track(event: FunnelEvent, plan?: string | null) {
  const body = JSON.stringify({ event, visitor: visitor(), plan: plan || null, ...utm() });
  try {
    if (!navigator.sendBeacon?.('/api/funnel', new Blob([body], { type: 'application/json' }))) {
      void fetch('/api/funnel', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
    }
  } catch { /* métrica nunca quebra a página */ }
}
