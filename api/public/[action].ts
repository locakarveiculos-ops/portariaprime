/**
 * Rotas públicas (sem sessão), uma única função na Vercel:
 *   POST /api/contact  -> contato comercial (honeypot + limite por IP)
 *   POST /api/funnel   -> funil anônimo da landing
 *   POST /api/quote    -> "Tenho um orçamento para comparar" (multipart, anexo validado por bytes)
 *   POST /api/plan-request -> pedido de contratação da página /planos (não é aceite contratual)
 *   POST /api/public/kiosk-pilot -> solicitação de ativação piloto do Modo Portaria Exclusiva
 * vercel.json reescreve /api/contact, /api/funnel e /api/quote para cá com ?a=; kiosk-pilot usa a rota do arquivo.
 * Novas ações públicas entram aqui (arquivos com "_" não viram rota).
 */
import { handler, HttpError } from '../_lib/http.js';
import { POST as contact } from './_contact.js';
import { POST as funnel } from './_funnel.js';
import { POST as quote } from './_quote.js';
import { POST as planRequest } from './_plan_request.js';
import { POST as kioskPilot } from './_kiosk_pilot.js';

const ACTIONS: Record<string, (r: Request) => Promise<Response>> = { contact, funnel, quote, 'plan-request': planRequest, 'kiosk-pilot': kioskPilot };

export const POST = handler(async (request) => {
  const url = new URL(request.url);
  const action = url.searchParams.get('a') || url.pathname.split('/').pop() || '';
  const fn = ACTIONS[action];
  if (!fn) throw new HttpError(404, 'Ação desconhecida.');
  return fn(request);
});
