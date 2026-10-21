import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLabel } from '../../api/ocr/analyze-label.ts';

test('OCR: modelo principal, reserva para erro/JSON inválido e falha explícita', async () => {
  const calls = [];
  const ai = { models: { generateContent: async input => {
    calls.push(input);
    return { text: JSON.stringify({ carrier: 'Correios', confidence: 90, unit: '101A' }) };
  } } };
  const result = await readLabel(ai, 'image/png', 'AAAA');
  assert.equal(result.unit, '101A');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.httpOptions.timeout, 12000);
  assert.equal(calls[0].config.maxOutputTokens, 8192);
  for (const mode of ['error', 'json']) {
    calls.length = 0;
    ai.models.generateContent = async input => {
      calls.push(input);
      if (calls.length === 1) {
        if (mode === 'error') throw new Error('provedor indisponível');
        return { text: 'JSON truncado' };
      }
      return { text: '{"carrier":"Outra","confidence":0}' };
    };
    assert.equal((await readLabel(ai, 'image/png', 'AAAA')).confidence, 0);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].model, calls[1].model);
  }
  ai.models.generateContent = async () => ({ text: 'null' });
  await assert.rejects(readLabel(ai, 'image/png', 'AAAA'), /indisponível/);
});
