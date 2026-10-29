// Remetente dos e-mails: endereço sempre o do domínio verificado; o condomínio só aparece no nome de exibição.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHeader } from '../../api/_lib/channels.ts';

const BASE = 'Portaria Prime <avisos@portariaprime.com.br>';

test('nome do condomínio no remetente, endereço verificado preservado', () => {
  assert.equal(fromHeader(BASE, 'Residencial Jardim das Flores'), '"Residencial Jardim das Flores via Portaria Prime" <avisos@portariaprime.com.br>');
  assert.equal(fromHeader(BASE, null), BASE);
  assert.equal(fromHeader(BASE, '   '), BASE);
  assert.equal(fromHeader('avisos@portariaprime.com.br', 'Cond. A'), '"Cond. A via Portaria Prime" <avisos@portariaprime.com.br>');
});

test('nome malicioso não injeta cabeçalho nem troca o endereço', () => {
  const h = fromHeader(BASE, 'X" <atacante@evil.example>\r\nBcc: vitima@exemplo.com');
  assert.match(h, /<avisos@portariaprime\.com\.br>$/);
  assert.doesNotMatch(h, /[\r\n]|evil\.example>|<atacante/);
  assert.equal((h.match(/</g) || []).length, 1);
  assert.ok(fromHeader(BASE, 'A'.repeat(200)).length < 120, 'nome limitado');
});
