// Prova de login após restauração: Supabase Auth separado (porta 54341) lendo o CLUSTER RESTAURADO (54339).
// Pré-requisito: scripts/restore-drill.mjs executado; Auth do restaurado iniciado com:
//   wsl -d Debian -- sh <pp-stack>/auth/run-restore.sh   (gerado por este script na 1ª execução)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const S = join(process.env.LOCALAPPDATA, 'pp-stack');
const run = readFileSync(join(S, 'auth', 'run.sh'), 'utf8')
  .replace(/PORT='\d+'/, "PORT='54341'").replace(/@127\.0\.0\.1:54329\//, '@127.0.0.1:54339/').replace('./auth migrate && ', '');
writeFileSync(join(S, 'auth', 'run-restore.sh'), run);
const last = readdirSync(join(S, 'backups')).sort().at(-1);
const sentinel = JSON.parse(readFileSync(join(S, 'backups', last, 'sentinel.json'), 'utf8'));
let health;
for (let i = 0; i < 30 && !health; i++) { try { health = (await fetch('http://127.0.0.1:54341/health')).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
if (!health) { console.log('Inicie o Auth do restaurado: wsl -d Debian -- sh /mnt/c/.../pp-stack/auth/run-restore.sh'); process.exit(2); }
const r = await fetch('http://127.0.0.1:54341/token?grant_type=password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sentinel) });
const body = await r.json();
if (r.status !== 200 || !body.access_token) throw new Error(`Login no restaurado falhou: ${r.status} ${body.error_description || body.msg || ''}`);
const bad = await fetch('http://127.0.0.1:54341/token?grant_type=password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...sentinel, password: 'senha-errada-123' }) });
if (bad.status === 200) throw new Error('senha errada aceita');
console.log(`PASS login com senha original no banco restaurado (${last}); senha errada recusada (${bad.status}).`);
