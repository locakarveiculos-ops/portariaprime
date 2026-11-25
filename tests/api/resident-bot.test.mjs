import { test } from 'node:test';
import assert from 'node:assert/strict';
import { residentReply, residentActive } from '../../api/_lib/resident-bot.ts';
import { residentWho, residentWebhook, submitSignup } from '../../api/_lib/resident-bot-webhook.ts';
import { render } from '../../api/_lib/templates.ts';

const ctx = { tenantId: 'T', who: '5511988887777', appUrl: 'https://app.test', slug: 'aurora', tenantName: 'Aurora' };
const text = (text) => ({ kind: 'text', text });
const action = (id) => ({ kind: 'action', id });
const linked = { status: 'linked', verified_user_id: 'U', links: [{ user_id: 'U', name: 'Ana', units: [{ id: 'UNIT', label: 'Quadra 3 · Lote 15' }] }] };
function svc(handlers = {}) {
  const calls = [];
  return { calls, rpc: async (fn, args) => {
    calls.push({ fn, args });
    if (handlers[fn]) return { data: await handlers[fn](args), error: null };
    if (fn === 'resident_bot_resolve') return { data: linked, error: null };
    throw new Error(`RPC inesperada: ${fn}`);
  } };
}
const session = (extra = {}) => ({ authenticated: true, user: 'U', unit: 'UNIT', until: Date.now() + 1800000, options: ['rb:m'], ...extra });

test('silêncio fora do atendimento, início limitado, validade 30 minutos', () => {
  assert.equal(residentActive(text('obrigado'), {}), false);
  assert.equal(residentActive(text('1'), {}), false);
  assert.equal(residentActive(action('today'), {}), false);
  assert.equal(residentActive(text('oi'), {}), true);
  assert.equal(residentActive(action('rb:m'), {}), true);
  assert.equal(residentActive(text('resposta'), session()), true);
  assert.equal(residentActive(text('resposta'), session({ until: Date.now() - 1 })), false);
});

test('sempre pede e-mail ao iniciar, mesmo com número reconhecido; não expõe nome/unidade antes do código', async () => {
  const db = svc();
  const r = await residentReply(db, ctx, text('oi'), {});
  assert.equal(r.session.step, 'email');
  assert.match(r.card.text, /e-mail/);
  assert.ok(!r.card.text.includes('Ana'));
  assert.equal(db.calls.length, 0);
});

test('e-mail, código, menu: identidade revalidada no banco', async () => {
  const db = svc({ resident_bot_email_start: () => ({ sent: true }), resident_bot_email_verify: () => ({ ok: true, status: 'linked' }) });
  const start = await residentReply(db, ctx, text('ana@example.test'), session({ authenticated: false, step: 'email' }));
  assert.equal(start.session.step, 'code');
  const r = await residentReply(db, ctx, text('123456'), start.session);
  assert.equal(r.session.authenticated, true);
  assert.equal(r.session.user, 'U');
  assert.match(r.card.text, /Quadra 3/);
  assert.ok(r.options.includes('rb:w:0'));
  assert.ok(!JSON.stringify(r.session).includes('123456'));
});

test('código errado mantém etapa; limite não promete envio', async () => {
  const db = svc({ resident_bot_email_start: () => ({ sent: false, reason: 'limit' }), resident_bot_email_verify: () => ({ ok: false }) });
  const a = await residentReply(db, ctx, text('ana@example.test'), session({ authenticated: false, step: 'email' }));
  assert.match(a.card.text, /limite/i);
  const b = await residentReply(db, ctx, text('123456'), session({ authenticated: false, step: 'code' }));
  assert.equal(b.session.authenticated, false);
  assert.equal(b.session.step, 'code');
});

test('botão forjado ou antigo não executa escrita', async () => {
  const db = svc();
  const r = await residentReply(db, ctx, action('rb:confirm:evil'), session());
  assert.ok(!db.calls.some((c) => c.fn === 'resident_bot_call'));
  assert.match(r.card.text, /Encomendas/);
});

test('palavra-chave exige resumo e confirmação vinculada à proposta', async () => {
  const db = svc({ resident_bot_call: (a) => { assert.equal(a.p_action, 'keyword_save'); return { keyword: 'AZUL' }; } });
  const ask = await residentReply(db, ctx, action('rb:kn'), session({ options: ['rb:kn'] }));
  assert.equal(ask.session.step, 'kw_word');
  const review = await residentReply(db, ctx, text('AZUL'), ask.session);
  assert.ok(!db.calls.some((c) => c.fn === 'resident_bot_call'));
  assert.match(review.card.text, /AZUL/);
  const confirm = review.options.find((x) => x.startsWith('rb:confirm:'));
  assert.ok(confirm);
  const done = await residentReply(db, ctx, action(confirm), review.session);
  assert.match(done.card.text, /registrada/i);
  assert.equal(db.calls.filter((c) => c.fn === 'resident_bot_call').length, 1);
  assert.equal(done.session.draft, undefined);
});

test('QR só link; lista paginada não corta encomendas', async () => {
  const db = svc({ resident_bot_call: (a) => a.p_action === 'qr' ? { link: 'a'.repeat(40) }
    : { waiting: Array.from({ length: 12 }, (_, i) => ({ id: `P${i}`, carrier: 'Correios', ref: `REF${i}`, status: 'ARMAZENADA' })) } });
  const list = await residentReply(db, ctx, action('rb:w:0'), session({ options: ['rb:w:0'] }));
  assert.ok(list.options.includes('rb:w:1'));
  const next = await residentReply(db, ctx, action('rb:w:1'), list.session);
  assert.ok(next.options.includes('rb:p:P11'));
  const qr = await residentReply(db, ctx, action('rb:q:P0'), session({ options: ['rb:q:P0'] }));
  assert.match(qr.card.text, /https:\/\/app.test\/qr\?c=a{40}/);
  assert.ok(!qr.card.text.includes('PP1.'));
});

test('cadastro novo após verificar e-mail pede nome, unidade, termo e confirmação', async () => {
  const db = svc({ resident_bot_email_verify: () => ({ ok: true, status: 'new' }), resident_bot_signup_info: () => ({
    slug: 'aurora', units: { has_blocks: true, units: [{ block: 'Quadra 3', label: 'Lote 15' }] }, term: { hash: 'h', version: '1', title: 'Termo' },
  }) });
  const a = await residentReply(db, ctx, text('123456'), session({ authenticated: false, step: 'code' }));
  assert.equal(a.session.step, 'signup_name');
  const b = await residentReply(db, ctx, text('Ana Souza'), a.session);
  assert.ok(b.options.some((x) => x.startsWith('rb:sb:')));
  const c = await residentReply(db, ctx, action(b.options[0]), b.session);
  const d = await residentReply(db, ctx, action(c.options[0]), c.session);
  assert.match(d.card.text, /termo-dados/);
  assert.match(d.card.text, /Ana Souza/);
  assert.equal(d.session.draft.privacy_hash, 'h');
  assert.ok(d.options.some((x) => x.startsWith('rb:accept:')));
  assert.ok(!db.calls.some((x) => x.fn === 'resident_bot_signup'));
});

test('saída encerra atendimento e descarta dados do rascunho', async () => {
  const r = await residentReply(svc(), ctx, action('rb:exit'), session({ options: ['rb:exit'], draft: { name: 'Ana' } }));
  assert.deepEqual(r.session, {});
});

// ---------------------------------------------------------------- webhook (Supabase e motor simulados)
test('identidade: número real ou LID; grupo e fromMe ignorados', () => {
  assert.deepEqual(residentWho({ remoteJid: '5511988887777@s.whatsapp.net' }), { who: '5511988887777', replyTo: '5511988887777@s.whatsapp.net' });
  assert.equal(residentWho({ remoteJid: '123456789@lid', senderPn: '5511988887777@s.whatsapp.net' }).who, '5511988887777');
  assert.deepEqual(residentWho({ remoteJid: '123456789@lid' }), { who: 'lid:123456789', replyTo: '123456789@lid' });
  assert.equal(residentWho({ remoteJid: '1203@g.us' }), null);
  assert.equal(residentWho({ remoteJid: '5511988887777@s.whatsapp.net', fromMe: true }), null);
});

function hook({ state = {}, dup = false } = {}) {
  const log = { rpc: [], sent: [], saved: [], inserted: [] };
  const svc = {
    rpc: async (fn, args) => {
      log.rpc.push(fn);
      if (fn === 'resident_bot_resolve') return { data: { status: 'unknown', active: true, slug: 'aurora', tenant_name: 'Aurora', state, links: [] }, error: null };
      if (fn === 'resident_bot_save') { log.saved.push(args.p_state); return { data: null, error: null }; }
      return { data: null, error: { message: `rpc ${fn}` } };
    },
    from: () => ({ insert: async (row) => { log.inserted.push(row); return { error: dup ? { code: '23505' } : null }; } }),
  };
  return { svc, log };
}
async function withMotor(fn) {
  const saved = { ...process.env }; Object.assign(process.env, { WHAILEYS_API_URL: 'https://wh.test', APP_URL: 'https://app.test' });
  const f0 = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ messageId: 'M' }); };
  try { return await fn(sent); } finally { globalThis.fetch = f0; process.env = saved; }
}
const box = { ch: { instance: 'ppia-x', token: 't' }, tenantId: 'T' };

test('webhook: resposta a aviso fica em silêncio; nada gravado nem enviado', () => withMotor(async (sent) => {
  const { svc, log } = hook();
  const r = await residentWebhook(svc, box, { remoteJid: '123456789@lid', id: 'MSG1' }, { conversation: 'obrigado!' }, 'MSG1');
  assert.equal(r.ignored, 'silent');
  assert.equal(sent.length, 0); assert.equal(log.inserted.length, 0); assert.equal(log.saved.length, 0);
}));

test('webhook: "oi" pelo LID abre atendimento pedindo e-mail e grava o passo; duplicada sem efeito', () => withMotor(async (sent) => {
  const { svc, log } = hook();
  await residentWebhook(svc, box, { remoteJid: '123456789@lid', id: 'MSG2' }, { conversation: 'oi' }, 'MSG2');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.to, '123456789@lid');
  assert.match(sent[0].body.text, /e-mail/);
  assert.equal(log.saved[0].step, 'email');
  assert.deepEqual(log.inserted[0], { provider_id: 'MSG2', phone: 'lid:123456789' });
  const again = hook({ dup: true });
  const r = await residentWebhook(again.svc, box, { remoteJid: '123456789@lid', id: 'MSG2' }, { conversation: 'oi' }, 'MSG2');
  assert.equal(r.duplicate, true);
}));

test('templates: código e boas-vindas com link de senha só no fragmento', () => {
  const A = { tenant_name: 'Aurora', tenant_slug: 'aurora', timezone: 'America/Sao_Paulo' };
  const code = render('resident_bot_code', { ...A, bot_code: '123456' }, {}, 'https://app.test');
  assert.match(code.subject, /Código/); assert.match(code.intro, /123456/);
  assert.throws(() => render('resident_bot_code', A, {}, 'https://app.test'), /indisponível/, 'sem código não manda e-mail vazio');
  const tok = 'a'.repeat(64);
  const ok = render('access_decision', { ...A, resident: { name: 'Ana', unit: 'B 202' }, password_link: { token: tok, expires_at: '2026-12-02T12:00:00Z' } }, { approved: true }, 'https://app.test');
  assert.equal(ok.cta[1], `https://app.test/c/aurora/criar-senha#${tok}`);
  assert.match(ok.whatsapp, /criar-senha#/);
  const normal = render('access_decision', { ...A, resident: { name: 'Ana' } }, { approved: true }, 'https://app.test');
  assert.ok(!JSON.stringify(normal).includes('criar-senha'), 'cadastro do portal segue igual');
});

test('sem conta confirmada na sessão (vínculo caiu) volta a pedir e-mail; nada executado', async () => {
  const db = svc({ resident_bot_resolve: () => ({ status: 'unknown', verified_user_id: null, links: [] }) });
  const r = await residentReply(db, ctx, action('rb:w:0'), session({ options: ['rb:w:0'] }));
  assert.equal(r.session.step, 'email');
  assert.ok(!db.calls.some((c) => c.fn === 'resident_bot_call'));
});

// ---------------------------------------------------------------- unidades reais (formato do Azaléia: 30 blocos x 12 + extras)
const AZ_BLOCKS = [...Array.from({ length: 15 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat()];
const AZ_UNITS = [...AZ_BLOCKS.flatMap((b) => ['01', '02', '03', '04', '11', '12', '13', '14', '21', '22', '23', '24'].map((label) => ({ block: b, label }))),
  { block: '1', label: '11' }, { block: 'QA', label: '01' }];
function signupDb() {
  return svc({ resident_bot_signup_info: () => ({ slug: 'aurora', units: { has_blocks: true, units: AZ_UNITS }, term: { hash: 'h', version: '1' } }) });
}
const atBlock = session({ authenticated: false, step: 'signup_block', draft: { name: 'Ana Souza', phone: '5511988887777' } });

test('cadastro: percorre TODOS os blocos do condomínio em ordem natural, sem cortar nenhum', async () => {
  const db = signupDb();
  let r = await residentReply(db, ctx, text('qualquer coisa que não existe'), atBlock);
  assert.match(r.card.text, /Não encontrei/);
  assert.match(r.card.text, /32 no condomínio/);
  const seen = [];
  for (let i = 0; i < 10; i++) {
    seen.push(...r.card.sections[0].rows.filter((x) => x.id.startsWith('rb:sb:')).map((x) => x.title));
    const next = r.options.find((o) => o.startsWith('rb:bp:') && Number(o.slice(6)) > (r.session.page ?? -1) && r.card.sections[0].rows.find((x) => x.id === o)?.title === 'Próximos');
    if (!next) break;
    r = await residentReply(db, ctx, action(next), r.session);
  }
  assert.equal(seen.length, 32, 'todos os blocos aparecem');
  assert.deepEqual(seen.slice(0, 4), ['1', '1A', '1B', '2A'], 'ordem natural');
  assert.ok(seen.indexOf('2A') < seen.indexOf('10A'), '2A antes de 10A');
  assert.ok(r.card.sections[0].rows.length <= 10, 'lista do WhatsApp tem no máximo 10 linhas');
});

test('cadastro: todas as 12 unidades do bloco aparecem (com páginas) e o bloco escolhido é o certo', async () => {
  const db = signupDb();
  const blocks = await residentReply(db, ctx, text('nada'), atBlock);
  const id8a = await (async () => {
    let r = blocks;
    for (;;) {
      const row = r.card.sections[0].rows.find((x) => x.title === '8A');
      if (row) return { id: row.id, r };
      const next = r.card.sections[0].rows.find((x) => x.title === 'Próximos');
      r = await residentReply(db, ctx, action(next.id), r.session);
    }
  })();
  let r = await residentReply(db, ctx, action(id8a.id), id8a.r.session);
  assert.match(r.card.text, /Bloco 8A/); assert.match(r.card.text, /12 unidades/);
  const labels = [];
  for (let i = 0; i < 5; i++) {
    labels.push(...r.card.sections[0].rows.filter((x) => x.id.startsWith('rb:su:')).map((x) => x.title));
    const next = r.card.sections[0].rows.find((x) => x.title === 'Próximas');
    if (!next) break;
    r = await residentReply(db, ctx, action(next.id), r.session);
  }
  assert.deepEqual(labels, ['01', '02', '03', '04', '11', '12', '13', '14', '21', '22', '23', '24']);
});

test('cadastro: digitar bloco e unidade encontra direto (8A 12, bl 8a ap 12, 8a12); 8A não confunde com 18A', async () => {
  for (const q of ['8A 12', 'bl 8a ap 12', '8a12', 'Bloco 8A apto 12']) {
    const r = await residentReply(signupDb(), ctx, text(q), atBlock);
    assert.match(r.card.text, /Unidade: 8A 12/, q);
    assert.equal(r.session.draft.block, '8A'); assert.equal(r.session.draft.unit, '12');
    assert.ok(r.options.some((o) => o.startsWith('rb:accept:')), q);
  }
  const blockOnly = await residentReply(signupDb(), ctx, text('10b'), atBlock);
  assert.match(blockOnly.card.text, /Bloco 10B/);
  const many = await residentReply(signupDb(), ctx, text('12'), atBlock);
  assert.match(many.card.text, /Encontrei \d+ unidades/);
  const pick = await residentReply(signupDb(), ctx, action(many.options[0]), many.session);
  assert.match(pick.card.text, /Confira seu cadastro/);
  const none = await residentReply(signupDb(), ctx, text('99Z 77'), atBlock);
  assert.match(none.card.text, /Não encontrei/);
});

function signupSvc({ account, bindError = null, signupError = null }) {
  const log = { rpc: [], created: [] };
  return { log, svc: {
    rpc: async (fn, args) => {
      log.rpc.push(fn);
      if (fn === 'resident_bot_account') return { data: account, error: null };
      if (fn === 'resident_bot_account_bind') return { data: null, error: bindError };
      if (fn === 'resident_bot_signup') return { data: { request_id: 'R', status: 'pending' }, error: signupError };
      return { data: null, error: { message: fn } };
    },
    auth: { admin: { createUser: async (u) => { log.created.push(u); return { data: { user: { id: 'NEW' } }, error: null }; } } },
  } };
}
const d = { name: 'Ana Souza', phone: '5511988887777', block: '8A', unit: '12', privacy_hash: 'h' };

test('pré-cadastro: conta nova criada sem senha, marcada pelo servidor, vinculada e pedido enviado', async () => {
  const { svc: s, log } = signupSvc({ account: { email: 'a@x.test', user_id: null, confirmed: false } });
  const r = await submitSignup(s, ctx, d);
  assert.equal(r.ok, true, r.text);
  assert.equal(log.created.length, 1);
  assert.equal(log.created[0].password, undefined, 'nunca define senha');
  assert.deepEqual(log.created[0].app_metadata, { resident_bot_provisioned: true });
  assert.deepEqual(log.rpc, ['resident_bot_account', 'resident_bot_account_bind', 'resident_bot_signup']);
});

test('pré-cadastro: nova tentativa com a conta criada pelo bot antes (erro anterior) reaproveita a conta', async () => {
  const { svc: s, log } = signupSvc({ account: { email: 'a@x.test', user_id: 'OLD', confirmed: true, bot_provisioned: true } });
  const r = await submitSignup(s, ctx, d);
  assert.equal(r.ok, true, r.text);
  assert.equal(log.created.length, 0, 'não cria outra conta');
  assert.ok(log.rpc.includes('resident_bot_account_bind'));
});

test('pré-cadastro: conta comum já existente pede acesso sem nada de senha; recusa do banco aparece ao morador', async () => {
  const ok = signupSvc({ account: { email: 'a@x.test', user_id: 'U', confirmed: true, bot_provisioned: false } });
  assert.equal((await submitSignup(ok.svc, ctx, d)).ok, true);
  assert.ok(!ok.log.rpc.includes('resident_bot_account_bind'));
  const bad = signupSvc({ account: { email: 'a@x.test', user_id: null }, bindError: { message: 'Conta não elegível' } });
  const r = await submitSignup(bad.svc, ctx, d);
  assert.equal(r.ok, false); assert.match(r.text, /portal/);
});
