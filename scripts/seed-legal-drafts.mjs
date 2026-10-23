// SOMENTE DESENVOLVIMENTO/HOMOLOGAÇÃO: grava as minutas de docs/legal como RASCUNHO (status draft).
// Nunca publica e não preenche dados da contratada. Recusa rodar se APP_URL não for local,
// a menos que ALLOW_LEGAL_DRAFT_SEED=1 (ex.: homologação).
// Uso: node --env-file=.env.api.local scripts/seed-legal-drafts.mjs
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const FILES = { contrato_saas: 'contrato-saas', termos: 'termos', privacidade: 'privacidade', anexo_dados: 'anexo-tratamento-dados' };
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!url || !key) { console.error('Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) && process.env.ALLOW_LEGAL_DRAFT_SEED !== '1') {
  console.error('Banco não local. Defina ALLOW_LEGAL_DRAFT_SEED=1 para confirmar.'); process.exit(1);
}
const svc = createClient(url, key, { auth: { persistSession: false } });
for (const [kind, file] of Object.entries(FILES)) {
  const raw = readFileSync(new URL(`../docs/legal/${file}.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = Object.fromEntries((m?.[1] || '').split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  const { error } = await svc.from('legal_documents').upsert({ kind, version: meta.version || '0.1-rascunho', status: 'draft',
    content_md: raw.slice(m?.[0].length || 0), content_sha256: '', summary: meta.summary || null }, { onConflict: 'kind,version', ignoreDuplicates: true });
  console.log(kind, error ? `erro: ${error.message}` : 'rascunho ok');
}
