/**
 * POST /api/billing/checkout  { tenantId }
 * Gestor com permissão de faturamento gera (ou reaproveita) o link de pagamento
 * do pedido aberto. Preço, plano e período vêm do banco — nada do navegador.
 * Durante o mês grátis a RPC recusa (não há cobrança antecipada).
 *
 * Só uma chamada por vez cria link no provedor (claim_checkout_link). Timeout é
 * resultado ambíguo: o link pode existir na InfinitePay, então não há nova
 * tentativa automática — fica para conferência do suporte.
 */
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';
import { appUrl } from '../_lib/env.js';
import { createCheckoutLink, ProviderError } from '../_lib/infinitepay.js';

const BUSY: Record<string, string> = {
  in_progress: 'O link de pagamento está sendo gerado. Aguarde alguns segundos e tente de novo.',
  ambiguous: 'Não conseguimos confirmar a criação do link de pagamento. Nossa equipe vai conferir; tente novamente mais tarde ou fale com o suporte.',
  not_open: 'Este pedido não está mais aberto para pagamento. Atualize a página.',
};

export const POST = handler(async (request) => {
  const { tenantId } = await readJson(request, 2048);
  if (!isUuid(tenantId)) throw new HttpError(400, 'Condomínio inválido.');
  const { client, user } = await requireUser(request);

  // Clientes com proposta vinculada usam prepare_proposal_billing; clientes comuns
  // preservam prepare_checkout idêntico (a RPC faz o chaveamento no servidor).
  const { data: order, error } = await client.rpc('prepare_proposal_billing', { p_tenant: tenantId });
  if (error) rpcError(error);

  // Configuração ausente não deve consumir uma tentativa externa.
  const base = appUrl();
  const svc = serviceClient();
  const attempt = crypto.randomUUID();
  const { data: claim, error: claimError } = await svc.rpc('claim_checkout_link', { p_order: order.order_id, p_attempt: attempt });
  if (claimError) throw new Error(claimError.message);
  if (!claim.claimed) {
    if (claim.reason === 'ready' && claim.checkout_url) return json({ orderId: order.order_id, checkoutUrl: claim.checkout_url, reused: true });
    return json({ orderId: order.order_id, error: BUSY[claim.reason] || 'Tente novamente em instantes.' }, 409);
  }

  const finish = async (state: 'ready' | 'failed' | 'ambiguous', url: string | null = null) => {
    const { data: ok, error: e } = await svc.rpc('finish_checkout_link', { p_order: order.order_id, p_attempt: attempt, p_url: url, p_state: state });
    if (e || ok !== true) throw new Error(`Falha ao registrar link (${state}): ${e?.message || 'tentativa substituída'}`);
  };

  let url: string;
  try {
    url = await createCheckoutLink({
      orderNsu: order.order_nsu,
      amountCents: order.amount_cents,
      description: order.description,
      redirectUrl: `${base}/checkout/retorno?pedido=${order.order_id}`,
      webhookUrl: `${base}/api/webhooks/infinitepay`,
      customer: user.email ? { email: user.email } : undefined,
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      await finish(e.ambiguous ? 'ambiguous' : 'failed');
      return json({ orderId: order.order_id, error: e.ambiguous ? BUSY.ambiguous : e.message }, 502);
    }
    await finish('ambiguous');
    throw e;
  }
  // Link criado no provedor: falha ao gravar não pode virar "tente de novo" (geraria link duplicado).
  await finish('ready', url);
  return json({ orderId: order.order_id, checkoutUrl: url, reused: false });
});
