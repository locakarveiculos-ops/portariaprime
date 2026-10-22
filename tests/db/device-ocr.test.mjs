import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('OCR do dispositivo: sem usuário, franquia atômica, intervalo, revogação e grants', async () => {
  const db = await createDb();
  try {
    await db.sql('update plans set published = true');
    const admin = await db.createUser('device-ocr@example.invalid');
    const { tenant_id: tenant } = await db.rpc(admin, 'provision_tenant', {
      p_request_id: crypto.randomUUID(), p_name: 'OCR Teste', p_slug: 'ocr-device', p_document: '11444777000161',
      p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly',
    });
    const hash = 'a'.repeat(64);
    await db.sql("insert into device_enrollments(tenant_id,name,status,secret_hash) values($1,'Tablet','active',$2)", [tenant, hash]);
    const read = () => db.service('select device_consume_ocr($1) ok', [hash]);
    await assert.rejects(db.rpc(null, 'device_consume_ocr', { p_secret_hash: hash }), /permission denied/);
    await assert.rejects(db.rpc(admin, 'device_consume_ocr', { p_secret_hash: hash }), /permission denied/);
    await assert.rejects(db.service('select device_consume_ocr($1)', ['b'.repeat(64)]), /revogado/);
    assert.equal((await read())[0].ok, true);
    await assert.rejects(read(), /dez segundos/);
    assert.equal((await db.sql("select used from usage_counters where tenant_id=$1 and metric='ocr'", [tenant]))[0].used, 1);
    await db.sql('update device_enrollments set ocr_last_requested_at=null where tenant_id=$1', [tenant]);
    await db.sql("update usage_counters set used=100000 where tenant_id=$1 and metric='ocr'", [tenant]);
    assert.equal((await read())[0].ok, false);
    await db.sql("update tenants set status='suspended' where id=$1", [tenant]);
    await assert.rejects(read(), /indisponível/);
    await db.sql("update tenants set status='active' where id=$1", [tenant]);
    await db.sql("update device_enrollments set status='revoked' where tenant_id=$1", [tenant]);
    await assert.rejects(read(), /revogado/);
  } finally { await db.raw.close(); }
});
