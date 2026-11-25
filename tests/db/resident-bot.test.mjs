// Bot do morador no WhatsApp: identidade sempre por e-mail + código de 6 dígitos (mesmo com celular cadastrado ou LID);
// ações COMO o morador (mesmas regras do app); pré-cadastro chamando o MESMO request_access + aprovação + link de senha
// (somente contas novas provisionadas pelo bot sem senha prévia); QR de retirada por link de uso único; isolamento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('resident_bot: identidade por OTP, ações do app, pré-cadastro, senha 7d, QR por link e isolamento', async () => {
  const db = await createDb();
  // Colunas reais do GoTrue usadas pelo provisionamento (o shim de testes só tem o mínimo).
  await db.sql(`alter table auth.users add column if not exists encrypted_password text,
    add column if not exists raw_app_meta_data jsonb default '{}'::jsonb, add column if not exists created_at timestamptz default now()`);
  await db.sql('update plans set published = true');
  const svc = async (fn, args) => {
    const keys = Object.keys(args);
    const [row] = await db.service(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
    return row.r;
  };
  const sind = await db.createUser('s@bot.invalid', { name: 'Síndica' });
  const sindB = await db.createUser('b@bot.invalid', { name: 'Síndico B' });
  const por = await db.createUser('p@bot.invalid', { name: 'Porteiro' });
  const ana = await db.createUser('ana@bot.invalid', { name: 'Ana Souza' });
  const ze = await db.createUser('ze@bot.invalid', { name: 'Zé Lima' });
  const prov = (u, slug, doc) => db.rpc(u, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: `C ${slug}`, p_slug: slug,
    p_document: doc, p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' }).then((r) => r.tenant_id);
  const A = await prov(sind, 'bot-a', '11444777000161');
  const B = await prov(sindB, 'bot-b', '11222333000181');
  await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'porteiro','active')`, [A, por]);
  const [{ id: u101 }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'Quadra 3','Lote 15') returning id`, [A]);
  const [{ id: u202 }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'B','202') returning id`, [A]);
  const [{ id: uB }] = await db.sql(`insert into units(tenant_id,block,label) values($1,'X','1') returning id`, [B]);
  const member = async (t, unit, u, phone) => {
    await db.sql(`insert into tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'morador','active')`, [t, u]);
    await db.sql(`insert into unit_memberships(tenant_id,unit_id,user_id,status) values($1,$2,$3,'active')`, [t, unit, u]);
    if (phone) await db.sql(`insert into resident_contacts(tenant_id,unit_id,user_id,name,phone) values($1,$2,$3,'Contato',$4)`, [t, unit, u, phone]);
  };
  await member(A, u101, ana, '+5511988887777');
  await member(A, u202, ze, null);
  await member(B, uB, ana, '+5511988887777');

  const recv = async (key, unit, tenant = A, by = por) => {
    await db.rpc(by, 'receive_and_store', { p_tenant: tenant, p_idempotency_key: key, p_unit: unit, p_tracking: key, p_carrier: 'Shopee', p_recipient: 'Ana',
      p_notes: null, p_storage_location: null, p_label_sha256: null, p_courier: 'Lia', p_received_by_name: 'Porteiro' });
    return (await db.sql('select id from packages where upper(tracking_code) = upper($1)', [key]))[0].id;
  };
  const pAna = await recv('k-bot-0001', u101);
  const pZe = await recv('k-bot-0002', u202);
  const pB = await recv('k-bot-b001', uB, B, sindB);

  const lastCode = async (email, tenant = A) => {
    const [j] = await db.sql(`select id from notification_jobs where tenant_id=$1 and event='resident_bot_code' and recipient=$2 order by created_at desc limit 1`, [tenant, email]);
    assert.ok(j, `job de código para ${email}`);
    const [{ ctx }] = await db.service('select public.notification_context($1) ctx', [j.id]);
    assert.match(ctx.bot_code, /^\d{6}$/);
    return { jobId: j.id, code: ctx.bot_code };
  };

  // --- Inicialmente sempre unknown (pede e-mail + código mesmo se o celular está em resident_contacts).
  for (const who of ['5511988887777', '11988887777', '551188887777', 'lid:123456789012', '5511900000000']) {
    const r = await svc('resident_bot_resolve', { p_tenant: A, p_who: who });
    assert.equal(r.status, 'unknown', who);
    assert.equal(r.verified_user_id, null, who);
    assert.equal(r.portal, '/c/bot-a');
    assert.deepEqual(r.links, []);
  }
  await assert.rejects(svc('resident_bot_call', { p_tenant: A, p_who: '5511988887777', p_user: ana, p_action: 'home', p_args: {} }),
    /42501|não autorizado/i, 'celular cadastrado sem OTP verificado não executa ações');

  // --- app.bot_who: LID inválido ou lixo alfanumérico NUNCA vira telefone pelos dígitos.
  for (const bad of ['lid:5511988887777@lid', 'lid:1234', 'abc5511988887777', 'user:11988887777', '']) {
    await assert.rejects(svc('resident_bot_save', { p_tenant: A, p_who: bad, p_state: { step: 'email' } }), /22023|Identidade inválida/);
    await assert.rejects(svc('resident_bot_email_start', { p_tenant: A, p_who: bad, p_email: 'ana@bot.invalid' }), /22023|Identidade inválida/);
    assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: bad, p_code: '123456' }), { ok: false });
  }
  await svc('resident_bot_save', { p_tenant: A, p_who: '11 98888-7777', p_state: { step: 'await_email' } });
  assert.deepEqual((await svc('resident_bot_resolve', { p_tenant: A, p_who: '551188887777' })).state, { step: 'await_email' });

  // --- E-mail + código: envia para qualquer e-mail válido (existente ou novo), invalida anterior, expira, 5 tentativas.
  const ZE_WHO = '5511977776666';
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: ZE_WHO, p_email: 'invalido' }), { sent: false, reason: 'email' });
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: crypto.randomUUID(), p_who: ZE_WHO, p_email: 'ze@bot.invalid' }), { sent: false, reason: 'tenant' });

  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: ZE_WHO, p_email: ' ZE@bot.invalid ' }), { sent: true });
  const firstZe = await lastCode('ze@bot.invalid');
  const [job] = await db.sql(`select * from notification_jobs where id=$1`, [firstZe.jobId]);
  assert.deepEqual([job.channel, job.recipient, job.tenant_id], ['email', 'ze@bot.invalid', A]);
  assert.ok(!JSON.stringify(job.payload).match(/\b\d{6}\b/), 'código não fica no payload da fila');
  assert.equal((await db.service('select public.notification_is_authorized($1) ok', [job.id]))[0].ok, true);

  // Novo envio invalida o código anterior; só o último vale.
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: ZE_WHO, p_email: 'ze@bot.invalid' }), { sent: true });
  const secondZe = await lastCode('ze@bot.invalid');
  assert.equal((await db.service('select public.notification_is_authorized($1) ok', [firstZe.jobId]))[0].ok, false, 'job do código anterior deixa de ser autorizado');
  if (firstZe.code !== secondZe.code) {
    assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: ZE_WHO, p_code: firstZe.code }), { ok: false }, 'código anterior invalidado');
  }

  // Limite: 3 por WhatsApp/hora.
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: ZE_WHO, p_email: 'ze@bot.invalid' }), { sent: true });
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: ZE_WHO, p_email: 'ze@bot.invalid' }), { sent: false, reason: 'limit' });
  const thirdZe = await lastCode('ze@bot.invalid');

  // 5 erros bloqueiam o código vigente.
  const wrong = thirdZe.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: ZE_WHO, p_code: wrong }), { ok: false });
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: ZE_WHO, p_code: thirdZe.code }), { ok: false }, '5 erros bloqueiam o código');

  // Expiração do código (10 min).
  await db.sql(`delete from resident_bot_codes`);
  await db.sql(`delete from notification_jobs where event='resident_bot_code'`);
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: ZE_WHO, p_email: 'ze@bot.invalid' }), { sent: true });
  const expZe = await lastCode('ze@bot.invalid');
  await db.sql(`update resident_bot_codes set expires_at = now() - interval '1 second' where tenant_id=$1 and who=$2`, [A, ZE_WHO]);
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: ZE_WHO, p_code: expZe.code }), { ok: false }, 'código expirado não valida');

  // Verificação válida: retorna status linked e vincula a sessão (inclusive para Ana e para LID).
  await db.sql(`delete from resident_bot_codes`);
  await db.sql(`delete from notification_jobs where event='resident_bot_code'`);
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: ZE_WHO, p_email: 'ze@bot.invalid' }), { sent: true });
  const validZe = await lastCode('ze@bot.invalid');
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: B, p_who: ZE_WHO, p_code: validZe.code }), { ok: false }, 'código de A não vale em B');
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: ZE_WHO, p_code: validZe.code }), { ok: true, status: 'linked' });
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: ZE_WHO, p_code: validZe.code }), { ok: false }, 'código é de uso único');
  const zeR = await svc('resident_bot_resolve', { p_tenant: A, p_who: ZE_WHO });
  assert.equal(zeR.status, 'linked');
  assert.equal(zeR.verified_user_id, ze);
  assert.deepEqual(zeR.links.map((l) => l.user_id), [ze]);

  // Ana verifica pelo celular e também em B; LID também pode verificar.
  for (const [t, who] of [[A, '5511988887777'], [B, '5511988887777'], [A, 'lid:999888777666']]) {
    assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: t, p_who: who, p_email: 'ana@bot.invalid' }), { sent: true });
    const c = await lastCode('ana@bot.invalid', t);
    assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: t, p_who: who, p_code: c.code }), { ok: true, status: 'linked' });
  }
  for (const phone of ['5511988887777', '11988887777', '551188887777', 'lid:999888777666']) {
    const r = await svc('resident_bot_resolve', { p_tenant: A, p_who: phone });
    assert.equal(r.status, 'linked', phone);
    assert.equal(r.verified_user_id, ana, phone);
    assert.deepEqual(r.links.map((l) => l.user_id), [ana]);
    assert.deepEqual(r.links[0].units.map((u) => u.id), [u101], 'só a unidade de A');
    assert.match(r.links[0].units[0].label, /Quadra 3/);
  }

  // Se o e-mail da conta mudar no Auth depois da sessão, o vínculo cai até verificar de novo.
  await db.sql(`update auth.users set email = 'ze-novo@bot.invalid' where id = $1`, [ze]);
  assert.equal((await svc('resident_bot_resolve', { p_tenant: A, p_who: ZE_WHO })).status, 'unknown', 'mudança de e-mail invalida sessão antiga');
  await db.sql(`update auth.users set email = 'ze@bot.invalid' where id = $1`, [ze]);
  assert.equal((await svc('resident_bot_resolve', { p_tenant: A, p_who: ZE_WHO })).status, 'linked');

  // --- Ações COMO o morador: só o que ele vê no app.
  const call = (who, user, action, args = {}, tenant = A) => svc('resident_bot_call', { p_tenant: tenant, p_who: who, p_user: user, p_action: action, p_args: args });
  await assert.rejects(call('5511988887777', ze, 'home'), /42501|não autorizado/i, 'sessão da Ana não age como o Zé');
  await assert.rejects(call(ZE_WHO, ana, 'home'), /42501|não autorizado/i, 'sessão do Zé não age como a Ana');
  await assert.rejects(call('5511988887777', ana, 'apagar_tudo'), /Ação desconhecida/);
  const home = await call('5511988887777', ana, 'home');
  assert.deepEqual(home.waiting.map((p) => p.id), [pAna], 'Ana vê só a encomenda da unidade dela em A');
  const homeLid = await call('lid:999888777666', ana, 'home');
  assert.deepEqual(homeLid.waiting.map((p) => p.id), [pAna], 'Ana autenticada via LID vê sua encomenda');
  const homeZe = await call(ZE_WHO, ze, 'home');
  assert.deepEqual(homeZe.waiting.map((p) => p.id), [pZe]);
  const homeB = await call('5511988887777', ana, 'home', {}, B);
  assert.deepEqual(homeB.waiting.map((p) => p.id), [pB], 'mesma pessoa em B vê só B');
  await assert.rejects(call('5511988887777', ana, 'package', { id: pZe }), /sem acesso/, 'encomenda de outra unidade');
  assert.equal((await call('5511988887777', ana, 'package', { id: pAna })).id, pAna);

  // Palavra-chave: aparece para a portaria/totem (mesma tabela), cancelável pelo morador.
  const kw = await call('5511988887777', ana, 'keyword_save', { unit: u101, keyword: 'AZUL', carrier: 'Shopee' });
  assert.equal(kw.keyword, 'AZUL');
  const staffSees = await db.rpc(por, 'list_delivery_keywords', { p_tenant: A, p_unit: null });
  assert.ok(staffSees.some((k) => k.id === kw.id), 'portaria vê a palavra-chave');
  await assert.rejects(call('5511988887777', ana, 'keyword_save', { unit: u202, keyword: 'VERDE' }), /moradores da unidade/, 'só a própria unidade');
  assert.ok((await call('5511988887777', ana, 'keywords')).some((k) => k.id === kw.id));
  await call('5511988887777', ana, 'keyword_cancel', { id: kw.id });
  assert.equal((await db.sql('select status from delivery_keywords where id = $1', [kw.id]))[0].status, 'cancelled');

  // QR por link de uso único; a página troca o link pelo token uma vez.
  const qr = await call('5511988887777', ana, 'qr', { id: pAna });
  assert.match(qr.link, /^[0-9a-f]{40}$/);
  assert.ok(!JSON.stringify(qr).includes('PP1.'), 'o bot nunca recebe o token cru');
  const opened = await svc('resident_bot_qr_open', { p_code: qr.link });
  assert.match(opened.token, /^PP1\.[0-9a-f]+$/); assert.equal(opened.carrier, 'Shopee'); assert.match(opened.unit, /Quadra 3/);
  assert.deepEqual(await svc('resident_bot_qr_open', { p_code: qr.link }), { used: true }, 'segunda abertura não mostra o QR');
  assert.deepEqual(await svc('resident_bot_qr_open', { p_code: 'x'.repeat(32) }), { invalid: true });
  const look = await db.rpc(por, 'lookup_pickup_token', { p_tenant: A, p_qr: opened.token });
  assert.equal(look.id ?? look.package?.id ?? look.package_id, pAna, 'portaria lê o QR do link');
  await assert.rejects(call('5511988887777', ana, 'qr', { id: pZe }), /sem acesso|sem permissão|não encontrada/i);

  // Recusa pelo morador revoga o QR e some de "aguardando".
  const qr2 = await call('5511988887777', ana, 'qr', { id: pAna });
  await call('5511988887777', ana, 'reject', { id: pAna, reason: 'wrong_unit' });
  assert.deepEqual(await svc('resident_bot_qr_open', { p_code: qr2.link }), { unavailable: true }, 'QR de encomenda recusada não abre');
  assert.ok((await call('5511988887777', ana, 'history')).length >= 0);

  // --- Pré-cadastro pelo WhatsApp: novo morador via LID, request_access + termo, aprovação e link de senha 7 dias.
  const NEW_WHO = 'lid:555444333222';
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: NEW_WHO, p_email: 'novo@bot.invalid' }), { sent: true });
  const cNew = await lastCode('novo@bot.invalid');
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: NEW_WHO, p_code: cNew.code }), { ok: true, status: 'new' });

  const acc0 = await svc('resident_bot_account', { p_tenant: A, p_who: NEW_WHO });
  assert.deepEqual(acc0, { email: 'novo@bot.invalid', user_id: null, confirmed: false });

  // Cria usuário como o backend faz (sem senha, email confirmado, marcador resident_bot_provisioned = true).
  const [{ id: novoUser }] = await db.sql(
    `insert into auth.users (email, email_confirmed_at, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at)
     values ('novo@bot.invalid', now(), null, '{"resident_bot_provisioned":true}'::jsonb, '{"full_name":"Caio Rocha"}'::jsonb, now()) returning id`
  );
  // Tentar vincular conta existente com senha ou sem marcador falha.
  await assert.rejects(svc('resident_bot_account_bind', { p_tenant: A, p_who: NEW_WHO, p_user: ze }), /42501|não elegível/);
  const bound = await svc('resident_bot_account_bind', { p_tenant: A, p_who: NEW_WHO, p_user: novoUser });
  assert.deepEqual(bound, { email: 'novo@bot.invalid', user_id: novoUser, confirmed: true });

  const info = await svc('resident_bot_signup_info', { p_tenant: A });
  assert.equal(info.slug, 'bot-a');
  assert.match(info.term.hash, /^[0-9a-f]{64}$/);
  assert.equal(info.term.content, undefined, 'texto do termo não trafega no bot');
  assert.ok(info.units.units.some((u) => u.block === 'B' && u.label === '202'));

  // Hash inválido do termo é recusado pelo request_access.
  await assert.rejects(
    svc('resident_bot_signup', { p_tenant: A, p_who: NEW_WHO, p_full_name: 'Caio Rocha', p_phone: '11966665555',
      p_block: 'B', p_unit: '202', p_privacy_hash: '0'.repeat(64) }),
    /termo/i
  );

  const up = await svc('resident_bot_signup', { p_tenant: A, p_who: NEW_WHO, p_full_name: 'Caio Rocha', p_phone: '11966665555',
    p_block: 'B', p_unit: '202', p_privacy_hash: info.term.hash });
  assert.equal(up.status, 'pending');
  assert.ok(up.request_id);
  const [ack] = await db.sql(`select * from privacy_acknowledgements where access_request_id = $1 and user_id = $2`, [up.request_id, novoUser]);
  assert.ok(ack, 'aceite do termo gravado pelo request_access');

  // Re-verificar enquanto pendente retorna status = pending.
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: A, p_who: NEW_WHO, p_email: 'novo@bot.invalid' }), { sent: true });
  const cPend = await lastCode('novo@bot.invalid');
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: A, p_who: NEW_WHO, p_code: cPend.code }), { ok: true, status: 'pending' });

  // Síndico aprova: gera link de senha de 7 dias, exposto no contexto da notificação access_decision.
  await db.rpc(sind, 'decide_access_request', { p_request: up.request_id, p_approve: true, p_unit: u202, p_reason: null });
  const [decJob] = await db.sql(`select id from notification_jobs where tenant_id=$1 and event='access_decision' and ref_id=$2 limit 1`, [A, up.request_id]);
  assert.ok(decJob);
  const [{ ctx: decCtx }] = await db.service('select public.notification_context($1) ctx', [decJob.id]);
  assert.match(decCtx.password_link?.token, /^[0-9a-f]{64}$/);
  const pwToken = decCtx.password_link.token;

  const peek1 = await svc('resident_password_link_peek', { p_token: pwToken });
  assert.equal(peek1.valid, true);
  assert.equal(peek1.user_id, novoUser);
  assert.equal(peek1.email, 'novo@bot.invalid');
  const ttlDays = (new Date(peek1.expires_at) - Date.now()) / 86400000;
  assert.ok(ttlDays > 6.9 && ttlDays <= 7.01, `validade de 7 dias (${ttlDays})`);

  // Se a conta já tiver senha definida antes do uso do link, o link fica indisponível (nunca redefine senha existente).
  await db.sql(`update auth.users set encrypted_password = '$2a$10$existinghash' where id = $1`, [novoUser]);
  assert.equal((await svc('resident_password_link_peek', { p_token: pwToken })).unavailable, true, 'conta com senha não pode usar link');
  assert.equal((await svc('resident_password_link_use', { p_token: pwToken })).unavailable, true);
  await db.sql(`update auth.users set encrypted_password = null where id = $1`, [novoUser]);

  // Uso único do link.
  const used1 = await svc('resident_password_link_use', { p_token: pwToken });
  assert.equal(used1.valid, true);
  assert.equal((await svc('resident_password_link_peek', { p_token: pwToken })).used, true);
  assert.equal((await svc('resident_password_link_use', { p_token: pwToken })).used, true, 'segundo uso negado');

  // Conta preexistente (ex.: Zé pedindo acesso no condomínio B pelo bot) NÃO gera link de redefinição de senha ao aprovar.
  assert.deepEqual(await svc('resident_bot_email_start', { p_tenant: B, p_who: ZE_WHO, p_email: 'ze@bot.invalid' }), { sent: true });
  const cZeB = await lastCode('ze@bot.invalid', B);
  assert.deepEqual(await svc('resident_bot_email_verify', { p_tenant: B, p_who: ZE_WHO, p_code: cZeB.code }), { ok: true, status: 'new' });
  const infoB = await svc('resident_bot_signup_info', { p_tenant: B });
  const upZeB = await svc('resident_bot_signup', { p_tenant: B, p_who: ZE_WHO, p_full_name: 'Zé Lima', p_phone: '11977776666',
    p_block: 'X', p_unit: '1', p_privacy_hash: infoB.term.hash });
  await db.rpc(sindB, 'decide_access_request', { p_request: upZeB.request_id, p_approve: true, p_unit: uB, p_reason: null });
  assert.equal((await db.sql(`select count(*)::int n from resident_password_links where request_id=$1`, [upZeB.request_id]))[0].n, 0,
    'conta preexistente não recebe link de criação de senha');

  // --- Vínculo revogado: deixa de reconhecer imediatamente.
  await db.sql(`update tenant_memberships set status='revoked' where tenant_id=$1 and user_id=$2`, [A, ana]);
  assert.equal((await svc('resident_bot_resolve', { p_tenant: A, p_who: '5511988887777' })).status, 'unknown');
  assert.equal((await svc('resident_bot_resolve', { p_tenant: A, p_who: 'lid:999888777666' })).status, 'unknown');
  await assert.rejects(call('5511988887777', ana, 'home'), /42501|não autorizado/i);

  // --- Sem acesso direto; funções só service_role.
  for (const t of ['resident_bot_sessions', 'resident_bot_codes', 'resident_bot_qr_links', 'resident_bot_signups', 'resident_bot_accounts', 'resident_password_links']) {
    const [p] = await db.sql(`select has_table_privilege('authenticated', $1, 'select') a, has_table_privilege('anon', $1, 'select') n`, [`public.${t}`]);
    assert.deepEqual([p.a, p.n], [false, false], t);
  }
  for (const f of ['resident_bot_resolve(uuid,text)', 'resident_bot_save(uuid,text,jsonb)', 'resident_bot_email_start(uuid,text,text)',
    'resident_bot_email_verify(uuid,text,text)', 'resident_bot_account(uuid,text)', 'resident_bot_account_bind(uuid,text,uuid)',
    'resident_bot_signup_info(uuid)', 'resident_bot_signup(uuid,text,text,text,text,text,text)',
    'resident_bot_call(uuid,text,uuid,text,jsonb)', 'resident_bot_qr_open(text)',
    'resident_password_link_peek(text)', 'resident_password_link_use(text)', 'resident_bot_housekeeping()']) {
    const [p] = await db.sql(`select has_function_privilege('authenticated', $1, 'execute') a, has_function_privilege('anon', $1, 'execute') n,
      has_function_privilege('service_role', $1, 'execute') s`, [`public.${f}`]);
    assert.deepEqual([p.a, p.n, p.s], [false, false, true], f);
  }
});
