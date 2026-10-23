// Tutoriais públicos: cada um completo (objetivo, passos, resultado), capturas existentes,
// "próximo" válido e no mesmo perfil, e os três perfis cobertos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PROFILES, TUTORIALS, searchTutorials } from '../src/lib/tutorials.ts';
import { SCREENS } from '../src/lib/screens.ts';

test('tutoriais completos e coerentes', () => {
  const slugs = new Set();
  for (const t of TUTORIALS) {
    assert.ok(!slugs.has(t.slug), `slug repetido ${t.slug}`); slugs.add(t.slug);
    assert.ok(t.goal && t.result && t.steps.length >= 1, `${t.slug} incompleto`);
    for (const s of t.steps) {
      assert.ok(s.title && s.text.length > 20, `${t.slug}: passo vago`);
      if (s.screen) assert.ok(existsSync(`public${SCREENS[s.screen].file}`), `${t.slug}: captura ausente ${s.screen}`);
    }
    if (t.next) {
      const n = TUTORIALS.find((x) => x.slug === t.next);
      assert.ok(n && n.profile === t.profile, `${t.slug} -> ${t.next}`);
    }
  }
  for (const p of Object.keys(PROFILES)) assert.ok(TUTORIALS.filter((t) => t.profile === p).length >= 4, `perfil ${p} com poucos tutoriais`);
});

test('busca encontra tarefas por palavras do dia a dia', () => {
  assert.ok(searchTutorials('qr').some((t) => t.slug === 'retirar'));
  assert.ok(searchTutorials('aprovar morador').some((t) => t.slug === 'aprovar-moradores'));
  assert.ok(searchTutorials('etiqueta').some((t) => t.slug === 'receber'));
  assert.equal(searchTutorials('xyzzy').length, 0);
});

test('tutoriais não prometem o que não existe', () => {
  const all = JSON.stringify(TUTORIALS).toLowerCase();
  for (const banned of ['app store', 'play store', 'ilimitad', '24h', '99,9', 'api oficial']) assert.ok(!all.includes(banned), banned);
});
