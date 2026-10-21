// Stack Supabase local SEM Docker, para E2E isolado e restore de verdade.
// Componentes oficiais: PostgreSQL 17 (EDB portátil), Supabase Auth (gotrue, binário Linux via WSL1),
// PostgREST e Supabase Storage (Node). Gateway local imita o Kong: /auth/v1, /rest/v1, /storage/v1.
// Nada aqui toca projeto hospedado. Dados ficam em %LOCALAPPDATA%\pp-stack (fora do Git).
//
//   node scripts/local-stack.mjs up      -> cria/inicia tudo, aplica migrations, grava .env.stack.local
//   node scripts/local-stack.mjs down    -> encerra processos
//   node scripts/local-stack.mjs reset   -> apaga o banco LOCAL e recria (só a pasta pp-stack)
// Pré-requisitos e download dos binários: docs/STACK_LOCAL.md.
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, openSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = join(process.env.LOCALAPPDATA || '', 'pp-stack');
const BIN = join(S, 'pg17', 'pgsql', 'bin');
const PG = { host: '127.0.0.1', port: 54329, password: 'postgres-local' };
const PORTS = { gateway: 54321, auth: 54331, rest: 54332, storage: 54333 };
const root = fileURLToPath(new URL('..', import.meta.url));
const cmd = process.argv[2] || 'up';
const stateFile = join(S, 'stack.json');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (secret, payload) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64(payload);
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
};

function psql(sql, db = 'postgres', user = 'postgres') {
  const r = spawnSync(join(BIN, 'psql.exe'), ['-h', PG.host, '-p', String(PG.port), '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql],
    { env: { ...process.env, PGPASSWORD: PG.password }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
function psqlFile(file) {
  const r = spawnSync(join(BIN, 'psql.exe'), ['-h', PG.host, '-p', String(PG.port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-1', '-f', file],
    { env: { ...process.env, PGPASSWORD: PG.password }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${file}: ${r.stderr}`);
}
const pgRunning = () => spawnSync(join(BIN, 'pg_ctl.exe'), ['-D', join(S, 'pgdata'), 'status']).status === 0;

async function waitHttp(url, ok = (s) => s < 500, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (ok(r.status)) return; } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Não respondeu: ${url}`);
}

function startDetached(name, file, args, env, cwd) {
  const log = openSync(join(S, `${name}.log`), 'a');
  const p = spawn(file, args, { env: { ...process.env, ...env }, cwd, detached: true, stdio: ['ignore', log, log], windowsHide: true });
  p.unref();
  return p.pid;
}

function ensureDb() {
  if (!existsSync(join(S, 'pgdata', 'PG_VERSION'))) {
    writeFileSync(join(S, 'pwfile'), PG.password);
    const r = spawnSync(join(BIN, 'initdb.exe'), ['-D', join(S, 'pgdata'), '-U', 'postgres', `--pwfile=${join(S, 'pwfile')}`, '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    writeFileSync(join(S, 'pgdata', 'postgresql.conf'), `\nport = ${PG.port}\nlisten_addresses = '127.0.0.1'\nwal_level = logical\nmax_connections = 200\n`, { flag: 'a' });
  }
  if (!pgRunning()) {
    // stdio ignorado: o postgres herdaria o pipe e o spawnSync nunca retornaria.
    const r = spawnSync(join(BIN, 'pg_ctl.exe'), ['-D', join(S, 'pgdata'), '-l', join(S, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`pg_ctl start falhou; veja ${join(S, 'pg.log')}`);
  }
}

function bootstrapRoles(secret) {
  // Papéis padrão do Supabase (nomes iguais aos do serviço hospedado).
  psql(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit password '${PG.password}'; end if;
      if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login createrole password '${PG.password}'; end if;
      if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin login createrole bypassrls password '${PG.password}'; end if;
    end $$;
    grant anon, authenticated, service_role to authenticator;
    grant anon, authenticated, service_role to supabase_storage_admin;
    create schema if not exists auth authorization supabase_auth_admin;
    create schema if not exists storage authorization supabase_storage_admin;
    create schema if not exists extensions;
    grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
    grant create on database postgres to supabase_auth_admin, supabase_storage_admin;
    alter role supabase_auth_admin set search_path = auth;
    alter role supabase_storage_admin set search_path = storage;
    create extension if not exists pgcrypto with schema extensions;
    do $$ begin if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if; end $$;
    alter database postgres set "app.settings.jwt_secret" = '${secret}';
  `);
}

async function up() {
  for (const f of [BIN, join(S, 'auth', 'auth'), join(S, 'artifacts', 'postgrest-windows-x64', 'postgrest.exe'), join(S, 'storage', 'dist', 'start', 'server.js')]) {
    if (!existsSync(f)) throw new Error(`Falta ${f}. Veja docs/STACK_LOCAL.md.`);
  }
  mkdirSync(S, { recursive: true });
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { secret: randomBytes(32).toString('hex') };
  const { secret } = state;
  const anon = sign(secret, { role: 'anon', iss: 'supabase-local', iat: 1700000000, exp: 4102444800 });
  const service = sign(secret, { role: 'service_role', iss: 'supabase-local', iat: 1700000000, exp: 4102444800 });
  ensureDb();
  bootstrapRoles(secret);
  const site = process.env.PP_SITE || 'http://127.0.0.1:3017';
  const dbUrl = (u) => `postgres://${u}:${PG.password}@${PG.host}:${PG.port}/postgres`;
  const pids = {};

  // Auth (Linux): WSL1 compartilha a rede do Windows (127.0.0.1).
  const wslAuth = `/mnt/${S[0].toLowerCase()}${S.slice(2).replaceAll('\\', '/')}/auth`.replace('//', '/');
  const authEnv = {
    GOTRUE_API_HOST: '127.0.0.1', PORT: String(PORTS.auth), API_EXTERNAL_URL: `http://127.0.0.1:${PORTS.gateway}/auth/v1`,
    GOTRUE_DB_DRIVER: 'postgres', DATABASE_URL: dbUrl('supabase_auth_admin'), DB_NAMESPACE: 'auth',
    GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_SITE_URL: site, GOTRUE_URI_ALLOW_LIST: `${site}/**`,
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_DISABLE_SIGNUP: 'false',
    GOTRUE_PASSWORD_MIN_LENGTH: '10', GOTRUE_SMTP_HOST: '127.0.0.1', GOTRUE_SMTP_PORT: '54325', GOTRUE_SMTP_ADMIN_EMAIL: 'stack@local.invalid',
    GOTRUE_MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify', GOTRUE_RATE_LIMIT_EMAIL_SENT: '1000', GOTRUE_LOG_LEVEL: 'warn',
  };
  // Variáveis em arquivo: o wsl.exe não preserva aspas de argumentos com espaços.
  writeFileSync(join(S, 'auth', 'run.sh'), `#!/bin/sh\n${Object.entries(authEnv).map(([k, v]) => `export ${k}='${v}'`).join('\n')}\ncd "$(dirname "$0")"\n./auth migrate && exec ./auth serve\n`);
  // wsl.exe não roda destacado ("Identificador inválido" sem console). Em outro terminal:
  //   wsl -d Debian -- sh <pp-stack>/auth/run.sh     (o script espera ele responder)
  console.log(`Auth: se não estiver no ar, rode em outro terminal: wsl -d Debian -- sh '${wslAuth}/run.sh'`);
  await waitHttp(`http://127.0.0.1:${PORTS.auth}/health`, (s) => s === 200, 180);

  mkdirSync(join(S, 'storage-data'), { recursive: true });
  pids.storage = startDetached('storage', join(S, 'node-v24.11.1-win-x64', 'node.exe'), ['dist/start/server.js'], {
    NODE_ENV: 'production', SERVER_HOST: '127.0.0.1', SERVER_PORT: String(PORTS.storage), SERVER_ADMIN_PORT: '54334',
    AUTH_JWT_SECRET: secret, AUTH_JWT_ALGORITHM: 'HS256', ANON_KEY: anon, SERVICE_KEY: service,
    DATABASE_URL: dbUrl('supabase_storage_admin'), DB_INSTALL_ROLES: 'false', DB_ANON_ROLE: 'anon', DB_SERVICE_ROLE: 'service_role',
    DB_AUTHENTICATED_ROLE: 'authenticated', DB_SUPER_USER: 'supabase_storage_admin', TENANT_ID: 'stub', REGION: 'local',
    STORAGE_BACKEND: 'file', STORAGE_FILE_BACKEND_PATH: join(S, 'storage-data'), GLOBAL_S3_BUCKET: 'stub', FILE_SIZE_LIMIT: '52428800',
    UPLOAD_FILE_SIZE_LIMIT: '52428800', IMAGE_TRANSFORMATION_ENABLED: 'false', PG_QUEUE_ENABLE: 'false', LOG_LEVEL: 'warn',
    PROMETHEUS_METRICS_ENABLED: 'false', OTEL_METRICS_ENABLED: 'false', RATE_LIMITER_ENABLED: 'false', STORAGE_PUBLIC_URL: `http://127.0.0.1:${PORTS.gateway}/storage/v1`,
  }, join(S, 'storage'));
  await waitHttp(`http://127.0.0.1:${PORTS.storage}/status`, (s) => s === 200, 120);

  // Migrations do projeto (depois que Auth e Storage criaram os schemas deles).
  psql(`create table if not exists public._pp_migrations (name text primary key, applied_at timestamptz default now())`);
  psql(`revoke all on public._pp_migrations from anon, authenticated`);
  const done = new Set(psql('select name from public._pp_migrations').split(/\r?\n/).filter(Boolean));
  const dir = join(root, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    psqlFile(join(dir, f));
    psql(`insert into public._pp_migrations (name) values ('${f}')`);
    console.log(`migration ${f}`);
  }
  // PostgREST só depois das migrations, e sempre uma instância nova: um processo antigo
  // na porta serviria o cache de schema velho (o NOTIFY não chega a ele de forma confiável).
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${PORTS.rest} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`]);
  pids.rest = startDetached('postgrest', join(S, 'artifacts', 'postgrest-windows-x64', 'postgrest.exe'), [], {
    PGRST_DB_URI: dbUrl('authenticator'), PGRST_DB_SCHEMAS: 'public,storage,graphql_public', PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: secret, PGRST_SERVER_PORT: String(PORTS.rest), PGRST_SERVER_HOST: '127.0.0.1', PGRST_DB_CHANNEL_ENABLED: 'true',
  }, S);
  await waitHttp(`http://127.0.0.1:${PORTS.rest}/`, (s) => s < 500, 60);

  writeFileSync(stateFile, JSON.stringify({ ...state, pids }, null, 2));
  pids.gateway = startDetached('gateway', process.execPath, [join(root, 'scripts', 'local-stack.mjs'), 'gateway'], {}, root);
  await waitHttp(`http://127.0.0.1:${PORTS.gateway}/auth/v1/health`, (s) => s === 200, 30);
  pids.smtp = startDetached('smtp', process.execPath, [join(root, 'scripts', 'local-stack.mjs'), 'smtp'], {}, root);

  writeFileSync(stateFile, JSON.stringify({ ...state, pids }, null, 2));
  const url = `http://127.0.0.1:${PORTS.gateway}`;
  writeFileSync(join(root, '.env.stack.local'),
    `# Stack local isolada (gerado por scripts/local-stack.mjs). Não versionar.\nSUPABASE_URL=${url}\nSUPABASE_ANON_KEY=${anon}\nSUPABASE_SERVICE_ROLE_KEY=${service}\nVITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\nPP_STACK_DB=postgres://postgres:${PG.password}@${PG.host}:${PG.port}/postgres\nPP_STACK_MAILBOX=${join(S, 'mailbox')}\n`);
  console.log(`Stack pronta em ${url} (.env.stack.local gravado).`);
}

// Gateway mínimo no lugar do Kong: valida apikey e repassa para o serviço certo.
function gateway() {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const routes = [['/auth/v1', PORTS.auth], ['/rest/v1', PORTS.rest], ['/storage/v1', PORTS.storage]];
  http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD', 'access-control-expose-headers': 'content-range,x-total-count,content-length', vary: 'origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const hit = routes.find(([p]) => req.url.startsWith(p));
    if (!hit) { res.writeHead(404, cors); return res.end('{"message":"not found"}'); }
    const url = new URL(req.url, 'http://x');
    const key = req.headers.apikey || url.searchParams.get('apikey');
    // Como o Kong do Supabase: health, URLs assinadas/públicas do Storage e links de e-mail do Auth dispensam apikey.
    const open = /^\/auth\/v1\/(health|verify|callback)|^\/storage\/v1\/(object|render\/image)\/(sign|public)\//.test(req.url);
    if (!open && !key) { res.writeHead(401, cors); return res.end('{"message":"No API key found in request"}'); }
    const headers = { ...req.headers, host: `127.0.0.1:${hit[1]}` };
    if (!headers.authorization && key) headers.authorization = `Bearer ${key}`;
    const p = http.request({ host: '127.0.0.1', port: hit[1], path: req.url.slice(hit[0].length) || '/', method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode, { ...up.headers, ...cors }); up.pipe(res);
    });
    p.on('error', (e) => { res.writeHead(502, cors); res.end(JSON.stringify({ message: e.message })); });
    req.pipe(p);
  }).listen(PORTS.gateway, '127.0.0.1');
  void state;
}

// Caixa de e-mail local: SMTP mínimo que grava as mensagens em arquivos (para links de confirmação nos testes).
function smtp() {
  const box = join(S, 'mailbox');
  mkdirSync(box, { recursive: true });
  import('node:net').then(({ createServer }) => createServer((sock) => {
    let data = false, buf = '', msg = '';
    sock.write('220 pp-stack\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; writeFileSync(join(box, `${Date.now()}-${Math.random().toString(36).slice(2)}.eml`), msg); msg = ''; sock.write('250 ok\r\n'); }
          else msg += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        const c = line.slice(0, 4).toUpperCase();
        if (c === 'EHLO' || c === 'HELO') sock.write('250-pp-stack\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (c === 'AUTH') sock.write('235 ok\r\n');
        else if (c === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (c === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  }).listen(54325, '127.0.0.1'));
}

function down() {
  if (existsSync(stateFile)) {
    const { pids = {} } = JSON.parse(readFileSync(stateFile, 'utf8'));
    for (const pid of Object.values(pids)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  }
  spawnSync('wsl.exe', ['-d', 'Debian', '--', 'pkill', '-f', 'auth serve']);
  if (pgRunning()) spawnSync(join(BIN, 'pg_ctl.exe'), ['-D', join(S, 'pgdata'), '-m', 'fast', 'stop'], { stdio: 'ignore' });
  console.log('Stack encerrada.');
}

if (cmd === 'up') await up();
else if (cmd === 'down') down();
else if (cmd === 'reset') {
  down();
  for (const d of ['pgdata', 'storage-data', 'mailbox']) rmSync(join(S, d), { recursive: true, force: true });
  await up();
} else if (cmd === 'gateway') gateway();
else if (cmd === 'smtp') smtp();
else { console.error('Uso: up | down | reset'); process.exit(2); }
