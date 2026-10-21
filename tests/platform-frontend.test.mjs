import test from 'node:test';
import assert from 'node:assert/strict';
import { actionData, rowActions, LIMITS, FEATURES } from '../src/pages/admin/platform-model.ts';
import { OWNER_TOUR, PLATFORM_SECTIONS, searchPlatformHelp } from '../src/lib/platform-help.ts';
import { toCsv } from '../src/lib/format.ts';

const context = capabilities => ({ user_id: 'actor', role: 'owner', capabilities });
const form = fields => { const result = new FormData(); for (const [key, value] of Object.entries(fields)) result.set(key, String(value)); return result; };
const future = new Date(Date.now() + 7 * 864e5).toISOString();

test('ações exigem capability; proprietário não ganha bypass no frontend', () => {
  assert.deepEqual(rowActions('tenants', {}, context([])), []);
  assert.deepEqual(rowActions('tenants', {}, context(['tenant_status'])), ['tenant_status']);
  assert.deepEqual(rowActions('incidents', { resolved_at: '2026-01-01' }, context(['incident_resolve'])), []);
  assert.deepEqual(rowActions('users', { status: 'unassigned' }, context(['membership_status', 'password_reset'])), ['password_reset']);
});
test('retry somente falha terminal elegível informada pelo servidor', () => {
  for (const status of ['queued', 'sending', 'accepted', 'delivered']) assert.deepEqual(rowActions('notifications', { status, retryable: true }, context(['notification_retry'])), []);
  assert.deepEqual(rowActions('notifications', { status: 'failed', retryable: false }, context(['notification_retry'])), []);
  assert.deepEqual(rowActions('notifications', { status: 'failed', retryable: true }, context(['notification_retry'])), ['notification_retry']);
});
test('trial expirado exige consentimento e envia estado anterior ao servidor', () => {
  const expired = { trial_state: 'expired', trial_ends_at: '2020-01-01T00:00:00Z' };
  assert.throws(() => actionData('trial_extend', form({ ends_at: future }), expired), /explicitamente/);
  assert.deepEqual(actionData('trial_extend', form({ ends_at: future, reactivate: 'on' }), expired), { ends_at: future, trial_state: 'expired' });
  assert.throws(() => actionData('trial_extend', form({ ends_at: '2020-01-01' }), expired), /futura/);
  assert.throws(() => actionData('trial_extend', form({ ends_at: future }), { trial_state: null }), /elegível/);
  assert.throws(() => actionData('trial_extend', form({ ends_at: future }), { trial_state: 'active', trial_ends_at: new Date(Date.now() + 8 * 864e5).toISOString() }), /posterior/);
});
test('preço e franquias rejeitam frações, negativos e ausência', () => {
  assert.throws(() => actionData('plan_price', form({ amount_cents: 1.5 }), {}), /inteiro/);
  assert.throws(() => actionData('plan_price', form({ amount_cents: -1 }), {}), /inteiro/);
  assert.deepEqual(actionData('plan_price', form({ amount_cents: 1250, cycle: 'monthly' }), {}), { amount_cents: 1250, cycle: 'monthly' });
  assert.throws(() => actionData('plan_limits', form({}), {}), /inteiros/);
  const fields = Object.fromEntries(LIMITS.map(key => [key, 0]));
  const data = actionData('plan_limits', form(fields), {});
  for (const key of LIMITS) assert.equal(data[key], 0);
  for (const key of FEATURES) assert.equal(data[key], false);
});
test('tour usa somente seções globais; ajuda pesquisável ignora acentos', () => {
  for (const step of OWNER_TOUR) {
    assert.ok(PLATFORM_SECTIONS.some(([section]) => section === step.section));
    assert.match(step.target, /^platform-/);
    assert.equal('action' in step, false);
    assert.equal('route' in step, false);
  }
  assert.ok(searchPlatformHelp('autenticacao').some(item => item.section === 'settings'));
  assert.equal(searchPlatformHelp('termo-inexistente-xyz').length, 0);
});
test('CSV mantém neutralização de fórmulas no helper existente', () => {
  const csv = toCsv([{ name: '=HYPERLINK("bad")' }], [['name', 'Nome']]);
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('""bad""'));
});
