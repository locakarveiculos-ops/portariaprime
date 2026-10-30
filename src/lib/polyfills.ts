/**
 * Recursos que o app usa e que WebViews antigas não têm (Android 8–11; o Samsung A10s veio com
 * Chrome/WebView 83). Carregado antes de tudo em main.tsx. Só preenche o que falta: em navegador
 * atual nada muda. Achado real: sem crypto.randomUUID a tela da portaria quebrava ao abrir.
 */
const g: any = globalThis;

if (g.crypto && typeof g.crypto.randomUUID !== 'function' && typeof g.crypto.getRandomValues === 'function') {
  g.crypto.randomUUID = function randomUUID(): string {
    const b = g.crypto.getRandomValues(new Uint8Array(16)) as Uint8Array;
    b[6] = (b[6] & 0x0f) | 0x40; // versão 4
    b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
  };
}

if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout !== 'function') {
  (AbortSignal as any).timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('Tempo esgotado', 'TimeoutError')), ms);
    return c.signal;
  };
}

// gap em flexbox (Chrome 84+): sem ele ícone e texto dos botões colam. O CSS de produção traz margens
// equivalentes sob .pp-no-flex-gap (scripts/legacy-css.mjs); aqui só se mede o suporte real.
try {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
  d.appendChild(document.createElement('div'));
  d.appendChild(document.createElement('div'));
  document.documentElement.appendChild(d);
  if (d.scrollHeight !== 1) document.documentElement.classList.add('pp-no-flex-gap');
  d.remove();
} catch { /* sem DOM (testes) */ }

export {};
