import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, HttpError } from '../../api/_lib/http.ts';

test('JSON válido é lido sem depender de Content-Length', async () => {
  const request = new Request('https://local.invalid', { method: 'POST', body: '{"ok":true}' });
  assert.deepEqual(await readJson(request, 32), { ok: true });
});

test('corpo grande interrompe leitura antes de consumir o restante', async () => {
  let reads = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) { reads++; if (reads <= 6) controller.enqueue(new Uint8Array(64)); else controller.close(); },
    cancel() { canceled = true; },
  });
  const request = new Request('https://local.invalid', { method: 'POST', body, duplex: 'half' });
  await assert.rejects(readJson(request, 16), error => error instanceof HttpError && error.status === 413);
  assert.equal(canceled, true);
  assert.ok(reads <= 2, `Consumiu ${reads} blocos desnecessariamente`);
});

test('JSON inválido não vaza erro interno', async () => {
  await assert.rejects(readJson(new Request('https://local.invalid', { method: 'POST', body: '{' })), error => error.status === 400);
});
