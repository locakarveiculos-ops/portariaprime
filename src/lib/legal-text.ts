// Funções puras dos documentos legais (sem React/Vite; testáveis no Node).

/** Separa o cabeçalho `---\nchave: valor\n---` do corpo. */
export function parseDraft(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const ln of m[1].split('\n')) { const i = ln.indexOf(':'); if (i > 0) meta[ln.slice(0, i).trim()] = ln.slice(i + 1).trim(); }
  return { meta, body: text.slice(m[0].length) };
}

export const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Títulos (## e ###) para o índice. */
export function headings(md: string) {
  return md.split('\n').map((l) => l.match(/^(#{2,3})\s+(.+)$/)).filter(Boolean).map((m) => ({ level: m![1].length, text: m![2].trim(), id: slug(m![2]) }));
}

/** Mesmos marcadores que impedem publicação no banco (app.legal_pending_marks). */
export const pendingMarks = (md: string) => [...new Set(md.match(/\{\{[A-Z0-9_]+\}\}|\[(?:PENDENTE|A DEFINIR|A VERIFICAR)[^\]]*\]/g) || [])];

/** Diff de linhas (LCS) — suficiente para revisar versões de documentos. */
export function lineDiff(a: string, b: string): { op: ' ' | '-' | '+'; text: string }[] {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  // ponytail: LCS O(n·m); acima de ~4M células mostra remoção/inclusão total. Trocar por Myers se documentos crescerem.
  if (n * m > 4_000_000) return [...x.map((t) => ({ op: '-' as const, text: t })), ...y.map((t) => ({ op: '+' as const, text: t }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  return out;
}
