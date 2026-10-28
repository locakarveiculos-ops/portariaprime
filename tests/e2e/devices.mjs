// Dispositivos e quiosque na stack LOCAL, com navegador real (painel do síndico) e um cliente HTTP que
// assina como o agente Android (mesma chave EC P-256, mesmo formato). Prova o ciclo do SERVIDOR:
// inscrição de uso único → política → manutenção com reautenticação → ACK → desativação pendente até ACK.
// NÃO substitui a homologação em aparelho físico (Device Owner, Lock Task, reboot) — ver docs/KIOSK_QA.md.
//
// PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... node tests/e2e/devices.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertLocalSupabase } from './environment.mjs';

const { PP_E2E_ALLOW, APP, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
if (PP_E2E_ALLOW !== '1' || !APP || !url || !anon || !secret) throw new Error('Defina PP_E2E_ALLOW=1, APP e chaves do Supabase.');
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const run = `e2e${Date.now().toString(36)}`;
const step = (s) => console.log(`- ${s}`);
// CNPJ válido e novo a cada execução (o mês grátis é por documento).
function cnpj() {
  const d = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  for (const w of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const r = d.reduce((a, x, i) => a + x * w[i], 0) % 11; d.push(r < 2 ? 0 : 11 - r);
  }
  return d.join('');
}
const created = [];
let tenantId;

const { count } = await svc.from('tenants').select('id', { count: 'exact', head: true }).not('slug', 'like', 'e2e%');
assert.equal(count, 0, 'Banco contém condomínios reais: teste recusado.');
await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime']);

// Agente simulado: mesma assinatura do Android (Api.kt).
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sig = (m) => sign('sha256', Buffer.from(m), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
let counter = 0, deviceId = null;
async function agent(path, body) {
  const text = JSON.stringify(body);
  const n = ++counter;
  const r = await fetch(`${APP}${path}`, { method: 'POST', body: text, headers: { 'content-type': 'application/json',
    'x-pp-device': deviceId, 'x-pp-counter': String(n), 'x-pp-signature': sig(`POST\n${path}\n${deviceId}\n${n}\n${sha(text)}`) } });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
  return j;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const email = `${run}-sindico@e2e.portariaprime.invalid`, password = `S${randomUUID()}!`;
  const { data: u } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: 'Síndica E2E' } });
  created.push(u.user.id);
  const userClient = createClient(url, anon, { auth: { persistSession: false } });
  await userClient.auth.signInWithPassword({ email, password });
  const { data: prov, error: pe } = await userClient.rpc('provision_tenant', { p_request_id: randomUUID(), p_name: 'Condomínio E2E Quiosque', p_slug: `${run}-kiosk`,
    p_document: cnpj(), p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });
  if (pe) throw pe;
  tenantId = prov.tenant_id;
  // Versão do agente publicada (dados de laboratório; o QR só aparece com versão publicada).
  await svc.from('mdm_agent_releases').upsert({ version_code: 1, version_name: '1.0.0-lab', apk_url: 'https://lab.invalid/pp-kiosk-1.0.0.apk',
    signature_checksum: 'WViSjDZLiV0TRkYzKjBo81z0c0P2JPKSKfScI-kfofc', active: true });

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${APP}/entrar`);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: /^Entrar/ }).click();
  await page.waitForURL(/\/(app|c\/.+)$/);

  step('Configurações → Dispositivos e quiosque');
  await page.goto(`${APP}/c/${run}-kiosk/configuracoes`);
  await page.getByLabel('Buscar configuração').fill('quiosque').catch(() => page.getByPlaceholder(/Buscar por função/).fill('quiosque'));
  await page.getByRole('link', { name: /Dispositivos e quiosque/ }).click();
  await page.getByText('Instalar o app (PWA) e gerenciar o aparelho são etapas diferentes.').waitFor();
  await page.getByRole('button', { name: 'Adicionar dispositivo' }).click();
  await page.getByLabel('Nome do aparelho').fill('Tablet Portaria E2E');
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  await page.getByRole('heading', { name: 'Tablet Portaria E2E' }).waitFor();
  await page.getByText('Pendente de provisionamento').first().waitFor();

  step('QR de provisionamento exige reautenticação e gera código de uso único');
  await page.getByRole('button', { name: 'Gerar QR de provisionamento' }).click();
  await page.getByRole('button', { name: /Gerar código de uso único/ }).click();
  // Login recente (< 5 min) dispensa a senha; senão o modal de reautenticação aparece e repete a ação.
  const reauth = page.getByRole('heading', { name: 'Confirme sua senha' });
  await Promise.race([reauth.waitFor(), page.getByText(/Código de inscrição \(uso único/).waitFor()]);
  if (await reauth.isVisible()) {
    await page.getByRole('dialog').last().getByLabel('Senha').fill(password);
    await page.getByRole('button', { name: 'Confirmar' }).click();
  }
  const tokenText = await page.getByText(/Código de inscrição \(uso único/).innerText();
  const token = tokenText.match(/[A-Z0-9]{24}/)[0];
  assert.ok(await page.locator('svg').filter({ has: page.locator('rect') }).count() > 0, 'QR renderizado');
  await page.screenshot({ path: 'tests/evidence/devices-qr.png' });

  step('agente inscreve com prova de posse; token não reutilizável');
  const agentId = randomUUID();
  const enroll = (t) => fetch(`${APP}/api/totem/kiosk-enroll`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: t, agentId, publicKey: spki, proof: sig(`enroll\n${t}\n${agentId}`),
      info: { managed: true, manufacturer: 'LAB', model: 'Agente simulado (não é aparelho)', release: '14', sdk: 34, agentVersion: '1.0.0-lab' } }) });
  const er = await enroll(token);
  assert.equal(er.status, 200, await er.clone().text());
  deviceId = (await er.json()).deviceId;
  assert.equal((await enroll(token)).status, 409, 'token de uso único');

  step('sync: recebe política Single-App; replay recusado; aplica e fica Ativo');
  const s1 = await agent('/api/totem/kiosk-sync', { report: { managed: true } });
  assert.equal(s1.policy.config.mode, 'single_app');
  const replay = await fetch(`${APP}/api/totem/kiosk-sync`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json',
    'x-pp-device': deviceId, 'x-pp-counter': String(counter), 'x-pp-signature': sig(`POST\n/api/totem/kiosk-sync\n${deviceId}\n${counter}\n${sha('{}')}`) } });
  assert.equal(replay.status, 403, 'contador repetido recusado');
  await agent('/api/totem/kiosk-sync', { report: { managed: true, applied_version_id: s1.policy.version_id, battery_pct: 81, charging: true } });
  await page.getByRole('button', { name: 'Fechar' }).first().click();
  await page.reload();
  await page.getByText('Device Owner · conforme').waitFor();
  await page.getByText('Ativo', { exact: true }).first().waitFor();

  step('manutenção pelo painel → agente recebe, confirma e o painel mostra "Em manutenção"');
  await page.getByRole('button', { name: 'Detalhes' }).click();
  await page.getByRole('button', { name: 'Abrir manutenção' }).click();
  await page.getByLabel('Motivo').fill('Trocar rede Wi-Fi da guarita');
  await page.getByRole('button', { name: 'Autorizar manutenção' }).click();
  await page.getByText(/Abrir manutenção · 15 min/).waitFor();
  const s2 = await agent('/api/totem/kiosk-sync', { report: { managed: true, applied_version_id: s1.policy.version_id } });
  const cmd = s2.commands.find((c) => c.action === 'start_maintenance');
  assert.ok(cmd && cmd.params.minutes === 15 && cmd.params.reason);
  await agent('/api/totem/kiosk-ack', { commandId: cmd.id, status: 'received' });
  await agent('/api/totem/kiosk-ack', { commandId: cmd.id, status: 'applied', detail: 'Manutenção por 15 min.' });
  await page.getByRole('button', { name: 'Fechar' }).first().click();
  await page.getByRole('button', { name: 'Detalhes' }).click();
  await page.getByText('Aplicado (confirmado pelo aparelho)').first().waitFor();
  await page.getByText('Em manutenção').first().waitFor();
  await page.screenshot({ path: 'tests/evidence/devices-detail.png', fullPage: true });

  step('códigos de recuperação: exibidos uma vez, só hash vai ao servidor');
  await page.getByRole('button', { name: 'Códigos de recuperação' }).click();
  await page.getByRole('button', { name: 'Gerar 10 códigos' }).click();
  await page.getByText('Estes códigos não serão exibidos de novo.').waitFor();
  const shown = await page.locator('ol.font-mono li').allInnerTexts();
  assert.equal(shown.length, 10);
  const { data: rows } = await svc.from('mdm_recovery_codes').select('hash').eq('device_id', deviceId);
  assert.equal(rows.length, 10);
  assert.ok(!JSON.stringify(rows).includes(shown[0].replace(/-/g, '')));

  step('política: câmera não aparece; desativação fica pendente até o ACK');
  assert.equal(await page.getByText(/câmera/i).filter({ hasText: /Bloquear câmera/i }).count(), 0);
  await page.getByRole('button', { name: 'Desativar gerenciamento' }).click();
  await page.getByRole('button', { name: 'Solicitar desativação' }).click();
  await page.getByRole('button', { name: 'Fechar' }).first().click();
  await page.reload();
  await page.getByText('Desativação pendente').first().waitFor();
  const s3 = await agent('/api/totem/kiosk-sync', { report: { managed: true } });
  const deact = s3.commands.find((c) => c.action === 'deactivate');
  await agent('/api/totem/kiosk-ack', { commandId: deact.id, status: 'applied', detail: 'Device Owner liberado.' });
  await page.reload();
  await page.getByText('Desativado', { exact: true }).first().waitFor();
  await page.getByText('Fora do gerenciamento').waitFor();
  assert.equal(await page.getByText('Device Owner · conforme').count(), 0, 'desativado não aparece como conforme');
  await assert.rejects(agent('/api/totem/kiosk-sync', { report: {} }), (e) => e.status === 401);

  step('larguras 360 e 1280 sem rolagem horizontal');
  for (const w of [1280, 360]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.reload(); await page.getByText('Aparelhos', { exact: true }).waitFor();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(over <= 0, `rolagem horizontal @${w}: ${over}`);
  }
  await page.screenshot({ path: 'tests/evidence/devices-list-360.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('OK devices');
} finally {
  await browser.close();
  await svc.from('mdm_agent_releases').delete().eq('version_code', 1);
  if (tenantId) await svc.from('tenants').delete().eq('id', tenantId);
  for (const id of created) await svc.auth.admin.deleteUser(id);
}
