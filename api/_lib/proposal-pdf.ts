/**
 * PDF da proposta comercial (A4, pdf-lib, fontes padrão WinAnsi). Dados já autorizados pelo
 * banco (quote_proposal_pdf_data); nenhum recurso externo é buscado aqui.
 */
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';

export interface ProposalPdfData {
  protocol?: string | null; quote_protocol: string; version: number; status: string;
  org_name: string; contact_name: string; units: number; condos_count: number;
  plan_name: string; cycle: string; amount_cents: number; valid_until: string; conditions: string;
  limits: Record<string, number | boolean>;
}

export const PROPOSAL_DISCLAIMER = 'Proposta sujeita às condições descritas; não constitui desconto aprovado até o envio pelo responsável.';
const CYCLE: Record<string, string> = { monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const date = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

export async function renderProposalPdf(d: ProposalPdfData): Promise<Uint8Array> {
  const A4: [number, number] = [595.28, 841.89];
  const M = 48, W = A4[0] - 2 * M;
  const navy = rgb(16 / 255, 31 / 255, 48 / 255), champagne = rgb(200 / 255, 171 / 255, 120 / 255);
  const ink = rgb(0.094, 0.157, 0.227), muted = rgb(0.32, 0.38, 0.45);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Proposta ${d.protocol || d.quote_protocol}`); pdf.setProducer('Portaria Prime'); pdf.setCreator('Portaria Prime');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const safe = (s: unknown) => Array.from(String(s ?? '').replace(/[\r\t]/g, ' ')).map((c) => (c === '\n' || charset.has(c.codePointAt(0)!) ? c : '?')).join('');
  const wrap = (text: string, f: PDFFont, sz: number, width: number) => {
    const out: string[] = [];
    for (const para of safe(text).split('\n')) {
      let cur = '';
      for (let w of para.split(/\s+/).filter(Boolean)) {
        while (f.widthOfTextAtSize(w, sz) > width) { let k = w.length; while (k > 1 && f.widthOfTextAtSize(w.slice(0, k), sz) > width) k--; if (cur) { out.push(cur); cur = ''; } out.push(w.slice(0, k)); w = w.slice(k); }
        const next = cur ? `${cur} ${w}` : w;
        if (f.widthOfTextAtSize(next, sz) > width) { out.push(cur); cur = w; } else cur = next;
      }
      out.push(cur);
    }
    return out;
  };
  let page = pdf.addPage(A4);
  let y = A4[1] - M;
  const ensure = (h: number) => { if (y - h < M + 40) { page = pdf.addPage(A4); y = A4[1] - M; } };
  const para = (s: string, f = font, sz = 10.5, color = ink) => { for (const ln of wrap(s, f, sz, W)) { ensure(sz + 4); page.drawText(ln, { x: M, y, size: sz, font: f, color }); y -= sz + 4; } };

  page.drawRectangle({ x: 0, y: A4[1] - 110, width: A4[0], height: 110, color: navy });
  page.drawText('Portaria Prime', { x: M, y: A4[1] - 58, size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Proposta comercial', { x: M, y: A4[1] - 82, size: 12, font, color: champagne });
  y = A4[1] - 140;
  if (d.status === 'draft') para('RASCUNHO — não enviado ao cliente', bold, 11, rgb(0.7, 0.2, 0.2));
  para(`Protocolo ${d.protocol || '(definido no envio)'} · Solicitação ${d.quote_protocol} · Versão ${d.version}`, bold, 10, muted);
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 2, color: champagne });
  y -= 22;
  const L = d.limits || {};
  const rows: [string, string][] = [
    ['Para', `${d.org_name} (a/c ${d.contact_name})`],
    ['Porte informado', `${d.units} unidades${d.condos_count > 1 ? ` · ${d.condos_count} condomínios` : ''}`],
    ['Plano', d.plan_name],
    ['Preço', `${brl(d.amount_cents)} por ciclo ${CYCLE[d.cycle] || d.cycle}`],
    ['Validade da proposta', `até ${date(d.valid_until)}`],
    ['Unidades', String(L.max_units ?? '—')], ['Portarias', String(L.max_concierges ?? '—')],
    ['Leituras de etiqueta (OCR)/mês', L.feature_ocr ? String(L.ocr_monthly) : 'Não incluso'],
    ['Mensagens WhatsApp/mês', L.feature_whatsapp ? String(L.whatsapp_monthly) : 'Não incluso'],
    ['Armazenamento', `${Math.round(Number(L.storage_mb || 0) / 1024)} GB`],
    ['Totem de autoatendimento', L.feature_totem ? 'Incluso' : 'Não incluso'],
  ];
  for (const [k, v] of rows) {
    const vl = wrap(v, font, 10.5, W - 200);
    ensure(vl.length * 14 + 6);
    page.drawText(safe(k), { x: M, y, size: 10.5, font: bold, color: muted });
    vl.forEach((ln, i) => page.drawText(ln, { x: M + 200, y: y - i * 14, size: 10.5, font, color: ink }));
    y -= vl.length * 14 + 6;
  }
  y -= 10;
  para('Condições', bold, 12, navy);
  para(d.conditions);
  y -= 6;
  para('Franquia: cada mensagem aceita pelo provedor por destinatário consome 1 unidade; tentativas com falha e duplicatas não consomem; o contador reinicia todo mês.', font, 9, muted);
  y -= 8;
  para(PROPOSAL_DISCLAIMER, bold, 9.5, ink);
  pdf.getPages().forEach((p, i, all) => {
    p.drawLine({ start: { x: M, y: M + 6 }, end: { x: A4[0] - M, y: M + 6 }, thickness: 0.5, color: champagne });
    p.drawText(safe(`Portaria Prime · ${d.protocol || d.quote_protocol}`), { x: M, y: M - 6, size: 7.5, font, color: muted });
    const pg = `Página ${i + 1} de ${all.length}`;
    p.drawText(pg, { x: A4[0] - M - font.widthOfTextAtSize(pg, 7.5), y: M - 6, size: 7.5, font, color: muted });
  });
  return pdf.save();
}
