// Vite (3017) + API local (3019) apontando para a stack Supabase local (.env.stack.local).
// Recusa rodar se a URL não for loopback: nunca liga o dev server de teste em produção.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertLocalSupabase } from '../tests/e2e/environment.mjs';

const env = Object.fromEntries(readFileSync('.env.stack.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
assertLocalSupabase(env.SUPABASE_URL);
const base = { ...process.env, ...env, APP_URL: 'http://127.0.0.1:3017', CRON_SECRET: 'local-stack-cron-secret-0000000000' };
const procs = [
  spawn(process.execPath, ['--import', 'tsx', 'scripts/dev-api.mjs'], { env: base, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port=3017', '--host=127.0.0.1', '--strictPort'], { env: { ...base, DISABLE_HMR: 'true' }, stdio: 'inherit' }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
