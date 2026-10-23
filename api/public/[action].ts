/**
 * Rotas públicas (sem sessão), uma única função na Vercel:
 *   POST /api/contact  -> contato comercial (honeypot + limite por IP)
 *   POST /api/funnel   -> funil anônimo da landing
 * vercel.json reescreve /api/contact e /api/funnel para cá com ?a=.
 * Novas ações públicas entram aqui (arquivos com "_" não viram rota).
 */
import { handler, HttpError } from '../_lib/http.js';
import { POST as contact } from './_contact.js';
import { POST as funnel } from './_funnel.js';

const ACTIONS: Record<string, (r: Request) => Promise<Response>> = { contact, funnel };

export const POST = handler(async (request) => {
  const url = new URL(request.url);
  const action = url.searchParams.get('a') || url.pathname.split('/').pop() || '';
  const fn = ACTIONS[action];
  if (!fn) throw new HttpError(404, 'Ação desconhecida.');
  return fn(request);
});
