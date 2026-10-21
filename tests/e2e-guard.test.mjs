import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalSupabase } from './e2e/environment.mjs';

test('teste mutável recusa Supabase remoto mesmo com autorização genérica de E2E', () => {
  for (const url of ['https://cliente.supabase.co', 'https://localhost.evil.test', 'https://localhost@cliente.supabase.co']) {
    assert.throws(() => assertLocalSupabase(url), /bloqueado/);
  }
  for (const url of ['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321']) {
    assert.doesNotThrow(() => assertLocalSupabase(url));
  }
});
