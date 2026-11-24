// Busca das Conversas: ignora maiúsculas, acentos, espaços, traços e pontuação; acha por nome, unidade, telefone e mensagem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, searchKey } from '../src/lib/chat-search.ts';

const c = { name: 'João da Silva', unit: 'Bloco 02B - Apto 11', phone: '+55 (11) 98888-7777', last: { text: 'A encomenda da Shopee chegou?' } };

test('chave de busca sem acento, espaço, traço e pontuação', () => {
  assert.equal(searchKey(' João  da-Silva. '), 'joaodasilva');
});

test('acha independentemente de espaço, traço, acento e maiúsculas', () => {
  for (const q of ['joao', 'JOÃO DA', 'joaodasilva', 'da-silva', '02B', '02b11', '02B - 11', 'bloco 02b apto 11', 'bl02bap11',
    '2b 11', '98888-7777', '988887777', '11988887777', '5511988887777', '(11) 98888', 'shopee', 'encomenda da', 'chegou']) {
    assert.ok(matches(c, q), `deveria achar: "${q}"`);
  }
});

test('não acha o que não está na conversa', () => {
  for (const q of ['maria', 'apto 12', '03B', '97777', 'amazon']) assert.ok(!matches(c, q), `não deveria achar: "${q}"`);
});

test('busca vazia mostra tudo; conversa sem nome nem última mensagem não quebra', () => {
  assert.ok(matches(c, '   '));
  assert.ok(!matches({ name: null, unit: null, phone: null, last: null }, 'ana'));
});
