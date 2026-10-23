// Template do lembrete (push sem dados pessoais) e código de verificação no PDF novo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../api/_lib/templates.ts';
import { renderReceiptPdf, RECEIPT_TEMPLATE_VERSION } from '../../api/_lib/receipt-pdf.ts';
import { processReceipts } from '../../api/jobs/tick.ts';

const ctx = { tenant_name: 'Cond *Teste*', tenant_slug: 'cond-teste', timezone: 'America/Sao_Paulo',
  package: { id: '11111111-2222-4333-8444-555555555555', carrier: 'Correios', unit: 'A 101', received_at: '2026-10-22T12:00:00Z', tracking_code: 'BR1' } };

test('lembrete: push curto e sem unidade/transportadora; link para a encomenda', () => {
  const m = render('package_reminder', ctx, {}, 'https://app.test');
  assert.equal(m.push.title, 'Encomenda aguardando retirada');
  for (const s of ['A 101', 'Correios', 'BR1']) assert.ok(!JSON.stringify(m.push).includes(s), s);
  assert.equal(m.push.url, 'https://app.test/c/cond-teste/encomenda?p=11111111-2222-4333-8444-555555555555');
  assert.match(m.whatsapp, /^\*Cond Teste\*\nLembrete/);
  assert.match(m.subject, /Lembrete/);
});

test('PDF pdf-2 imprime código e URL de validação; worker monta a URL pela APP_URL', async () => {
  assert.equal(RECEIPT_TEMPLATE_VERSION, 'pdf-2');
  const data = { protocol: 'PP-1', package_id: '573b1d10-3360-408b-b537-252c1a11d89a', issued_at: '2026-10-22T15:04:00Z', layout: {},
    snapshot: { carrier: 'Correios', unit_label: '101', picked_up_by: 'X', method: 'qr' } };
  const plain = await renderReceiptPdf(data, {});
  const coded = await renderReceiptPdf({ ...data, verify_code: 'ABCD-EF01-2345-6789-ABCD', verify_url: 'https://app.test/validar' }, {});
  assert.ok(coded.length > plain.length);

  const seen = [];
  const svc = {
    rpc: async (fn, args) => {
      if (fn === 'claim_receipt_pdfs') return { data: [{ id: 'r1' }] };
      if (fn === 'receipt_pdf_data') return { data: { ...data, tenant_id: 'T', package_id: 'P', verify_code: 'ABCD-EF01-2345-6789-ABCD' } };
      if (fn === 'complete_receipt_pdf') { seen.push(args); return { error: null }; }
      throw new Error(fn);
    },
    storage: { from: () => ({ download: async () => ({ data: null }), upload: async () => ({ error: null }) }) },
  };
  assert.deepEqual(await processReceipts(svc, 'https://app.test'), { ready: 1, failed: 0 });
  assert.equal(seen[0].p_version, 'pdf-2');
});
