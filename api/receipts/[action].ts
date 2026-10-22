/**
 * Comprovantes em PDF.
 *   POST /api/receipts/download { tenantId, packageId } -> URL temporária nova (5 min) do PDF original
 *   POST /api/receipts/preview  { tenantId, layout }    -> PDF de teste com dados fictícios (nada é gravado/enviado)
 * Autorização sempre no banco com a sessão do usuário; bucket privado lido só pelo backend.
 */
import { handler, json, readJson, isUuid, HttpError } from '../_lib/http.js';
import { requireUser, serviceClient, rpcError } from '../_lib/supabase.js';
import { renderReceiptPdf } from '../_lib/receipt-pdf.js';

const FIELDS = ['template', 'color_primary', 'color_accent', 'logo_position', 'logo_size', 'title', 'message', 'footer',
  'address', 'contact', 'show_address', 'show_contact', 'show_document'] as const;

export const POST = handler(async (request) => {
  const action = new URL(request.url).pathname.split('/').pop();
  const body = await readJson(request, 8192);
  if (!isUuid(body.tenantId)) throw new HttpError(400, 'Condomínio inválido.');
  const { client } = await requireUser(request);
  const svc = serviceClient();

  if (action === 'download') {
    if (!isUuid(body.packageId)) throw new HttpError(400, 'Encomenda inválida.');
    const { data, error } = await client.rpc('receipt_pdf_access', { p_tenant: body.tenantId, p_package: body.packageId });
    if (error) rpcError(error);
    if (data.status !== 'ready') return json({ status: data.status, protocol: data.protocol });
    const { data: s, error: se } = await svc.storage.from('tenant-receipts').createSignedUrl(data.path, 300, { download: `comprovante-entrega-${data.protocol}.pdf` });
    if (se || !s) throw new HttpError(502, 'Não foi possível abrir o comprovante agora.');
    return json({ status: 'ready', protocol: data.protocol, url: s.signedUrl });
  }

  if (action === 'preview') {
    const { data: saved, error } = await client.rpc('receipt_layout', { p_tenant: body.tenantId });
    if (error) rpcError(error);
    if (!saved) throw new HttpError(403, 'Sem permissão.');
    // Somente campos controlados; o restante vem do condomínio (nunca do cliente).
    const draft: Record<string, unknown> = {};
    for (const k of FIELDS) if (body.layout && k in body.layout) draft[k] = body.layout[k];
    const { data: tenant } = await svc.from('tenants').select('name, timezone, document').eq('id', body.tenantId).single();
    const { data: brand } = await svc.from('tenant_branding').select('display_name, logo_path').eq('tenant_id', body.tenantId).maybeSingle();
    const logoPath = typeof body.logoPath === 'string' && body.logoPath.startsWith(`${body.tenantId}/logo-`) ? body.logoPath : brand?.logo_path;
    const logo = logoPath ? await svc.storage.from('tenant-public').download(logoPath).then((r) => r.data ? r.data.arrayBuffer() : null) : null;
    const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const bytes = await renderReceiptPdf({
      protocol: 'PP-EXEMPLO-0000', package_id: '00000000-0000-4000-8000-000000000000', issued_at: new Date().toISOString(),
      recipient_name: 'Morador Exemplo (fictício)', storage: 'Portaria › Estante A › Prateleira 2',
      layout: { ...saved, ...draft, title: s(draft.title, 80) || saved.title, message: s(draft.message, 300), footer: s(draft.footer, 200),
        address: s(draft.address, 160), contact: s(draft.contact, 100),
        tenant_name: brand?.display_name || tenant?.name, document: tenant?.document, timezone: tenant?.timezone } as any,
      snapshot: { carrier: 'Correios', tracking_code: 'BR000000000BR', unit_block: 'A', unit_label: '101', received_at: new Date(Date.now() - 3_600_000).toISOString(),
        picked_up_at: new Date().toISOString(), picked_up_by: 'Pessoa Exemplo', operator: 'Porteiro Exemplo', method: 'qr', recipient_kind: 'morador' },
    }, { logo: logo ? new Uint8Array(logo) : null });
    return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="comprovante-teste.pdf"', 'Cache-Control': 'no-store' } });
  }

  throw new HttpError(404, 'Ação desconhecida.');
});
