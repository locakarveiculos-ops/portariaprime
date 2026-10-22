/**
 * POST /api/jobs/tick   Authorization: Bearer <CRON_SECRET>
 * Job confiável (Vercel Cron ou agendador externo). Idempotente e seguro em paralelo:
 *  1. ciclo comercial (lembretes D-7/D-3/término, pedido pós-teste, renovação, past_due)
 *  2. reprocessa eventos de pagamento pendentes (com consulta ao provedor)
 *  3. envia a fila de notificações (outbox) com retry/backoff
 */
import { handler, json, safeEqual, HttpError } from '../_lib/http.js';
import { env, appUrl } from '../_lib/env.js';
import { serviceClient } from '../_lib/supabase.js';
import { verifyAndApply } from '../_lib/payments.js';
import { render, emailHtml } from '../_lib/templates.js';
import { sendEmail, sendWhatsApp, sendWhatsAppDocument, sendPush, whatsAppState, SendResult, Attachment } from '../_lib/channels.js';
import { renderReceiptPdf, RECEIPT_TEMPLATE_VERSION } from '../_lib/receipt-pdf.js';
import { createHash } from 'node:crypto';

/** Baixa um objeto do Storage pelo backend (sem URL pública); ausente = null. */
async function download(svc: any, bucket: string, path: string | null | undefined) {
  if (!path) return null;
  const { data } = await svc.storage.from(bucket).download(path);
  return data ? new Uint8Array(await data.arrayBuffer()) : null;
}

/** Gera PDFs pendentes. Falha não afeta a retirada (já confirmada) e é reprocessada. */
export async function processReceipts(svc: any) {
  const { data: claimed, error } = await svc.rpc('claim_receipt_pdfs', { p_limit: 5 });
  if (error) throw new Error(error.message);
  const out = { ready: 0, failed: 0 };
  for (const r of claimed || []) {
    try {
      const { data, error: de } = await svc.rpc('receipt_pdf_data', { p_receipt: r.id });
      if (de || !data) throw new Error('dados do comprovante indisponíveis');
      const layout = data.layout || {};
      const [logo, signature, photo] = await Promise.all([
        download(svc, 'tenant-public', layout.logo_path),
        download(svc, 'tenant-private', data.snapshot?.signature_path),
        download(svc, 'tenant-private', data.snapshot?.handover_path),
      ]);
      const storage = [data.storage_rack, data.storage_shelf].filter(Boolean).join(' › ') || data.storage_code;
      const bytes = await renderReceiptPdf({ ...data, storage }, { logo, signature, photo });
      const path = `${data.tenant_id}/receipts/${data.package_id}/comprovante-${data.protocol}.pdf`;
      // upsert: retry após falha de rede reusa o caminho (o PDF só vale após complete_receipt_pdf).
      const up = await svc.storage.from('tenant-receipts').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
      if (up.error) throw new Error(`storage: ${up.error.message}`);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const { error: ce } = await svc.rpc('complete_receipt_pdf', { p_receipt: r.id, p_path: path, p_sha256: sha,
        p_bytes: bytes.length, p_version: RECEIPT_TEMPLATE_VERSION, p_error: null });
      if (ce) throw new Error(ce.message);
      out.ready++;
    } catch (e: any) {
      await svc.rpc('complete_receipt_pdf', { p_receipt: r.id, p_path: null, p_sha256: null, p_bytes: null, p_version: null,
        p_error: String(e?.message || e).slice(0, 300) });
      out.failed++;
    }
  }
  return out;
}

async function run(request: Request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(token, env('CRON_SECRET'))) throw new HttpError(401, 'Não autorizado.');
  const svc = serviceClient();
  const base = appUrl();
  const report: any = {};

  const { data: billing, error: be } = await svc.rpc('billing_tick');
  if (be) throw new Error(be.message);
  report.billing = billing;

  const { data: events } = await svc.rpc('claim_payment_events', { p_limit: 20 });
  report.payments = 0;
  for (const ev of events || []) {
    const p = ev.payload || {};
    try {
      const r = await verifyAndApply(svc, { orderNsu: p.order_nsu, transactionNsu: p.transaction_nsu, slug: p.invoice_slug, receiptUrl: p.receipt_url });
      const st = r.result === 'activated' || r.result === 'duplicate_ignored' ? 'processed' : r.result === 'review' ? 'review' : 'error';
      await svc.rpc('finish_payment_event', { p_event: ev.id, p_status: st, p_error: st === 'error' ? r.result : null });
      report.payments++;
    } catch (e: any) {
      await svc.rpc('finish_payment_event', { p_event: ev.id, p_status: 'error', p_error: String(e?.message || e) });
    }
  }

  report.receipts = await processReceipts(svc);

  const { data: jobs, error: je } = await svc.rpc('claim_notification_jobs', { p_limit: 50 });
  const pdfCache = new Map<string, Attachment | null>();
  if (je) throw new Error(je.message);
  const counts: Record<string, number> = {};
  const waClosed = new Map<string, boolean>();
  for (const job of jobs || []) {
    let res: SendResult;
    try {
      const authorization = await svc.rpc('notification_is_authorized', { p_job: job.id });
      if (authorization.error) throw new Error('Não foi possível validar o destinatário.');
      if (authorization.data !== true) {
        await svc.rpc('complete_notification_job', { p_job: job.id, p_status: 'disabled', p_provider_ref: null, p_error: 'Destinatário sem autorização vigente' });
        counts[`${job.channel}:disabled`] = (counts[`${job.channel}:disabled`] || 0) + 1;
        continue;
      }
      const { data: ctx } = await svc.rpc('notification_context', { p_job: job.id });
      const m: any = render(job.event, ctx, job.payload, base);
      // Retirada: canais com anexo exigem o PDF pronto (o job só sai de "hold" depois dele).
      let pdf: Attachment | null = null;
      if (job.event === 'package_picked_up' && job.channel !== 'push') {
        const path: string = ctx.package?.pdf_path || '';
        if (!pdfCache.has(path)) {
          const content = await download(svc, 'tenant-receipts', path);
          const name = `comprovante-entrega-${String(ctx.package?.protocol || '').replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
          pdfCache.set(path, content ? { filename: name, content } : null);
        }
        pdf = pdfCache.get(path) || null;
        if (!pdf) throw new Error('Comprovante PDF indisponível');
      }
      if (job.channel === 'email') {
        res = await sendEmail(job.recipient, m.subject, emailHtml(ctx, m), pdf || undefined);
      } else if (job.channel === 'whatsapp') {
        const wa = ctx.whatsapp;
        if (!wa?.enabled || !wa.instance) res = { status: 'disabled', error: 'WhatsApp não conectado neste condomínio' };
        else {
          // Instância caída: não gasta franquia; reagenda e avisa o síndico.
          if (!waClosed.has(wa.instance)) waClosed.set(wa.instance, (await whatsAppState(wa.instance)) === 'closed');
          if (waClosed.get(wa.instance)) {
            res = { status: 'failed', error: 'WhatsApp do condomínio desconectado' };
            await svc.rpc('ops_alert_whatsapp', { p_tenant: job.tenant_id });
          } else {
            const { data: allowed } = await svc.rpc('consume_whatsapp', { p_tenant: job.tenant_id });
            res = !allowed ? { status: 'disabled', error: 'Franquia de WhatsApp esgotada' }
              : pdf ? await sendWhatsAppDocument(wa.instance, job.recipient, m.whatsapp, pdf)
              : await sendWhatsApp(wa.instance, job.recipient, m.whatsapp);
          }
        }
      } else {
        const { data: subs } = await svc.from('push_subscriptions').select('id, endpoint, p256dh, auth')
          .eq('tenant_id', job.tenant_id).eq('user_id', job.recipient);
        if (!subs?.length) res = { status: 'disabled', error: 'Sem dispositivo inscrito' };
        else {
          const results = await Promise.all(subs.map(async (s) => {
            const r = await sendPush(s, m.push);
            if (r.gone) await svc.from('push_subscriptions').delete().eq('id', s.id);
            return r;
          }));
          res = results.find((r) => r.status === 'accepted') || results[0];
        }
      }
    } catch (e: any) {
      res = { status: 'failed', error: String(e?.message || e) };
    }
    await svc.rpc('complete_notification_job', { p_job: job.id, p_status: res.status, p_provider_ref: res.ref || null, p_error: res.error || null, p_final: !!res.permanent });
    counts[`${job.channel}:${res.status}`] = (counts[`${job.channel}:${res.status}`] || 0) + 1;
  }
  report.notifications = counts;
  await svc.rpc('record_worker_run', { p_name: 'tick', p_result: report });
  return json(report);
}

export const POST = handler(run);
// Vercel Cron chama com GET e envia "Authorization: Bearer $CRON_SECRET".
export const GET = handler(run);
