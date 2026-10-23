/**
 * PDF do contrato aceito (A4, pdf-lib). Entrada já autorizada e montada pelo
 * servidor (contract_pdf_data). Texto do documento + partes + plano + carimbo
 * do aceite eletrônico + recibo. Não é assinatura digital ICP-Brasil.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

export interface ContractPdfData {
  id: string; kind: string; previous_id?: string | null; document_version: string; document_sha256: string; document_md: string;
  accepted_at: string; timezone?: string; ip?: string | null; user_agent?: string | null;
  contractor_name: string; contractor_document: string;
  representative_name: string; representative_cpf?: string | null; representative_email: string; representative_phone?: string | null;
  representative_role: string; representative_authority: string;
  terms: { source?: string; plan_name?: string; plan_code?: string; cycle?: string; amount_cents?: number; limits?: Record<string, unknown>; trial_ends_at?: string | null };
  contractee?: Record<string, string | null> | null;
}

const A4: [number, number] = [595.28, 841.89];
const M = 50;
const CYCLE: Record<string, string> = { monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };
const LIMIT: Record<string, string> = { max_units: 'Unidades', max_concierges: 'Portarias', ocr_monthly: 'Leituras OCR/mês', whatsapp_monthly: 'WhatsApp/mês', storage_mb: 'Armazenamento (MB)' };
const brl = (c?: number) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const doc = (d?: string | null) => !d ? '—' : d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;
export const fmtServer = (iso: string, tz = 'America/Sao_Paulo') =>
  `${new Date(iso).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' })} (${tz}) · ${new Date(iso).toISOString()}`;

export async function renderContractPdf(d: ContractPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Contrato aceito ${d.id.slice(0, 8)}`); pdf.setProducer('Portaria Prime'); pdf.setCreator('Portaria Prime');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const safe = (s: unknown) => Array.from(String(s ?? '').replace(/[\r\t]/g, ' ')).map((c) => (c === '\n' || charset.has(c.codePointAt(0)!) ? c : '?')).join('');
  const ink = rgb(0.094, 0.157, 0.227), muted = rgb(0.32, 0.38, 0.45), line = rgb(0.85, 0.83, 0.79);
  const W = A4[0] - 2 * M;
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const ensure = (h: number) => { if (y - h < M + 30) { page = pdf.addPage(A4); y = A4[1] - M; } };
  const wrap = (text: string, f: PDFFont, sz: number, width = W) => {
    const out: string[] = [];
    for (const para of safe(text).split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        let w = word;
        while (f.widthOfTextAtSize(w, sz) > width) {
          let k = w.length; while (k > 1 && f.widthOfTextAtSize(w.slice(0, k), sz) > width) k--;
          if (cur) { out.push(cur); cur = ''; }
          out.push(w.slice(0, k)); w = w.slice(k);
        }
        const next = cur ? `${cur} ${w}` : w;
        if (f.widthOfTextAtSize(next, sz) > width) { out.push(cur); cur = w; } else cur = next;
      }
      out.push(cur);
    }
    return out;
  };
  const para = (text: string, f = font, sz = 9.5, color = ink, indent = 0) => {
    for (const ln of wrap(text, f, sz, W - indent)) { ensure(sz + 4); page.drawText(ln, { x: M + indent, y, size: sz, font: f, color }); y -= sz + 4; }
  };
  const gap = (h = 6) => { y -= h; };
  const rule = () => { ensure(10); page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.6, color: line }); y -= 10; };
  const kv = (rows: [string, string][]) => rows.forEach(([k, v]) => {
    const vl = wrap(v || '—', font, 9.5, W - 170);
    ensure(vl.length * 13.5);
    page.drawText(safe(k), { x: M, y, size: 9.5, font: bold, color: muted });
    vl.forEach((ln, i) => page.drawText(ln, { x: M + 170, y: y - i * 13.5, size: 9.5, font, color: ink }));
    y -= vl.length * 13.5;
  });

  const tz = d.timezone || 'America/Sao_Paulo';
  const when = fmtServer(d.accepted_at, tz);
  para('Contrato de prestação de serviços Portaria Prime — via do aceite eletrônico', bold, 14);
  para(`Versão ${d.document_version} · ${d.kind === 'aditivo' ? 'Aditivo (substitui o aceite anterior)' : 'Aceite original'} · Registro ${d.id}`, font, 9, muted);
  gap(); rule();

  para('Partes', bold, 11); gap(2);
  const c = d.contractee || {};
  kv([
    ['Contratada', [c.razao_social, c.cnpj && `CNPJ ${doc(c.cnpj)}`, c.endereco].filter(Boolean).join(' · ')],
    ['Contato / privacidade', [c.email_contato, c.canal_privacidade].filter(Boolean).join(' · ')],
    ['Contratante', `${d.contractor_name} · ${d.contractor_document.length === 14 ? 'CNPJ' : 'CPF'} ${doc(d.contractor_document)}`],
    ['Representante', `${d.representative_name}${d.representative_cpf ? ` · CPF ${doc(d.representative_cpf)}` : ''}`],
    ['Cargo e poderes declarados', `${d.representative_role} — ${d.representative_authority}`],
    ['E-mail / telefone', [d.representative_email, d.representative_phone].filter(Boolean).join(' · ')],
  ]);
  gap(); para('Plano contratado (valores calculados pelo servidor no momento do aceite)', bold, 11); gap(2);
  const t = d.terms || {};
  kv([
    ['Plano e ciclo', `${t.plan_name || t.plan_code || '—'} · ${CYCLE[t.cycle || ''] || t.cycle || '—'}`],
    ['Valor por ciclo', `${brl(t.amount_cents)} — cobrança por link a cada ciclo, sem débito automático`],
    ['Origem do preço', t.source === 'proposal' ? 'Proposta comercial aceita (condições congeladas)' : 'Catálogo publicado'],
    ['Limites', Object.entries(t.limits || {}).filter(([k]) => LIMIT[k]).map(([k, v]) => `${LIMIT[k]}: ${v}`).join(' · ') || '—'],
    ...(t.trial_ends_at ? [['Mês de teste', `Em andamento até ${fmtServer(t.trial_ends_at, tz)}. A primeira cobrança só é gerada ao fim do teste.`] as [string, string]] : []),
  ]);
  gap(); rule();

  para('Texto do documento aceito', bold, 11); gap(2);
  for (const raw of d.document_md.split('\n')) {
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) { gap(4); para(h[2], bold, h[1].length <= 2 ? 11 : 10); continue; }
    if (!raw.trim()) { gap(4); continue; }
    const li = raw.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    para((li ? '• ' : '') + (li ? li[1] : raw).replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)'), font, 9, ink, li ? 10 : 0);
  }
  gap(); rule();

  para('Recibo de aceite eletrônico', bold, 11); gap(2);
  kv([
    ['Registrado em', when],
    ['Hash SHA-256 do documento', d.document_sha256],
    ['Conta autenticada', d.representative_email],
    ['Origem técnica', `IP ${d.ip || 'não registrado'} · ${d.user_agent ? safe(d.user_agent).slice(0, 120) : 'navegador não informado'}`],
    ...(d.previous_id ? [['Aceite anterior', d.previous_id] as [string, string]] : []),
  ]);
  gap();
  para('Aceite eletrônico com registro de data e hora do servidor, conta autenticada, IP e navegador, e hash do texto exibido. '
    + 'Não é assinatura digital com certificado ICP-Brasil. Como base de consulta, a MP 2.200-2/2001, art. 10, §2º, admite outros meios de '
    + 'comprovação de autoria e integridade aceitos pelas partes; isso não garante, por si, a validade jurídica do aceite em todos os casos.', font, 8, muted);

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const foot = safe(`Aceite eletrônico registrado em ${when} · hash SHA-256 do documento ${d.document_sha256}`);
    wrap(foot, font, 6.5, W - 60).slice(0, 2).forEach((ln, j) => p.drawText(ln, { x: M, y: M - 6 - j * 8, size: 6.5, font, color: muted }));
    const pg = `Página ${i + 1} de ${pages.length}`;
    p.drawText(pg, { x: A4[0] - M - font.widthOfTextAtSize(pg, 7), y: M - 6, size: 7, font, color: muted });
  });
  return pdf.save();
}
