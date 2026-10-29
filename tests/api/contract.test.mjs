// Contratação: validação de entrada, preço nunca do navegador, verificação honesta
// sem provedor, PDF real com carimbo e template contract_copy. Supabase simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptInput, clientIp, contractAction } from '../../api/billing/_contract.ts';
import { renderContractPdf } from '../../api/_lib/contract-pdf.ts';
import { render, emailHtml } from '../../api/_lib/templates.ts';
import { POST } from '../../api/billing/[action].ts';

const T = '11111111-2222-4333-8444-555555555555';
const base = { tenantId: T, accepted: true, documentSha256: 'a'.repeat(64), plan: 'profissional', cycle: 'monthly',
  contractorName: 'Cond A', contractorDocument: '11.444.777/0001-61', representativeName: 'Síndica Teste', representativeEmail: 'S@A.invalid',
  representativeRole: 'Síndica', representativeAuthority: 'Eleita em assembleia' };

test('validação de entrada do aceite', () => {
  const ok = parseAcceptInput(base);
  assert.equal(ok.contractorDocument, '11444777000161');
  assert.equal(ok.representativeEmail, 's@a.invalid');
  for (const [patch, re] of [
    [{ accepted: undefined }, /caixa de aceite/], [{ accepted: 'true' }, /caixa de aceite/], [{ tenantId: 'x' }, /Condomínio/],
    [{ documentSha256: 'abc' }, /documento/], [{ cycle: 'weekly' }, /Ciclo/], [{ amountCents: 1 }, /servidor/],
    [{ contractorDocument: '123' }, /CNPJ/], [{ representativeEmail: 'sem-arroba' }, /E-mail/], [{ representativeCpf: '123' }, /CPF/],
    [{ representativeAuthority: '' }, /poderes/],
  ]) assert.throws(() => parseAcceptInput({ ...base, ...patch }), re);
  const prop = parseAcceptInput({ ...base, plan: undefined, cycle: undefined, proposal: 'token-da-proposta' });
  assert.deepEqual([prop.plan, prop.cycle, prop.proposal], [null, null, 'token-da-proposta']);
  assert.equal(clientIp(new Request('https://x', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })), '203.0.113.7');
  assert.equal(clientIp(new Request('https://x', { headers: { 'x-forwarded-for': '<script>' } })), null);
});

test('roteador despacha ações de contrato; sem sessão = 401; ação desconhecida = 404', async () => {
  const r = await POST(new Request('https://app/api/billing/contract_accept', { method: 'POST', body: JSON.stringify(base) }));
  assert.equal(r.status, 401);
  assert.equal((await POST(new Request('https://app/api/billing/contract_nada', { method: 'POST', body: '{}' }))).status, 404);
});

test('aceite sem Resend fica pendente de verificação (não finge) e gera PDF uma vez', async () => {
  const saved = { ...process.env }; const fetch0 = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
  delete process.env.RESEND_API_KEY; delete process.env.RESEND_FROM_EMAIL;
  const calls = [];
  const acceptance = { id: '99999999-2222-4333-8444-555555555555', tenant_id: T, kind: 'original', status: 'pending_verification', document_version: '1.0',
    document_sha256: 'a'.repeat(64), document_md: '# Contrato\n\n## 1. Objeto\nTexto.', accepted_at: '2026-10-23T12:00:00Z', terms: { amount_cents: 14900, cycle: 'monthly', plan_name: 'Profissional' },
    contractor_name: 'Cond A', contractor_document: '11444777000161', representative_name: 'Síndica', representative_email: 's@a.invalid',
    representative_role: 'Síndica', representative_authority: 'Ata', pdf_status: 'pending' };
  globalThis.fetch = async (url, init) => {
    const u = String(url); const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ u, body });
    if (u.includes('/auth/v1/user')) return Response.json({ id: 'user-1', email: 's@a.invalid', aud: 'authenticated' });
    if (u.endsWith('/rpc/contract_accept')) return Response.json(acceptance);
    if (u.endsWith('/rpc/contract_pdf_data')) return Response.json(acceptance);
    if (u.includes('/storage/v1/object/tenant-contracts/')) return Response.json({ Key: 'k' });
    if (u.endsWith('/rpc/complete_contract_pdf')) return Response.json({ path: body.p_path, sha256: body.p_sha256 });
    throw new Error(`inesperado: ${u}`);
  };
  try {
    const res = await contractAction('contract_accept', new Request('https://app/api/billing/contract_accept', { method: 'POST',
      headers: { authorization: 'Bearer t', 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UA-teste' }, body: JSON.stringify(base) }));
    const out = await res.json();
    assert.equal(res.status, 200, JSON.stringify(out));
    assert.equal(out.verification, 'unavailable');
    assert.equal(out.status, 'pending_verification');
    assert.match(out.message, /não está configurado/);
    const acc = calls.find(c => c.u.endsWith('/rpc/contract_accept')).body;
    assert.deepEqual([acc.p_actor, acc.p_ip, acc.p_user_agent, acc.p_plan_code], ['user-1', '203.0.113.7', 'UA-teste', 'profissional']);
    assert.ok(!('p_amount_cents' in acc), 'preço não sai do navegador');
    assert.ok(!calls.some(c => c.u.endsWith('/rpc/contract_set_code')), 'sem provedor não gera código');
    assert.match(out.pdfSha256, /^[0-9a-f]{64}$/);
  } finally {
    globalThis.fetch = fetch0;
    for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('PDF do contrato: arquivo real com texto longo e caractere fora da fonte', async () => {
  const bytes = await renderContractPdf({ id: 'x'.repeat(36), kind: 'original', document_version: '1.0', document_sha256: 'f'.repeat(64),
    document_md: '# Contrato\n\n## 1. Objeto\n- Item **um**\n\n' + 'Parágrafo longo. '.repeat(400), accepted_at: '2026-10-23T12:00:00Z',
    contractor_name: 'Cond 😀 A', contractor_document: '11444777000161', representative_name: 'Síndica', representative_email: 's@a.invalid',
    representative_role: 'Síndica', representative_authority: 'Ata', terms: { amount_cents: 14900, cycle: 'monthly', limits: { max_units: 400 } } });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  assert.ok(bytes.length > 2000);
});

test('minutas: versão rascunho (contrato 0.2 com Modo Portaria Exclusiva), marcadores pendentes (não publicáveis) e nenhum CNPJ/dado da contratada inventado', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseDraft, pendingMarks, headings, lineDiff } = await import('../../src/lib/legal-text.ts');
  for (const f of ['contrato-saas', 'termos', 'privacidade', 'anexo-tratamento-dados']) {
    const { meta, body } = parseDraft(readFileSync(`docs/legal/${f}.md`, 'utf8'));
    assert.equal(meta.version, f === 'contrato-saas' ? '0.2-rascunho' : '0.1-rascunho', f);
    assert.ok(meta.summary && pendingMarks(body).length > 0, `${f}: resumo e pendências`);
    assert.doesNotMatch(body, /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/, `${f}: sem CNPJ literal`);
    assert.ok(headings(body).length >= 3);
  }
  const contrato = readFileSync('docs/legal/contrato-saas.md', 'utf8');
  for (const re of [/MP 2\.200-2\/2001, art\. 10, §2º/, /não é a API oficial da Meta/, /um mês de calendário/, /sem débito automático/i, /\{\{FORO\}\}/, /\{\{HORARIO_SUPORTE\}\}/])
    assert.match(contrato, re);
  assert.doesNotMatch(contrato, /garant\w+ (a )?validade jurídica/i);
  // Modo Portaria Exclusiva: opcional, piloto, sem equipamento, provisionamento e sem reajuste de quem já contratou.
  for (const re of [/Modo Portaria Exclusiva/, /uso opcional/, /equipamento não está incluso/, /validação de compatibilidade/, /restauração de fábrica/, /sem reajuste automático/])
    assert.match(contrato, re);
  assert.doesNotMatch(contrato, /qualquer (aparelho|android)|100% inviolável|segurança total|impossível sair/i);
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc').map(l => l.op + l.text), [' a', '-b', '+x', ' c']);
});

test('/contratar e /planos: sem contrato publicado, avisam que a contratação eletrônica só existe após publicação e que o aceite não foi feito', async () => {
  const { readFileSync } = await import('node:fs');
  const contratar = readFileSync('src/pages/ContratarPage.tsx', 'utf8');
  assert.match(contratar, /!quote\.document \? <Alert[^>]*>O contrato ainda não foi publicado[^<]*A contratação eletrônica fica disponível após a publicação\./);
  const planos = readFileSync('src/pages/PlanosPage.tsx', 'utf8');
  assert.match(planos, /!legal\.published && <Alert[^>]*><strong>Minuta em revisão — não vigente\.<\/strong>/);
  assert.match(planos, /!legal\?\.published && <> <strong>O aceite ainda não foi feito:<\/strong> a contratação eletrônica só fica disponível depois que a Portaria Prime publicar/);
  assert.match(planos, /!legal\.published && ' Enquanto o contrato estiver em minuta, a contratação eletrônica não está disponível e nenhum aceite é registrado\.'/);
  assert.match(planos, /não substitui o aceite formal/);
});

test('template contract_copy escapa dados e cita versão/hash', () => {
  const ctx = { tenant_name: '<b>Cond</b>', tenant_slug: 'cond-a', timezone: 'America/Sao_Paulo',
    contract: { document_version: '1.0', document_sha256: 'f'.repeat(64), accepted_at: '2026-10-23T12:00:00Z', plan_name: 'Profissional', cycle: 'monthly', amount_cents: 14900 } };
  const m = render('contract_copy', ctx, {}, 'https://app.test');
  const html = emailHtml(ctx, m);
  assert.ok(!html.includes('<b>Cond</b>'));
  assert.match(html, /f{64}/);
  assert.match(m.intro, /não é pagamento/);
});
