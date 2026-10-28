// Payload de provisionamento só com chaves documentadas e HTTPS; códigos de recuperação conferem
// com PBKDF2 do node (mesmo algoritmo do agente Android: PBKDF2WithHmacSHA256, 256 bits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { provisioningPayload, generateRecoveryCodes, normalizeCode, pbkdf2Hex, RESTRICTIONS } from '../src/lib/mdm.ts';

const base = { apkUrl: 'https://portariaprime.vercel.app/kiosk/pp-kiosk-1.apk', signatureChecksum: 'a'.repeat(43), token: 'ABCDEF0123456789ABCDEF01', apiBase: 'https://portariaprime.vercel.app' };

test('payload QR: chaves Android documentadas, token de uso único, sem segredos permanentes', () => {
  const p = JSON.parse(provisioningPayload(base));
  for (const k of Object.keys(p)) assert.match(k, /^android\.app\.extra\.PROVISIONING_[A-Z_]+$/);
  assert.equal(p['android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME'], 'br.com.portariaprime.kiosk/.admin.KioskAdminReceiver');
  assert.deepEqual(Object.keys(p['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE']).sort(), ['pp_api_base', 'pp_enroll_token']);
  assert.ok(!/service|password|jwt|session/i.test(JSON.stringify(p)));
  assert.throws(() => provisioningPayload({ ...base, apkUrl: 'http://x/app.apk' }), /HTTPS/);
  assert.throws(() => provisioningPayload({ ...base, signatureChecksum: 'sha1:abc' }), /Checksum/);
  const w = JSON.parse(provisioningPayload({ ...base, wifi: { ssid: 'Portaria', password: 'segredo12', security: 'WPA' } }));
  assert.equal(w['android.app.extra.PROVISIONING_WIFI_SSID'], 'Portaria');
});

test('códigos de recuperação: únicos, formato legível, hash confere com PBKDF2 de referência', async () => {
  const { codes, stored } = await generateRecoveryCodes(5, 1000);
  assert.equal(new Set(codes).size, 5);
  for (const c of codes) assert.match(c, /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  const ref = pbkdf2Sync(normalizeCode(codes[0]), Buffer.from(stored[0].salt, 'hex'), 1000, 32, 'sha256').toString('hex');
  assert.equal(stored[0].hash, ref);
  assert.equal(await pbkdf2Hex(codes[0].toLowerCase().replace(/-/g, ' '), stored[0].salt, 1000), ref, 'digitação tolerante');
  assert.ok(!JSON.stringify(stored).includes(normalizeCode(codes[0])));
});

test('matriz de capacidades nunca oferece bloqueio de câmera', () => {
  assert.ok(!RESTRICTIONS.some((r) => /camera|câmera/i.test(r.key + r.label)));
});
