// Ensaio de backup → restore: gera dados no banco A (seed de demonstração), exporta no
// mesmo formato do scripts/backup-prime.mjs, criptografa, restaura em banco B limpo e
// confere contagens e checksums. Não toca rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createDb } from './harness.mjs';
import { decryptBackup, restoreInto } from '../../scripts/restore-prime.mjs';

test('backup criptografado restaura em banco isolado com contagens e objetos idênticos', async () => {
  const source = await createDb();
  await source.sql("insert into app.config values ('allow_demo_seed','on')");
  await source.raw.exec(readFileSync('supabase/seed/demo.sql', 'utf8'));
  const [t] = await source.sql("select id from public.tenants where slug = 'demo-aurora'");
  const bytes = Buffer.from('foto-sintetica');
  await source.sql("insert into storage.objects (bucket_id, name) values ('tenant-private', $1)", [`${t.id}/packages/x/label_photo-abcdefgh.jpg`]);

  const tables = [...new Set(readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()
    .flatMap((f) => [...readFileSync(`supabase/migrations/${f}`, 'utf8').matchAll(/create table public\.(\w+)/gi)].map((m) => m[1])))];
  const bundle = { tables: {}, counts: {}, authInventory: [], objects: [] };
  for (const tb of tables) {
    const rows = await source.sql(`select * from public.${tb}`);
    bundle.tables[tb] = JSON.parse(JSON.stringify(rows));
    bundle.counts[tb] = rows.length;
  }
  bundle.authInventory = await source.sql('select id, email, email_confirmed_at from auth.users');
  bundle.objects = [{ bucket: 'tenant-private', key: `${t.id}/packages/x/label_photo-abcdefgh.jpg`, sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') }];

  const pass = 'senha-de-teste-com-mais-de-vinte';
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', scryptSync(pass, salt, 32), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(bundle)), c.final()]);
  const text = JSON.stringify({ salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: enc.toString('base64') });
  assert.throws(() => decryptBackup(text, 'senha-errada-com-mais-de-vinte-chars'), 'senha errada não decifra');

  const target = await createDb();
  const mismatches = await restoreInto(target, decryptBackup(text, pass));
  assert.deepEqual(mismatches, []);
  const [{ n }] = await target.sql("select count(*)::int n from public.packages p join public.tenants t on t.id = p.tenant_id where t.slug = 'demo-jardim'");
  assert.equal(n, 7, 'encomendas em todos os estados restauradas');
  // Dados restaurados continuam isolados pela RLS (restore não abre brecha).
  const [u] = await target.sql("select id from auth.users where email like 'morador.aurora%'");
  const seen = await target.as(u.id, 'select tenant_id from public.packages');
  assert.ok(seen.length > 0 && seen.every((p) => p.tenant_id === t.id));
});
