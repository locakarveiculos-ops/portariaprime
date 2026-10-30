// Compatibilidade do CSS gerado pelo Tailwind 4 com WebViews antigas (Android 8+, Chrome 64+; o
// Samsung A10s com Android 11 veio com WebView 83). Sem isso a página carrega sem estilos ou com
// layout quebrado: navegadores antes do Chrome 99 ignoram @layer inteiro e antes do 111 não entendem
// color-mix(). Ordem: camadas viram especificidade, depois o lightningcss rebaixa sintaxe e
// gera fallbacks (cores, :is/:where, inset, translate, aninhamento etc.). O CSS moderno continua igual
// em efeito para navegadores atuais.
import postcss from 'postcss';
import cascadeLayers from '@csstools/postcss-cascade-layers';
import { transform } from 'lightningcss';

const v = (major) => major << 16;
export const LEGACY_TARGETS = { chrome: v(64), android: v(64), samsung: v(9), safari: v(12), ios_saf: v(12), firefox: v(60), edge: v(79) };

/** @@property só existe no Chrome 85+: as variáveis do Tailwind precisam de valor inicial explícito. */
function propertyFallbacks(css) {
  const init = [];
  css.replace(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g, (_m, name, body) => {
    const iv = body.match(/initial-value\s*:\s*([^;]+)/);
    if (iv) init.push(`${name}:${iv[1].trim()}`);
    return '';
  });
  return init.length ? `*,::before,::after,::backdrop{${init.join(';')}}` : '';
}

/** Declarações sem suporte antigo ganham a versão equivalente ANTES (o navegador fica com a última que entende). */
function declFallbacks() {
  return {
    postcssPlugin: 'pp-decl-fallbacks',
    Declaration(d) {
      if (d.__pp) return;
      // translate/scale/rotate individuais: Chrome 104+. transform existe desde sempre.
      if (d.prop === 'translate' && !/^none$/.test(d.value)) d.cloneBefore({ prop: 'transform', value: `translate(${d.value.trim().split(/\s+/).join(',')})`, __pp: true });
      if (d.prop === 'scale' && !/^none$/.test(d.value)) d.cloneBefore({ prop: 'transform', value: `scale(${d.value.trim().split(/\s+/).join(',')})`, __pp: true });
      if (d.prop === 'rotate' && /^-?[\d.]+(deg|turn|rad)$/.test(d.value.trim())) d.cloneBefore({ prop: 'transform', value: `rotate(${d.value.trim()})`, __pp: true });
      // dvh/svh/lvh: Chrome 108+. vh é o equivalente antigo.
      if (/\d(d|s|l)vh\b/.test(d.value)) d.cloneBefore({ value: d.value.replace(/(\d)(d|s|l)vh\b/g, '$1vh'), __pp: true });
      // Propriedades lógicas (padding-inline etc.): Chrome 87+. Sem elas o conteúdo encosta na borda.
      // O app é só LTR (pt-BR): inline = left/right, block = top/bottom.
      const LOGICAL = {
        'padding-inline': ['padding-left', 'padding-right'], 'padding-block': ['padding-top', 'padding-bottom'],
        'margin-inline': ['margin-left', 'margin-right'], 'margin-block': ['margin-top', 'margin-bottom'],
        'padding-inline-start': ['padding-left'], 'padding-inline-end': ['padding-right'],
        'margin-inline-start': ['margin-left'], 'margin-inline-end': ['margin-right'],
        'inset-inline': ['left', 'right'], 'inset-block': ['top', 'bottom'],
        'border-inline-width': ['border-left-width', 'border-right-width'], 'border-block-width': ['border-top-width', 'border-bottom-width'],
      };
      const phys = LOGICAL[d.prop];
      if (phys) {
        const parts = d.value.trim().split(/\s+(?![^(]*\))/);
        phys.forEach((p, i) => d.cloneBefore({ prop: p, value: parts[Math.min(i, parts.length - 1)], __pp: true }));
      }
    },
  };
}

/**
 * gap em flexbox: Chrome 84+ (o A10s tem WebView 83 — ícone e texto colavam). Para cada regra com
 * gap/column-gap/row-gap, gera margem entre filhos (> * + *) só quando o navegador NÃO suporta.
 * Detecção: @supports não distingue gap de grid e de flex; usa-se a classe .pp-no-flex-gap no <html>,
 * colocada por src/lib/polyfills.ts após medir o suporte real.
 */
function flexGapFallback() {
  return {
    postcssPlugin: 'pp-flex-gap',
    Rule(rule) {
      if (rule.__ppGap || rule.parent?.type === 'atrule' && rule.parent.name === 'keyframes') return;
      let col = null, row = null;
      rule.walkDecls((d) => {
        if (d.prop === 'gap') { const [r, c] = d.value.trim().split(/\s+(?![^(]*\))/); row = r; col = c || r; }
        if (d.prop === 'column-gap') col = d.value;
        if (d.prop === 'row-gap') row = d.value;
      });
      if (!col && !row) return;
      // Só containers flex (grid já tinha gap no Chrome 66). Especificidade de propósito entre a base
      // (2× :not(#\#)) e os utilitários (4×): vence o reset de margem, perde para ml-auto/mt-* do filho.
      const base = rule.selectors.map((s) => s.replace(/:not\(#\\#\)/g, '')).filter((s) => /^\.[\w\\-]+$/.test(s));
      if (!base.length) return;
      const k = ':not(#\\#):not(#\\#):not(#\\#)';
      const on = (suffix) => base.flatMap((s) => ['.flex', '.inline-flex'].map((f) => `.pp-no-flex-gap ${f}${s}${k}${suffix}`));
      const out = [];
      // flex-row (padrão) usa a lacuna de coluna; flex-col usa a de linha.
      // Entre elementos: margem à direita de todos menos o último. Ícone + texto solto (o texto não é
      // elemento, CSS não o enxerga): o ícone único ganha a margem. Limite conhecido: botão só com ícone
      // fica 1 lacuna fora de centro nesses navegadores antigos.
      if (col) out.push(postcss.rule({ selectors: [...on(':not(.flex-col)>*:not(:last-child)'), ...on(':not(.flex-col)>svg:only-child')] })
        .append({ prop: 'margin-right', value: col }));
      if (row) out.push(postcss.rule({ selectors: on('.flex-col>*+*') }).append({ prop: 'margin-top', value: row }));
      // Itens que quebram linha (flex-wrap): sem como saber a quebra; dá respiro vertical mínimo.
      if (row) out.push(postcss.rule({ selectors: on('.flex-wrap>*') }).append({ prop: 'margin-bottom', value: row }));
      for (const r of out.reverse()) { r.__ppGap = true; rule.after(r); }
    },
  };
}

/**
 * :where()/:is() só existem a partir do Chrome 88: um seletor que os contém é descartado inteiro por
 * navegadores antigos (ex.: space-y-*, que dá o espaçamento das telas). Como as camadas já viraram
 * especificidade explícita, um :where com UMA alternativa simples equivale ao seletor sem ele.
 * Com várias alternativas, a regra é duplicada para cada uma (seletores separados, sem :is).
 */
/** Divide por vírgula de nível zero (ignora vírgulas dentro de parênteses). */
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Expande o primeiro :where(...)/:is(...) de um seletor em uma lista de seletores equivalentes. */
function expandOnce(sel) {
  const m = /:(where|is)\(/.exec(sel);
  if (!m) return null;
  let depth = 0, end = -1;
  for (let i = m.index + m[0].length - 1; i < sel.length; i++) {
    if (sel[i] === '(') depth++;
    else if (sel[i] === ')' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return null;
  const inner = sel.slice(m.index + m[0].length, end);
  return splitTop(inner).map((alt) => sel.slice(0, m.index) + alt + sel.slice(end + 1));
}

function unwrapWhere() {
  return {
    postcssPlugin: 'pp-unwrap-where',
    Rule(rule) {
      if (rule.__ppWhere || !/:(where|is)\(/.test(rule.selector)) return;
      // Prefixos de navegador (-webkit-any/-moz-any) e :lang em lista longa: só reset de <select>; mantém.
      if (/-(webkit|moz)-any|:lang\(/.test(rule.selector)) return;
      let list = rule.selectors;
      for (let pass = 0; pass < 4 && list.some((s) => /:(where|is)\(/.test(s)); pass++) {
        list = list.flatMap((s) => expandOnce(s) || [s]);
        if (list.length > 40) return;
      }
      if (list.some((s) => /:(where|is)\(/.test(s))) return;
      rule.cloneBefore({ selectors: list, __ppWhere: true });
    },
  };
}

export async function legacyCss(code, filename = 'index.css') {
  const flat = (await postcss([cascadeLayers(), declFallbacks()]).process(code, { from: filename })).css;
  const { code: lowered } = transform({ filename, code: Buffer.from(flat), minify: true, targets: LEGACY_TARGETS });
  // :where/:is também nascem do rebaixamento (aninhamento do Tailwind): expande no resultado final.
  // A lacuna de flex usa os seletores já com a especificidade das camadas.
  const out = (await postcss([unwrapWhere(), flexGapFallback()]).process(lowered.toString(), { from: filename })).css;
  // Valores iniciais primeiro: as regras reais do app vêm depois e prevalecem.
  return propertyFallbacks(flat) + out;
}

/** Plugin Vite: reescreve só os .css emitidos no build de produção. @returns {import('vite').Plugin} */
export function legacyCssPlugin() {
  return {
    name: 'pp-legacy-css',
    apply: /** @type {const} */ ('build'),
    enforce: /** @type {const} */ ('post'),
    async generateBundle(_opts, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type === 'asset' && f.fileName.endsWith('.css')) f.source = await legacyCss(String(f.source), f.fileName);
      }
    },
  };
}
