import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('limpeza destrutiva de testes não fica acessível pela service role', async () => {
  const db = await createDb();
  try {
    await assert.rejects(db.service('select public.e2e_cleanup(array[]::uuid[])'), /permission denied/);
    await assert.rejects(db.sql('select public.e2e_cleanup(array[]::uuid[])'), /desabilitada/);
    const [row] = await db.sql("select current_setting('session_replication_role') value");
    assert.equal(row.value, 'origin');
  } finally { await db.raw.close(); }
});
