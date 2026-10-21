// Ensaio de backup e restauração FÍSICA na stack local: banco inteiro (public + auth + storage) com pg_dump
// e binários do Storage, empacotados e criptografados (AES-256-GCM); restauração num CLUSTER POSTGRES NOVO
// (porta 54339), com verificação de contagens, FKs, checksums dos objetos e login com a senha original.
// Nunca toca produção: origem precisa ser loopback (stack local). Saída fora do repositório.
//   BACKUP_PASSPHRASE=... node --env-file=.env.stack.local scripts/restore-drill.mjs
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { assertLocalSupabase } from '../tests/e2e/environment.mjs';

assertLocalSupabase(process.env.SUPABASE_URL);
const pass = process.env.BACKUP_PASSPHRASE;
if (!pass || pass.length < 20) throw new Error('BACKUP_PASSPHRASE precisa ter pelo menos 20 caracteres.');
const S = join(process.env.LOCALAPPDATA, 'pp-stack');
const BIN = join(S, 'pg17', 'pgsql', 'bin');
const PW = 'postgres-local';
const SRC = { port: 54329 }, DST = { port: 54339, data: join(S, 'restore-pgdata') };
const out = join(S, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const env = { ...process.env, PGPASSWORD: PW };
const sh = (exe, args, opts = {}) => { const r = spawnSync(join(BIN, exe), args, { env, encoding: 'utf8', maxBuffer: 1 << 28, ...opts }); if (r.status !== 0) throw new Error(`${exe}: ${r.stderr}`); return r.stdout; };
const q = (port, sql) => sh('psql.exe', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-qAt', '-c', sql]).trim();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const files = (d) => existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; }) : [];
const log = (m) => console.log(`• ${m}`);

// 0) Sentinela: conta sintética com senha conhecida, para provar login no restaurado (só stack local).
const { createClient } = await import('@supabase/supabase-js');
const sentinel = { email: `restore-${Date.now()}@drill.portariaprime.invalid`, password: `R${randomBytes(12).toString('hex')}!` };
{ const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error } = await svc.auth.admin.createUser({ ...sentinel, email_confirm: true }); if (error) throw error; }
writeFileSync(join(out, 'sentinel.json'), JSON.stringify(sentinel)); // conta sintética local, fora do repositório

// 1) Backup
const TABLES = q(SRC.port, `select string_agg(format('%I.%I', schemaname, tablename), ',' order by 1) from pg_tables where schemaname in ('public','auth','storage')`).split(',');
const counts = Object.fromEntries(TABLES.map((t) => [t, Number(q(SRC.port, `select count(*) from ${t}`))]));
const dump = sh('pg_dump.exe', ['-h', '127.0.0.1', '-p', String(SRC.port), '-U', 'postgres', '-d', 'postgres', '-Fc', '--no-owner', '--no-acl', '-n', 'public', '-n', 'auth', '-n', 'storage', '-n', 'app', '-n', 'extensions'], { encoding: 'buffer' });
const storageRoot = join(S, 'storage-data');
const objs = files(storageRoot).filter((f) => !f.endsWith('.xattr.json') && !/\.tmp/.test(f)).map((f) => ({ path: relative(storageRoot, f), sha: sha(readFileSync(f)), data: readFileSync(f).toString('base64'), meta: existsSync(`${f}.xattr.json`) ? readFileSync(`${f}.xattr.json`, 'utf8') : null }));
const bundle = Buffer.from(JSON.stringify({ format: 'pp-physical-1', createdAt: new Date().toISOString(), counts, dump: dump.toString('base64'), objects: objs }));
const salt = randomBytes(16), iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', scryptSync(pass, salt, 32), iv);
const enc = Buffer.concat([c.update(bundle), c.final()]);
const file = join(out, 'portaria-prime.backup.enc');
writeFileSync(file, Buffer.concat([Buffer.from('PPB1'), salt, iv, c.getAuthTag(), enc]));
log(`backup: ${TABLES.length} tabelas, ${Object.values(counts).reduce((a, b) => a + b, 0)} linhas, ${objs.length} objetos, ${(statSync(file).size / 1024).toFixed(0)} KiB criptografado`);

// 2) Restore em cluster novo
const raw = readFileSync(file);
assert(raw.subarray(0, 4).toString() === 'PPB1', 'cabeçalho');
const d = createDecipheriv('aes-256-gcm', scryptSync(pass, raw.subarray(4, 20), 32), raw.subarray(20, 32));
d.setAuthTag(raw.subarray(32, 48));
const b = JSON.parse(Buffer.concat([d.update(raw.subarray(48)), d.final()]).toString('utf8'));
spawnSync(join(BIN, 'pg_ctl.exe'), ['-D', DST.data, '-m', 'fast', 'stop'], { stdio: 'ignore' });
rmSync(DST.data, { recursive: true, force: true });
writeFileSync(join(S, 'pwfile'), PW);
sh('initdb.exe', ['-D', DST.data, '-U', 'postgres', `--pwfile=${join(S, 'pwfile')}`, '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256']);
writeFileSync(join(DST.data, 'postgresql.conf'), `\nport = ${DST.port}\nlisten_addresses = '127.0.0.1'\n`, { flag: 'a' });
if (spawnSync(join(BIN, 'pg_ctl.exe'), ['-D', DST.data, '-l', join(S, 'restore-pg.log'), '-w', 'start'], { stdio: 'ignore' }).status !== 0) throw new Error('cluster de restauração não subiu');
// Papéis do Supabase (globais, não vão no pg_dump).
q(DST.port, `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role authenticator login noinherit password '${PW}'; create role supabase_auth_admin login createrole password '${PW}';
  create role supabase_storage_admin login createrole bypassrls password '${PW}';
  grant anon, authenticated, service_role to authenticator, supabase_storage_admin;
  drop schema public;`); // o dump recria o schema public com o conteúdo original
const dumpFile = join(out, 'restore.dump');
writeFileSync(dumpFile, Buffer.from(b.dump, 'base64'));
sh('pg_restore.exe', ['-h', '127.0.0.1', '-p', String(DST.port), '-U', 'postgres', '-d', 'postgres', '--no-owner', '--exit-on-error', '-1', dumpFile]);
rmSync(dumpFile);
// --no-owner/--no-acl: dono e grants vêm das definições conhecidas (como no projeto Supabase novo).
// Achado do ensaio: sem devolver a POSSE das tabelas do auth, a RLS (sem policies) esconde todos os
// usuários do serviço Auth e ninguém consegue entrar, embora os dados estejam lá.
q(DST.port, `do $$ declare r record; begin
    for r in select format('%I.%I', schemaname, tablename) t, schemaname s from pg_tables where schemaname in ('auth', 'storage') loop
      execute format('alter table %s owner to %I', r.t, case r.s when 'auth' then 'supabase_auth_admin' else 'supabase_storage_admin' end);
    end loop; end $$;
  alter schema auth owner to supabase_auth_admin; grant all on all tables in schema auth to supabase_auth_admin;
  grant all on all sequences in schema auth to supabase_auth_admin; grant all on all functions in schema auth to supabase_auth_admin;
  alter role supabase_auth_admin set search_path = auth; alter schema storage owner to supabase_storage_admin;
  grant all on all tables in schema storage to supabase_storage_admin; grant usage on schema auth, storage, public to anon, authenticated, service_role;`);
const restoredStorage = join(S, 'restore-storage-data');
rmSync(restoredStorage, { recursive: true, force: true });
for (const o of b.objects) {
  const p = join(restoredStorage, o.path);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, Buffer.from(o.data, 'base64'));
  if (o.meta) writeFileSync(`${p}.xattr.json`, o.meta);
}
log('restaurado em cluster novo (porta 54339) e pasta de objetos separada');

// 3) Verificação
let diffs = 0;
for (const [t, n] of Object.entries(b.counts)) { const m = Number(q(DST.port, `select count(*) from ${t}`)); if (m !== n) { diffs++; console.error(`  contagem ${t}: ${n} -> ${m}`); } }
assert(diffs === 0, 'contagens iguais');
log(`contagens idênticas em ${Object.keys(b.counts).length} tabelas`);
const badFk = q(DST.port, `select count(*) from pg_constraint where contype = 'f' and not convalidated`);
assert(badFk === '0', 'FKs validadas');
// pg_restore recria FKs validando dados existentes; um teste extra de integridade relacional:
const orphans = q(DST.port, `select (select count(*) from public.packages p where not exists (select 1 from public.tenants t where t.id = p.tenant_id))
  + (select count(*) from public.package_attachments a where not exists (select 1 from storage.objects o where o.bucket_id = 'tenant-private' and o.name = a.object_path))`);
assert(orphans === '0', 'sem órfãos (encomenda sem condomínio, anexo sem objeto)');
log('FKs válidas; nenhum anexo aponta para objeto inexistente');
let okObj = 0;
for (const o of b.objects) { if (sha(readFileSync(join(restoredStorage, o.path))) === o.sha) okObj++; }
assert(okObj === b.objects.length, 'checksums dos objetos');
log(`${okObj}/${b.objects.length} objetos com checksum idêntico`);
const sameHashes = q(DST.port, `select count(*) from auth.users where encrypted_password like '$2%'`);
log(`${sameHashes} identidades com hash de senha restauradas (login pode ser verificado com o Auth apontando para o cluster restaurado)`);
writeFileSync(join(out, 'RELATORIO.txt'), [`Backup: ${file}`, `Tabelas: ${Object.keys(b.counts).length}`, `Linhas: ${Object.values(b.counts).reduce((a, x) => a + x, 0)}`,
  `Objetos: ${b.objects.length} (checksums ok)`, `Identidades com senha: ${sameHashes}`, `Verificado em: ${new Date().toISOString()}`].join('\n'));
console.log(`PASS restore físico. Relatório: ${join(out, 'RELATORIO.txt')}`);
console.log(`Para testar login no restaurado: pare o Auth e suba com DATABASE_URL na porta ${DST.port}; ou use scripts/restore-drill-login.mjs.`);

function assert(c, m) { if (!c) throw new Error(`Falhou: ${m}`); }
