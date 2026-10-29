/**
 * POST /api/public/kiosk-pilot — "Solicitar ativação piloto" do Modo Portaria Exclusiva (página pública).
 * Grava em contact_requests (source 'quiosque:piloto', status inicial 'novo'); o Admin Master acompanha em
 * Contatos e suporte (condomínio, marca, modelo e Android visíveis; e-mail/telefone mascarados).
 * Leitura só por superadmin (RLS de contact_requests). Não ativa nada: a liberação depende de validação
 * de compatibilidade feita pela equipe. Honeypot "website"; limite de 3 envios por IP/hora (hash do IP);
 * reenvio idêntico em 30 min devolve o protocolo já gravado. Só confirma depois que o banco gravou.
 */
import { handler, json, readJson, HttpError, sha256Hex } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';

const ANDROID = new Set(['8', '9', '10', '11', '12', '13', '14', '15', '16', 'nao-sei']);
const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');

export const POST = handler(async (request) => {
  const b = await readJson(request, 8192);
  if (b.website) return json({ ok: true, protocol: null }); // honeypot
  const s = (v: unknown, min: number, max: number) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim().replace(/\s+/g, ' ') : null);
  const condo = s(b.condoName, 2, 200), name = s(b.name, 2, 120), role = s(b.role, 2, 80), email = s(b.email, 5, 200);
  const brand = s(b.brand, 2, 60), model = s(b.model, 1, 80), notes = typeof b.notes === 'string' ? b.notes.trim().slice(0, 500) : '';
  const android = typeof b.android === 'string' && ANDROID.has(b.android) ? b.android : null;
  const devices = Number.isInteger(b.devices) && b.devices >= 1 && b.devices <= 20 ? b.devices : null;
  const phone = digits(b.phone);
  if (!condo || !name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !brand || !model || !android || !devices) {
    throw new HttpError(400, 'Preencha condomínio, seu nome, e-mail válido, marca, modelo, versão do Android e quantidade (1 a 20).');
  }
  if (phone && (phone.length < 10 || phone.length > 13)) throw new HttpError(400, 'Telefone com DDD, 10 a 13 dígitos.');
  if (b.dedicated !== true) throw new HttpError(400, 'Confirme que o aparelho é do condomínio e será dedicado à portaria.');

  const svc = serviceClient();
  // Reenvio da mesma solicitação (mesmo e-mail + condomínio + marca + modelo em 30 min): devolve o protocolo
  // existente em vez de criar outra linha. Busca só pelo e-mail informado: nunca expõe pedido de outra pessoa.
  const condoLine = `Condomínio: ${condo}.`.toLowerCase(), deviceLine = `Aparelho: ${brand} ${model} ·`.toLowerCase();
  const { data: recentRows, error: dupError } = await svc.from('contact_requests').select('message')
    .eq('source', 'quiosque:piloto').eq('email', email.toLowerCase())
    .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString()).order('created_at', { ascending: false }).limit(10);
  if (dupError) throw new Error(dupError.message);
  const dup = (recentRows || []).map((r: { message: string }) => r.message.toLowerCase())
    .find((m: string) => m.includes(condoLine) && m.includes(deviceLine))?.match(/pq-\d{8}-[0-9a-f]{6}/)?.[0];
  if (dup) return json({ ok: true, protocol: dup.toUpperCase(), duplicate: true });

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const ipHash = await sha256Hex(`contact:${ip}`);
  const { count } = await svc.from('contact_requests').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).gte('created_at', new Date(Date.now() - 3600_000).toISOString());
  if ((count || 0) >= 3) throw new HttpError(429, 'Recebemos seus envios. Aguarde nosso retorno.');

  const protocol = `PQ-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const message = [
    `Solicitação de ativação piloto ${protocol} — Modo Portaria Exclusiva. Liberação depende de validação de compatibilidade.`,
    `Condomínio: ${condo}.`,
    `Solicitante: ${name}${role ? ` (${role})` : ''}.`,
    `Aparelho: ${brand} ${model} · Android ${android === 'nao-sei' ? 'não informado' : android} · ${devices} aparelho(s).`,
    notes ? `Observações: ${notes}` : null,
  ].filter(Boolean).join('\n');
  const { error } = await svc.from('contact_requests').insert({ name, email: email.toLowerCase(), phone: phone || null, message, ip_hash: ipHash, source: 'quiosque:piloto' });
  if (error) throw new Error(error.message);
  return json({ ok: true, protocol });
});
