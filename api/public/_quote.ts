/**
 * POST /api/quote   multipart/form-data
 *   campos: contact_name, email, phone?, org_kind (condominio|administradora), org_name, units, concierges?,
 *           condos_count?, current_vendor?, budget_cents?, budget_cycle?, budget_valid_until? (AAAA-MM-DD),
 *           scope?, website (honeypot), attachment? (PDF/JPEG/PNG, até 5 MB)
 * O orçamento informado é dado do solicitante (comparação), nunca preço nosso. Tipo do anexo pela
 * assinatura de bytes; upload só aqui (service role) no bucket privado "quote-attachments".
 * Limite: 3 solicitações por IP por hora (hash, sem guardar o IP), aplicado no banco.
 * ponytail: a Vercel limita o corpo da função a ~4,5 MB; anexos maiores recebem 413 antes de chegar
 * aqui. Para 5 MB reais, trocar por URL de upload assinada + validação posterior no backend.
 */
import { handler, json, HttpError, sha256Hex } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';

export const MAX_FILE = 5 * 1024 * 1024;
const MAX_BODY = MAX_FILE + 64 * 1024;

/** Tipo real pelo conteúdo (não pela extensão nem pelo Content-Type declarado). */
export function sniff(b: Uint8Array): { mime: string; ext: string } | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return { mime: 'application/pdf', ext: 'pdf' };
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  return null;
}

async function readBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) throw new HttpError(413, 'Anexo maior que 5 MB.');
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) { await reader.cancel(); throw new HttpError(413, 'Anexo maior que 5 MB.'); }
      parts.push(value);
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

const str = (f: FormData, k: string, max: number) => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
};
const int = (f: FormData, k: string) => {
  const v = str(f, k, 12);
  if (v == null) return null;
  if (!/^\d+$/.test(v)) throw new HttpError(400, 'Use apenas números inteiros nos campos numéricos.');
  return Number(v);
};

export const POST = handler(async (request) => {
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(415, 'Envie o formulário de orçamento.');
  const raw = await readBody(request);
  let form: FormData;
  try { form = await new Response(raw as BodyInit, { headers: { 'content-type': type } }).formData(); }
  catch { throw new HttpError(400, 'Formulário inválido.'); }
  if (str(form, 'website', 200)) return json({ ok: true }); // honeypot: finge sucesso, não grava

  const p = {
    contact_name: str(form, 'contact_name', 120), email: str(form, 'email', 200)?.toLowerCase() || null, phone: str(form, 'phone', 30),
    org_kind: str(form, 'org_kind', 20), org_name: str(form, 'org_name', 160), units: int(form, 'units'),
    concierges: int(form, 'concierges'), condos_count: int(form, 'condos_count'), current_vendor: str(form, 'current_vendor', 120),
    budget_cents: int(form, 'budget_cents'), budget_cycle: str(form, 'budget_cycle', 10), budget_valid_until: str(form, 'budget_valid_until', 10),
    scope: str(form, 'scope', 2000),
  };
  if (!p.contact_name || p.contact_name.length < 2 || !p.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)
    || !p.org_name || !['condominio', 'administradora'].includes(p.org_kind || '') || !p.units) {
    throw new HttpError(400, 'Preencha nome, e-mail válido, tipo, nome do condomínio/administradora e unidades.');
  }
  if ((p.budget_cents == null) !== (p.budget_cycle == null) || (p.budget_cycle && !['monthly', 'quarterly', 'yearly'].includes(p.budget_cycle))) {
    throw new HttpError(400, 'Informe valor e periodicidade do orçamento juntos.');
  }
  if (p.budget_valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(p.budget_valid_until)) throw new HttpError(400, 'Validade do orçamento inválida.');

  const file = form.get('attachment');
  let bytes: Uint8Array | null = null;
  let kind: ReturnType<typeof sniff> = null;
  if (file && typeof file !== 'string' && file.size > 0) {
    if (file.size > MAX_FILE) throw new HttpError(413, 'Anexo maior que 5 MB.');
    bytes = new Uint8Array(await file.arrayBuffer());
    kind = sniff(bytes);
    if (!kind) throw new HttpError(415, 'Anexo deve ser PDF, JPEG ou PNG.');
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const svc = serviceClient();
  const { data, error } = await svc.rpc('quote_submit', { p, p_ip_hash: await sha256Hex(`quote:${ip}`) });
  if (error) {
    if (/Aguarde/.test(error.message || '')) throw new HttpError(429, error.message);
    if (error.code === '22023') throw new HttpError(400, error.message);
    console.error('[quote]', error.code);
    throw new HttpError(500, 'Não foi possível registrar agora. Tente novamente.');
  }
  let attachment: 'none' | 'saved' | 'failed' = 'none';
  if (bytes && kind) {
    const path = `${data.id}/${crypto.randomUUID()}.${kind.ext}`;
    const up = await svc.storage.from('quote-attachments').upload(path, bytes, { contentType: kind.mime, upsert: false });
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('');
    const done = up.error ? up : await svc.rpc('quote_attach', { p_quote: data.id, p_path: path, p_mime: kind.mime, p_bytes: bytes.length, p_sha256: sha });
    if (done.error) {
      console.error('[quote] anexo', done.error.message);
      if (!up.error) await svc.storage.from('quote-attachments').remove([path]);
      attachment = 'failed';
    } else attachment = 'saved';
  }
  return json({ ok: true, protocol: data.protocol, attachment }, 201);
});
