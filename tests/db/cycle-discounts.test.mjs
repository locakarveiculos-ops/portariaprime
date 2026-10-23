// Desconto por ciclo: trimestral 5% e anual 15% sobre o mensal, só para novos contratos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('ciclos com desconto e contrato antigo preservado', async () => {
  const db = await createDb();
  try {
    const rows = await db.sql(`select p.code, pp.cycle, pp.amount_cents from plans p join plan_prices pp on pp.plan_id = p.id
      where pp.active and not p.is_custom order by p.code, pp.cycle`);
    const by = Object.fromEntries(rows.map((r) => [`${r.code}:${r.cycle}`, r.amount_cents]));
    for (const code of ['essencial', 'profissional', 'prime']) {
      const m = by[`${code}:monthly`];
      assert.equal(by[`${code}:quarterly`], Math.floor(m * 3 * 0.95 / 100) * 100, `${code} trimestral`);
      assert.equal(by[`${code}:yearly`], Math.floor(m * 12 * 0.85 / 100) * 100, `${code} anual`);
      // Equivalente mensal sempre menor que o mensal: há benefício real em fechar ciclos longos.
      assert.ok(by[`${code}:quarterly`] / 3 < m && by[`${code}:yearly`] / 12 < by[`${code}:quarterly`] / 3, `${code} escalonado`);
    }
    // Um preço ativo por plano/ciclo; versões antigas preservadas como inativas.
    const [{ n }] = await db.sql(`select count(*)::int n from (select plan_id, cycle from plan_prices where active group by 1, 2 having count(*) > 1) x`);
    assert.equal(n, 0);
    assert.ok((await db.sql(`select 1 from plan_prices where not active`)).length >= 1, 'versões antigas preservadas');
    // Auditoria da decisão.
    assert.ok((await db.sql(`select 1 from audit_logs where action = 'commercial.cycle_discount'`)).length >= 1);
  } finally { await db.raw.close(); }
});
