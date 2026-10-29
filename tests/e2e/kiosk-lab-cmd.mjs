// Laboratório: ações do síndico (como o painel faz) sobre o aparelho do emulador, na stack LOCAL.
//   node --env-file=.env.stack.local tests/e2e/kiosk-lab-cmd.mjs <ação> [minutos]
// ações: state | maint | end | reboot | sync | events | deactivate | recovery | enroll | newdevice | confirmlocal
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

assertLocalSupabase(process.env.SUPABASE_URL);
const lab = JSON.parse(readFileSync('tests/evidence/kiosk-lab.json', 'utf8'));
const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error: le } = await c.auth.signInWithPassword({ email: lab.sindico.email, password: lab.sindico.password }); // login recente = reautenticado
if (le) throw le;
const [action, arg] = process.argv.slice(2);
const cmd = async (a, params = {}, secret = null) => {
  const { data, error } = await c.rpc('mdm_command_create', { p_device: lab.device, p_action: a, p_params: params, p_idempotency_key: randomUUID(), p_secret: secret });
  if (error) throw error; return data;
};
const detail = async () => { const { data, error } = await c.rpc('mdm_device_detail', { p_device: lab.device }); if (error) throw error; return data; };
if (action === 'maint') console.log(await cmd('start_maintenance', { minutes: Number(arg || 5), scope: 'settings', reason: 'Teste de laboratório no emulador' }));
else if (action === 'end') console.log(await cmd('end_maintenance'));
else if (action === 'reboot') console.log(await cmd('reboot'));
else if (action === 'sync') console.log(await cmd('sync_policy'));
else if (action === 'deactivate') console.log(await cmd('deactivate'));
else if (action === 'enroll') { const { data, error } = await c.rpc('mdm_enrollment_create', { p_device: lab.device, p_minutes: 30 }); if (error) throw error; console.log(data.token); }
else if (action === 'newdevice') {
  // Aparelho desativado não se reinscreve: o laboratório cadastra outro registro e passa a usá-lo.
  const { data, error } = await c.rpc('mdm_device_create', { p_tenant: lab.tenant, p_name: `Tablet Emulador ${new Date().toISOString().slice(11, 19)}`, p_purpose: 'portaria', p_concierge: null });
  if (error) throw error;
  writeFileSync('tests/evidence/kiosk-lab.json', JSON.stringify({ ...lab, device: data.device_id }, null, 2)); console.log(data.device_id);
}
else if (action === 'confirmlocal') { const { error } = await c.rpc('mdm_deactivation_confirm_local', { p_device: lab.device, p_statement: arg || 'Laboratório: Device Owner removido por cabo (dpm remove-active-admin) e app desinstalado.' }); if (error) throw error; console.log('ok'); }
else if (action === 'events') console.log((await detail()).events.slice(0, Number(arg || 15)).map((e) => `${e.created_at.slice(11, 19)} ${e.source} ${e.event} ${JSON.stringify(e.data)}`).join('\n'));
else if (!['recovery', 'enroll', 'newdevice', 'confirmlocal'].includes(action)) {
  const d = await detail();
  console.log(JSON.stringify({ state: d.state, management: d.management, compliant: d.compliant, applied: d.applied?.version, desired: d.desired?.version,
    failed: d.report?.failed_restrictions, maintenance: d.report?.maintenance, lock_task: d.report?.lock_task, battery: d.battery_pct,
    commands: d.commands.slice(0, 4).map((x) => `${x.seq}:${x.action}:${x.status}${x.detail ? ` (${x.detail})` : ''}`) }, null, 1));
}
if (action === 'recovery') {
  // Mesmo algoritmo do painel (src/lib/mdm.ts); imprime os códigos só neste terminal de laboratório.
  const { generateRecoveryCodes } = await import('../../src/lib/mdm.ts');
  const { codes, stored } = await generateRecoveryCodes(5);
  const { data, error } = await c.rpc('mdm_recovery_set', { p_device: lab.device, p_codes: stored });
  if (error) throw error;
  console.log(JSON.stringify({ version: data, codes }));
}
