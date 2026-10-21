// Ajuda e tours: busca com acentos/sinônimos, links entre artigos/tours e alvos reais no código.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ARTICLES, searchArticles, articlesFor } from '../src/lib/help.ts';
import { TOURS, toursFor } from '../src/lib/tours.ts';

const src = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? src(p) : p.endsWith('.tsx') ? [p] : []; });
const code = src('src').map((f) => readFileSync(f, 'utf8')).join('\n');

test('busca ignora acentos e entende sinônimos', () => {
  assert.ok(searchArticles(ARTICLES, 'camera').some((a) => a.slug === 'camera'));
  assert.ok(searchArticles(ARTICLES, 'pacote').some((a) => a.slug === 'receber-encomenda'));
  assert.ok(searchArticles(ARTICLES, 'apartamento').some((a) => a.slug === 'unidades-e-importacao'));
  assert.ok(searchArticles(ARTICLES, 'retirada').some((a) => a.slug === 'entregar-encomenda'));
  assert.equal(searchArticles(ARTICLES, 'xyzzy inexistente').length, 0);
});

test('todo alvo de tour existe como data-tour no código', () => {
  for (const t of TOURS) for (const s of t.steps) assert.ok(code.includes(`data-tour="${s.target}"`), `${t.id}: alvo ${s.target} ausente`);
});

test('artigos e tours se referenciam corretamente', () => {
  const slugs = new Set(ARTICLES.map((a) => a.slug));
  for (const a of ARTICLES) for (const n of a.next) assert.ok(slugs.has(n), `${a.slug} -> ${n}`);
  for (const t of TOURS) assert.ok(slugs.has(t.article), `${t.id} -> ${t.article}`);
  for (const a of ARTICLES) if (a.tour) assert.ok(TOURS.some((t) => t.id === a.tour), `${a.slug} -> tour ${a.tour}`);
});

test('morador não recebe artigos ou tours administrativos', () => {
  assert.ok(articlesFor('morador').every((a) => a.roles.includes('morador')));
  assert.deepEqual(toursFor('morador', () => true).map((t) => t.id), ['morador']);
  assert.ok(toursFor('admin', () => false).every((t) => !t.requires));
});
