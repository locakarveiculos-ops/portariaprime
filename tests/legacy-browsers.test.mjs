// Compatibilidade com WebViews antigas (Android 8+; Samsung A10s com Android 11 = WebView 83).
// Achado real: na WebView 83 a portaria quebrava (crypto.randomUUID ausente) e o layout vinha sem
// estilos (@layer ignorado), sem espaçamento (:where, padding-inline) e com ícones colados no texto (gap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyCss } from '../scripts/legacy-css.mjs';

const TW = `@layer theme{:root{--spacing:.25rem}}
@layer utilities{
.px-4{padding-inline:calc(var(--spacing)*4)}
.h-dvh{height:100dvh}
.-translate-y-1\\/2{--tw-translate-y:-50%;translate:var(--tw-translate-x) var(--tw-translate-y)}
.gap-2{gap:calc(var(--spacing)*2)}
:where(.space-y-4>:not(:last-child)){margin-top:1rem}
}
@property --tw-translate-x{syntax:"*";inherits:false;initial-value:0}`;

test('CSS do Tailwind 4 vira CSS que WebView 64–110 entende', async () => {
  const css = await legacyCss(TW, 'index.css');
  assert.doesNotMatch(css, /@layer/, 'sem @layer (Chrome < 99 ignora o bloco inteiro)');
  assert.match(css, /padding-left:calc\(var\(--spacing\) \* 4\)|padding-left:calc\(var\(--spacing\)\*4\)/, 'padding-inline → left/right');
  assert.match(css, /height:100vh/, 'dvh com vh antes');
  assert.match(css, /transform:translate\(/, 'translate individual com transform');
  assert.match(css, /\.space-y-4>:not\(:last-child\)[^{]*\{/, 'space-y sem :where');
  assert.match(css, /\*,::before,::after,::backdrop\{--tw-translate-x:0/, '@property com valor inicial explícito');
  assert.match(css, /\.pp-no-flex-gap \.flex\.gap-2/, 'gap de flex com margem sob .pp-no-flex-gap');
});

test('regras modernas continuam presentes para navegadores atuais', async () => {
  const css = await legacyCss(TW, 'index.css');
  assert.match(css, /padding-inline/);
  assert.match(css, /100dvh/);
  assert.match(css, /translate:var\(--tw-translate-x\)/);
});
