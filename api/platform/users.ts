import { appUrl } from '../_lib/env.js';
import { handler, HttpError, isUuid, json, readJson } from '../_lib/http.js';
import { requireUser, rpcError } from '../_lib/supabase.js';

/** Recuperação oficial: nunca gera nem devolve links/tokens administrativos. */
export const POST = handler(async (request) => {
  const { client } = await requireUser(request);
  const b = await readJson(request, 4096);
  if (!b || b.action !== 'password_reset' || !isUuid(b.userId)
      || typeof b.reason !== 'string' || b.reason.trim().length < 10 || b.reason.length > 1000) {
    throw new HttpError(400, 'Informe usuário e justificativa de 10 a 1000 caracteres.');
  }
  const redirectTo = `${appUrl()}/nova-senha`;
  // A RPC verifica papel, vínculo global ativo, MFA quando configurado, cooldown e audita a solicitação.
  const { data, error } = await client.rpc('platform_authorize_user_action', {
    p_action: 'password_reset', p_user: b.userId, p_reason: b.reason.trim(),
  });
  if (error) rpcError(error);
  if (!data?.email) throw new HttpError(409, 'Conta sem endereço disponível para recuperação.');
  const { error: sendError } = await client.auth.resetPasswordForEmail(data.email, { redirectTo });
  if (sendError) {
    console.error('[platform.password_reset]', sendError.status || 'provider_error');
    throw new HttpError(sendError.status === 429 ? 429 : 502, 'O provedor não confirmou o envio. Aguarde e tente novamente; nenhuma senha foi alterada.');
  }
  return json({ ok: true, message: 'Solicitação aceita pelo provedor. A entrega do e-mail depende do canal configurado.' });
});
