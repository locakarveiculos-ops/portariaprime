// Worker do comprovante: gera PDF real, grava no bucket privado e só depois
// envia e-mail com anexo e WhatsApp como documento (provedores simulados).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processReceipts } from '../../api/jobs/tick.ts';
import { sendEmail, sendWhatsAppDocument } from '../../api/_lib/channels.ts';

test('worker gera PDF uma vez e conclui; falha de storage marca erro sem concluir', async () => {
  const uploads = [], completes = [];
  let failUpload = false;
  const svc = {
    rpc: async (fn, args) => {
      if (fn === 'claim_receipt_pdfs') return { data: [{ id: 'r1' }] };
      if (fn === 'receipt_pdf_data') return { data: { tenant_id: 'T', package_id: 'P', protocol: 'PP-1', issued_at: '2026-10-22T15:00:00Z',
        snapshot: { carrier: 'Correios', unit_label: '101', picked_up_by: 'X', signature_path: 'T/packages/P/signature-a.png' },
        layout: { template: 'compacto', tenant_name: 'Cond A', logo_path: null } } };
      if (fn === 'complete_receipt_pdf') { completes.push(args); return { error: null }; }
      throw new Error(fn);
    },
    storage: { from: (bucket) => ({
      download: async () => ({ data: null }),
      upload: async (path, bytes, opts) => { uploads.push({ bucket, path, bytes, opts }); return { error: failUpload ? { message: 'offline' } : null }; },
    }) },
  };
  assert.deepEqual(await processReceipts(svc), { ready: 1, failed: 0 });
  assert.equal(uploads[0].bucket, 'tenant-receipts');
  assert.equal(uploads[0].opts.contentType, 'application/pdf');
  assert.equal(Buffer.from(uploads[0].bytes.slice(0, 5)).toString(), '%PDF-');
  assert.match(completes[0].p_sha256, /^[0-9a-f]{64}$/);
  assert.equal(completes[0].p_error, null);
  failUpload = true; completes.length = 0;
  assert.deepEqual(await processReceipts(svc), { ready: 0, failed: 1 });
  assert.equal(completes[0].p_path, null);
  assert.match(completes[0].p_error, /storage/);
});

test('e-mail leva o PDF anexado; WhatsApp envia documento base64 pela Evolution', async () => {
  const saved = { ...process.env }; const fetch0 = globalThis.fetch;
  Object.assign(process.env, { RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'Portaria <a@b.c>', EVOLUTION_API_URL: 'https://evo.example', EVOLUTION_API_KEY: 'k' });
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ id: 'em1', key: { id: 'wa1' } }); };
  try {
    const pdf = { filename: 'comprovante-entrega-PP-1.pdf', content: new Uint8Array([37, 80, 68, 70, 45]) };
    assert.equal((await sendEmail('m@x.y', 'Assunto', '<p>x</p>', pdf)).status, 'accepted');
    assert.deepEqual(calls[0].body.attachments, [{ filename: pdf.filename, content: 'JVBERi0=' }]);
    const r = await sendWhatsAppDocument('pp-x', '(11) 99999-0000', 'legenda', pdf);
    assert.deepEqual([r.status, r.ref], ['accepted', 'wa1']);
    assert.equal(calls[1].url, 'https://evo.example/message/sendMedia/pp-x');
    assert.deepEqual({ ...calls[1].body, media: '…' }, { number: '5511999990000', mediatype: 'document', mimetype: 'application/pdf', fileName: pdf.filename, caption: 'legenda', media: '…' });
    assert.equal(calls[1].body.media, 'JVBERi0=');
  } finally {
    globalThis.fetch = fetch0;
    for (const k of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'EVOLUTION_API_URL', 'EVOLUTION_API_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
