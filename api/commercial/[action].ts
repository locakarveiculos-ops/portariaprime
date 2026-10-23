/**
 * Roteador COMERCIAL (Admin Master). Única função da Vercel para a área comercial — outras
 * frentes (contratos, carteiras) podem acrescentar ações aqui em arquivos "_x.ts" em vez de
 * criar nova pasta em api/ (limite de 12 funções).
 *   POST /api/commercial/attachment     { quoteId }              -> URL assinada (120 s) do anexo do orçamento
 *   POST /api/commercial/proposal_pdf   { proposalId }           -> PDF da proposta (rascunho marcado como tal)
 *   POST /api/commercial/send_proposal  { proposalId, reason }   -> envia (congela, gera token, enfileira e-mail)
 * Autorização SEMPRE no banco com a sessão do usuário (capacidades 'quotes'/'quote_manage');
 * o service role só toca o Storage depois que a RPC autorizou.
 */
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';
import { renderProposalPdf } from '../_lib/proposal-pdf.js';

export const POST = handler(async (request) => {
  const action = new URL(request.url).pathname.split('/').pop();
  const body = await readJson(request, 4096);
  const { client } = await requireUser(request);

  if (action === 'attachment') {
    if (!isUuid(body.quoteId)) throw new HttpError(400, 'Solicitação inválida.');
    const { data, error } = await client.rpc('quote_attachment_access', { p_quote: body.quoteId });
    if (error) rpcError(error);
    const ext = data.mime === 'application/pdf' ? 'pdf' : data.mime === 'image/png' ? 'png' : 'jpg';
    const { data: s, error: se } = await serviceClient().storage.from('quote-attachments')
      .createSignedUrl(data.path, 120, { download: `orcamento-${data.protocol}.${ext}` });
    if (se || !s) throw new HttpError(502, 'Não foi possível abrir o anexo agora.');
    return json({ url: s.signedUrl, expires_in: 120 });
  }

  if (action === 'proposal_pdf') {
    if (!isUuid(body.proposalId)) throw new HttpError(400, 'Proposta inválida.');
    const { data, error } = await client.rpc('quote_proposal_pdf_data', { p_proposal: body.proposalId });
    if (error) rpcError(error);
    const bytes = await renderProposalPdf(data);
    const name = `proposta-${String(data.protocol || data.quote_protocol).replace(/[^A-Za-z0-9-]/g, '')}-v${data.version}.pdf`;
    return new Response(bytes as BodyInit, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
  }

  if (action === 'send_proposal') {
    if (!isUuid(body.proposalId) || typeof body.reason !== 'string') throw new HttpError(400, 'Proposta e justificativa obrigatórias.');
    const { data, error } = await client.rpc('quote_proposal_send', { p_proposal: body.proposalId, p_reason: body.reason.slice(0, 1000) });
    if (error) rpcError(error);
    return json(data);
  }

  throw new HttpError(404, 'Ação desconhecida.');
});
