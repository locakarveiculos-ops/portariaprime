import { appUrl } from './env.js';
import { HttpError, isUuid, json, readJson } from './http.js';
import { serviceClient } from './supabase.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const TOKEN = /^[0-9a-f]{64}$/;
const CODE = /^[0-9a-f]{40}$/;
const POST_ACTIONS = new Set(['qr', 'password-peek', 'password-set']);
const UNAVAILABLE = 'Não foi possível concluir. Se já enviou sua senha, entre no app ou use a opção recuperar senha.';

export function isResidentBotPageAction(action: string | undefined): boolean {
  return action === 'term' || POST_ACTIONS.has(action || '');
}

function passwordState(data: Record<string, unknown> | null, slug: string) {
  if (!data || data.slug !== slug) return { invalid: true };
  for (const state of ['invalid', 'used', 'expired', 'unavailable']) {
    if (data[state] === true) return { [state]: true };
  }
  if (data.valid !== true || !isUuid(data.user_id)) return { invalid: true };
  return null;
}

/** Public capability endpoints. Never log RPC/Auth errors: they can contain tokens or passwords. */
export async function residentBotPage(request: Request, action: string): Promise<Response> {
  try {
    if (action === 'term') {
      if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405, { Allow: 'GET' });
      const slug = new URL(request.url).searchParams.get('slug');
      if (!slug || !SLUG.test(slug)) throw new HttpError(400, 'Condomínio inválido.');
      const { data, error } = await serviceClient().rpc('privacy_term_current', { p_slug: slug });
      if (error) throw new HttpError(503, 'Termo indisponível. Tente novamente mais tarde.');
      if (!data) throw new HttpError(404, 'Termo ou condomínio não encontrado.');
      return json({ title: data.title, content: data.content, version: data.version, hash: data.hash });
    }
    if (!POST_ACTIONS.has(action)) throw new HttpError(404, 'Ação desconhecida.');
    // GET/HEAD from link preview scanners must never consume a capability.
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
    if (request.headers.get('origin') !== appUrl()) throw new HttpError(403, 'Origem não permitida.');
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, 'Envie JSON.');
    }
    const body = await readJson<Record<string, unknown>>(request, 4096);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Dados inválidos.');
    if (action === 'qr') {
      if (typeof body.c !== 'string' || !CODE.test(body.c)) throw new HttpError(400, 'Link inválido.');
      const { data, error } = await serviceClient().rpc('resident_bot_qr_open', { p_code: body.c });
      if (error) throw new HttpError(503, 'Não foi possível abrir o QR. Peça outro link no WhatsApp ou use o app.');
      for (const state of ['invalid', 'used', 'unavailable']) {
        if (data?.[state] === true) return json({ [state]: true });
      }
      if (!data || typeof data.token !== 'string' || !data.token) throw new HttpError(503, 'QR indisponível. Peça outro link no WhatsApp.');
      return json({ token: data.token, expires_at: data.expires_at, carrier: data.carrier, unit: data.unit, tenant_name: data.tenant_name });
    }
    const { token, slug, password } = body;
    if (typeof token !== 'string' || !TOKEN.test(token) || typeof slug !== 'string' || !SLUG.test(slug)) {
      throw new HttpError(400, 'Link ou condomínio inválido.');
    }
    if (action === 'password-set' && (typeof password !== 'string' || password.length < 6 || password.length > 128)) {
      throw new HttpError(400, 'A senha deve ter entre 6 e 128 caracteres.');
    }
    const client = serviceClient();
    const peek = await client.rpc('resident_password_link_peek', { p_token: token });
    if (peek.error) throw new HttpError(503, UNAVAILABLE);
    const state = passwordState(peek.data, slug);
    if (state) return json(state);
    if (action === 'password-peek') {
      return json({ valid: true, slug, tenant_name: peek.data.tenant_name, expires_at: peek.data.expires_at });
    }
    // Check tenant BEFORE consumption, then trust only the atomic use result for the Auth identity.
    const used = await client.rpc('resident_password_link_use', { p_token: token });
    if (used.error) throw new HttpError(503, UNAVAILABLE);
    const usedState = passwordState(used.data, slug);
    if (usedState) return json(usedState);
    const { error } = await client.auth.admin.updateUserById(used.data.user_id, { password: password as string });
    // Never release, including on timeout: Auth may already have committed the password.
    if (error) throw new HttpError(503, UNAVAILABLE);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof HttpError ? error.message : UNAVAILABLE }, error instanceof HttpError ? error.status : 503);
  }
}
