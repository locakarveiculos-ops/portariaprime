// Laboratório do quiosque (stack LOCAL apenas): cria condomínio de teste com síndico, porteiro,
// unidade e morador, cadastra um aparelho e emite token de inscrição. Grava credenciais em
// tests/evidence/kiosk-lab.json (não versionado) para o roteiro de emulador.
//
// PP_E2E_ALLOW=1 node --env-file=.env.stack.local tests/e2e/kiosk-lab-setup.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1') throw new Error('Defina PP_E2E_ALLOW=1.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false } });
const run = `e2e${Date.now().toString(36)}`;
const cnpj = () => { const d = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  for (const w of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) { const r = d.reduce((a, x, i) => a + x * w[i], 0) % 11; d.push(r < 2 ? 0 : 11 - r); }
  return d.join(''); };
const must = ({ data, error }) => { if (error) throw error; return data; };
async function user(key, name) {
  const email = `${run}-${key}@e2e.portariaprime.invalid`, password = `S${randomUUID()}!`;
  const u = must(await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } }));
  const c = createClient(url, anon, { auth: { persistSession: false } });
  must(await c.auth.signInWithPassword({ email, password }));
  return { email, password, id: u.user.id, c };
}

await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);
const sindico = await user('sindico', 'Síndica Lab');
const slug = `${run}-lab`;
const T = must(await sindico.c.rpc('provision_tenant', { p_request_id: randomUUID(), p_name: 'Condomínio Laboratório Quiosque', p_slug: slug,
  p_document: cnpj(), p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' })).tenant_id;
const unit = must(await sindico.c.from('units').insert({ tenant_id: T, block: 'A', label: '101' }).select('id').single()).id;
must(await sindico.c.from('storage_locations').insert({ tenant_id: T, concierge_location_id: must(await sindico.c.from('concierge_locations').select('id').eq('tenant_id', T).limit(1).single()).id,
  code: 'A-1', rack: 'Estante A', shelf: 'Prateleira 1', capacity: 50 }));
const accept = async (role, unitId, u) => {
  const inv = must(await sindico.c.rpc('create_invitation', { p_tenant: T, p_email: u.email, p_role: role, p_unit: unitId, p_permissions: '{}' }));
  must(await u.c.rpc('accept_invitation', { p_token: inv.token }));
};
const porteiro = await user('porteiro', 'Porteiro Turno A');
const porteiro2 = await user('porteiro2', 'Porteira Turno B');
const morador = await user('morador', 'Maria Moradora Lab');
await accept('porteiro', null, porteiro);
await accept('porteiro', null, porteiro2);
await accept('morador', unit, morador);
// Outro condomínio (isolamento): o quiosque não pode navegar para ele.
const outro = await user('outro', 'Síndico Outro');
const slug2 = `${run}-outro`;
must(await outro.c.rpc('provision_tenant', { p_request_id: randomUUID(), p_name: 'Outro Condomínio', p_slug: slug2,
  p_document: cnpj(), p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }));

const device = must(await sindico.c.rpc('mdm_device_create', { p_tenant: T, p_name: 'Tablet Emulador', p_purpose: 'portaria', p_concierge: null })).device_id;
const { token } = must(await sindico.c.rpc('mdm_enrollment_create', { p_device: device, p_minutes: 120 }));
const strip = ({ c, ...u }) => u;
mkdirSync('tests/evidence', { recursive: true });
writeFileSync('tests/evidence/kiosk-lab.json', JSON.stringify({ run, tenant: T, slug, slug2, unit, device, token,
  sindico: strip(sindico), porteiro: strip(porteiro), porteiro2: strip(porteiro2), morador: strip(morador) }, null, 2));
console.log(JSON.stringify({ slug, device, token }));
