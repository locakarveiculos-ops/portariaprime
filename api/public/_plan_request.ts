/**
 * POST /api/plan-request  — pedido de contratação vindo de /planos (página pública).
 * Grava um contato comercial estruturado (contact_requests, source 'planos:contrato') com o plano
 * e o ciclo escolhidos, o preço recalculado no servidor pelo catálogo ativo e o hash da versão do
 * contrato exibida. NÃO é aceite contratual: o aceite formal (com verificação do representante,
 * PDF e trilha) acontece em /contratar, depois de o condomínio criar a conta.
 * Honeypot "website"; limite de 3 envios por IP/hora (hash do IP).
 */
import { handler, json, readJson, HttpError, sha256Hex } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';

const CYCLES = new Set(['monthly', 'quarterly', 'yearly']);
const CYCLE_PT: Record<string, string> = { monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };
const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '');
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const POST = handler(async (request) => {
  const b = await readJson(request, 16384);
  if (b.website) return json({ ok: true, protocol: null }); // honeypot
  const s = (v: unknown, min: number, max: number) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
  const plan = s(b.plan, 2, 30), cycle = typeof b.cycle === 'string' && CYCLES.has(b.cycle) ? b.cycle : null;
  const condo = s(b.condoName, 2, 200), city = s(b.city, 2, 120), uf = typeof b.uf === 'string' && /^[A-Z]{2}$/.test(b.uf) ? b.uf : null;
  const name = s(b.repName, 2, 160), role = s(b.repRole, 2, 120), email = s(b.repEmail, 5, 200);
  const phone = digits(b.repPhone), cnpj = digits(b.cnpj), units = Number.isInteger(b.units) && b.units > 0 && b.units < 100000 ? b.units : null;
  const docSha = typeof b.documentSha256 === 'string' && /^[0-9a-f]{64}$/.test(b.documentSha256) ? b.documentSha256 : null;
  const docVersion = s(b.documentVersion, 1, 40);
  if (!plan || !cycle || !condo || !name || !role || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'Preencha plano, ciclo, condomínio, nome, cargo e e-mail válido.');
  }
  if (cnpj && cnpj.length !== 14) throw new HttpError(400, 'CNPJ deve ter 14 dígitos.');
  if (phone && (phone.length < 10 || phone.length > 13)) throw new HttpError(400, 'Telefone com DDD, 10 a 13 dígitos.');
  if (b.agree !== true || !docSha) throw new HttpError(400, 'Leia os termos e marque a concordância para enviar.');

  const svc = serviceClient();
  // Preço SEMPRE do catálogo ativo (nunca do navegador).
  const { data: p } = await svc.from('plans').select('id, name, code, published, is_custom').eq('code', plan).maybeSingle();
  if (!p || !p.published || p.is_custom) throw new HttpError(400, 'Plano indisponível.');
  const { data: price } = await svc.from('plan_prices').select('amount_cents, version').eq('plan_id', p.id).eq('cycle', cycle).eq('active', true).maybeSingle();
  if (!price) throw new HttpError(400, 'Ciclo indisponível para este plano.');

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const ipHash = await sha256Hex(`contact:${ip}`);
  const { count } = await svc.from('contact_requests').select('id', { count: 'exact', head: true })
    .eq('ip_hash', ipHash).gte('created_at', new Date(Date.now() - 3600_000).toISOString());
  if ((count || 0) >= 3) throw new HttpError(429, 'Recebemos seus envios. Aguarde nosso retorno.');

  const protocol = `PC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const message = [
    `Pedido de contratação ${protocol} (página /planos). Não é aceite contratual.`,
    `Plano: ${p.name} · ciclo ${CYCLE_PT[cycle]} · ${brl(price.amount_cents)} por ciclo (catálogo v${price.version}).`,
    `Condomínio: ${condo}${cnpj ? ` · CNPJ ${cnpj}` : ''}${units ? ` · ${units} unidades` : ''}${city ? ` · ${city}${uf ? `/${uf}` : ''}` : ''}.`,
    `Representante: ${name} (${role}).`,
    `Contrato exibido: versão ${docVersion || '?'} · SHA-256 ${docSha}.`,
  ].join('\n');
  const { error } = await svc.from('contact_requests').insert({ name, email: email.toLowerCase(), phone: phone || null, message, ip_hash: ipHash, source: 'planos:contrato' });
  if (error) throw new Error(error.message);
  return json({ ok: true, protocol, plan: p.name, cycle, amount_cents: price.amount_cents });
});
