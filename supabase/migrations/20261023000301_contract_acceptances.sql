-- =============================================================================
-- Contratação eletrônica (parte 2): aceite do contrato pelo condomínio.
-- Aceite NÃO é pagamento nem altera assinatura/pedido: estados separados.
--   contrato  : pending_verification -> active -> superseded (aditivo) | ended
--   pagamento : billing_orders/payments (inalterados aqui)
--   serviço   : subscriptions (inalterado aqui; cancelamento reutiliza cancel_subscription)
-- Evidências são imutáveis (trigger); só campos de situação mudam. Nada é apagado.
-- Ações de aceite rodam pela API (service_role) com o usuário já validado no Auth
-- (p_actor), para que IP/user-agent venham do servidor e não do navegador.
-- =============================================================================

create table public.contract_acceptances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  kind text not null check (kind in ('original','aditivo')),
  previous_id uuid references public.contract_acceptances(id),
  document_id uuid not null references public.legal_documents(id),
  document_version text not null,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  terms jsonb not null,                  -- snapshot do plano/preço/ciclo/limites (catálogo ou proposta), calculado no servidor
  contractor_name text not null check (length(btrim(contractor_name)) between 2 and 200),
  contractor_document text not null check (contractor_document ~ '^\d{11}$|^\d{14}$'),
  representative_name text not null check (length(btrim(representative_name)) between 3 and 160),
  representative_cpf text check (representative_cpf is null or representative_cpf ~ '^\d{11}$'),
  representative_email text not null check (representative_email = lower(btrim(representative_email)) and representative_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  representative_phone text check (representative_phone is null or representative_phone ~ '^\d{10,13}$'),
  representative_role text not null check (length(btrim(representative_role)) between 2 and 120),        -- cargo
  representative_authority text not null check (length(btrim(representative_authority)) between 5 and 300), -- poder declarado
  accepted_by uuid not null references auth.users(id),
  accepted_at timestamptz not null,      -- relógio do servidor
  ip text check (ip is null or ip ~ '^[0-9A-Fa-f:.]{2,64}$'),
  user_agent text check (user_agent is null or length(user_agent) <= 400),
  -- Situação (mutável)
  status text not null default 'pending_verification' check (status in ('pending_verification','active','superseded','ended')),
  email_verified_at timestamptz,
  superseded_by uuid references public.contract_acceptances(id),
  ended_at timestamptz,
  pdf_status text not null default 'pending' check (pdf_status in ('pending','ready')),
  pdf_path text,
  pdf_sha256 text check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check ((kind = 'aditivo') = (previous_id is not null))
);
create index contract_acceptances_tenant_idx on public.contract_acceptances (tenant_id, accepted_at desc);
create unique index contract_acceptances_one_active on public.contract_acceptances (tenant_id) where status = 'active';

create or replace function app.contract_acceptance_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Aceite de contrato é permanente (exclusão bloqueada).' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['status','email_verified_at','superseded_by','ended_at','pdf_status','pdf_path','pdf_sha256'])
     is distinct from (to_jsonb(old) - array['status','email_verified_at','superseded_by','ended_at','pdf_status','pdf_path','pdf_sha256']) then
    raise exception 'Evidências do aceite são imutáveis.' using errcode = '42501';
  end if;
  -- PDF pronto não é substituído (reenvio entrega o mesmo arquivo/hash).
  if old.pdf_status = 'ready' and (new.pdf_path is distinct from old.pdf_path or new.pdf_sha256 is distinct from old.pdf_sha256 or new.pdf_status <> 'ready') then
    raise exception 'PDF do aceite é imutável.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger contract_acceptance_guard before update or delete on public.contract_acceptances
  for each row execute function app.contract_acceptance_guard();

-- Códigos de verificação do e-mail do representante (só hash; nenhum papel de cliente lê).
create table app.contract_verifications (
  acceptance_id uuid primary key references public.contract_acceptances(id),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  sends int not null default 1,
  last_sent_at timestamptz not null
);
revoke all on app.contract_verifications from public, anon, authenticated;

-- Admin do condomínio com permissão de faturamento (vínculo e condomínio ativos).
create or replace function app.can_bill(p_tenant uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce('billing' = any (app.user_permissions(p_tenant, p_user)), false)
$$;

-- Termos comerciais recalculados no servidor: catálogo publicado ou proposta aceita (outra frente).
create or replace function app.contract_terms(p_tenant uuid, p_plan_code text, p_cycle text, p_proposal text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pl public.plans; pr public.plan_prices; e public.plan_entitlements; s public.subscriptions; p jsonb;
begin
  select * into s from public.subscriptions where tenant_id = p_tenant;
  if nullif(btrim(coalesce(p_proposal, '')), '') is not null then
    if to_regprocedure('public.proposal_terms(text)') is null then
      raise exception 'Propostas comerciais ainda não estão disponíveis. Contrate por um plano do catálogo.' using errcode = 'P0001';
    end if;
    execute 'select public.proposal_terms($1)' into p using btrim(p_proposal);
    if p is null or jsonb_typeof(p) <> 'object' or coalesce((p ->> 'amount_cents')::int, 0) <= 0
       or app.cycle_months(p ->> 'cycle') is null then
      raise exception 'Proposta inválida ou não encontrada.' using errcode = 'P0002';
    end if;
    if (p ->> 'valid_until') is not null and (p ->> 'valid_until')::timestamptz <= app.now() then
      raise exception 'A proposta expirou. Solicite uma nova.' using errcode = 'P0001';
    end if;
    select * into pl from public.plans where code = p ->> 'plan_code';
    return jsonb_build_object('source', 'proposal', 'proposal_token_sha256', app.sha256_hex(btrim(p_proposal)),
      'plan_code', p ->> 'plan_code', 'plan_name', coalesce(pl.name, p ->> 'plan_code'), 'cycle', p ->> 'cycle',
      'amount_cents', (p ->> 'amount_cents')::int, 'limits', coalesce(p -> 'limits', '{}'::jsonb), 'valid_until', p -> 'valid_until',
      'billing', 'link_por_ciclo', 'trial_ends_at', case when s.status = 'trialing' then s.trial_ends_at end);
  end if;
  select * into pl from public.plans where code = p_plan_code and published and not is_custom;
  if not found then raise exception 'Plano indisponível.' using errcode = '22023'; end if;
  select * into pr from public.plan_prices where plan_id = pl.id and cycle = p_cycle and active;
  if not found then raise exception 'Ciclo indisponível para este plano.' using errcode = '22023'; end if;
  select * into e from public.plan_entitlements where plan_id = pl.id;
  return jsonb_build_object('source', 'catalog', 'plan_code', pl.code, 'plan_name', pl.name, 'cycle', pr.cycle,
    'amount_cents', pr.amount_cents, 'price_id', pr.id, 'price_version', pr.version, 'limits', to_jsonb(e) - 'plan_id',
    'billing', 'link_por_ciclo', 'trial_ends_at', case when s.status = 'trialing' then s.trial_ends_at end);
end $$;

-- Resumo para a tela de contratação (gestor com faturamento; age como o usuário).
create or replace function public.contract_quote(p_tenant uuid, p_plan_code text default null, p_cycle text default null, p_proposal text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t public.tenants; d jsonb;
begin
  perform app.require(app.can_bill(p_tenant, auth.uid()), 'Somente quem gerencia o faturamento pode contratar.');
  select * into t from public.tenants where id = p_tenant;
  d := public.legal_document_current('contrato_saas');
  return jsonb_build_object('terms', app.contract_terms(p_tenant, p_plan_code, p_cycle, p_proposal),
    'document', d, 'contractor', jsonb_build_object('name', t.name, 'document', t.document),
    'subscription', (select jsonb_build_object('status', s.status, 'trial_ends_at', s.trial_ends_at, 'current_period_end', s.current_period_end,
       'cancel_at_period_end', s.cancel_at_period_end) from public.subscriptions s where s.tenant_id = p_tenant),
    'active', (select jsonb_build_object('id', a.id, 'document_version', a.document_version, 'accepted_at', a.accepted_at)
       from public.contract_acceptances a where a.tenant_id = p_tenant and a.status = 'active'),
    'now', app.now());
end $$;

-- Registra o aceite. Chamado só pela API (service_role) após validar a sessão.
create or replace function public.contract_accept(
  p_actor uuid, p_tenant uuid, p_document_sha256 text, p_accepted boolean,
  p_plan_code text, p_cycle text, p_proposal text,
  p_contractor_name text, p_contractor_document text,
  p_rep_name text, p_rep_cpf text, p_rep_email text, p_rep_phone text, p_rep_role text, p_rep_authority text,
  p_ip text, p_user_agent text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.legal_documents; a public.contract_acceptances; prev uuid; v_now timestamptz := app.now(); v_terms jsonb;
begin
  if p_actor is null or not app.can_bill(p_tenant, p_actor) then
    raise exception 'Somente quem gerencia o faturamento do condomínio pode aceitar o contrato.' using errcode = '42501';
  end if;
  if p_accepted is not true then raise exception 'Marque a caixa de aceite para continuar.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('contract:' || p_tenant::text));
  select * into d from public.legal_documents where kind = 'contrato_saas' and status = 'published';
  if not found then raise exception 'Ainda não há contrato publicado para aceite.' using errcode = 'P0001'; end if;
  if p_document_sha256 is distinct from d.content_sha256 then
    raise exception 'O documento mudou desde que você abriu a página. Revise o novo texto e aceite novamente.' using errcode = 'P0001';
  end if;
  v_terms := app.contract_terms(p_tenant, p_plan_code, p_cycle, p_proposal);
  select id into prev from public.contract_acceptances where tenant_id = p_tenant and status = 'active';
  insert into public.contract_acceptances (tenant_id, kind, previous_id, document_id, document_version, document_sha256, terms,
    contractor_name, contractor_document, representative_name, representative_cpf, representative_email, representative_phone,
    representative_role, representative_authority, accepted_by, accepted_at, ip, user_agent)
  values (p_tenant, case when prev is null then 'original' else 'aditivo' end, prev, d.id, d.version, d.content_sha256, v_terms,
    btrim(p_contractor_name), app.digits(p_contractor_document), btrim(p_rep_name), app.digits(p_rep_cpf), lower(btrim(p_rep_email)),
    app.digits(p_rep_phone), btrim(p_rep_role), btrim(p_rep_authority), p_actor, v_now,
    nullif(left(p_ip, 64), ''), nullif(left(p_user_agent, 400), ''))
  returning * into a;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (p_tenant, p_actor, 'contract.accepted', 'contract_acceptance', a.id::text, jsonb_build_object('kind', a.kind,
    'document_version', a.document_version, 'document_sha256', a.document_sha256, 'amount_cents', v_terms -> 'amount_cents',
    'cycle', v_terms -> 'cycle', 'previous_id', prev));
  return public.contract_pdf_data(a.id);
end $$;

-- Dados para o PDF (somente backend).
create or replace function public.contract_pdf_data(p_acceptance uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(a) || jsonb_build_object('document_md', d.content_md, 'document_kind', d.kind,
    'timezone', t.timezone, 'contractee', (select to_jsonb(e) - 'id' - 'updated_by' - 'updated_at' from public.legal_entity e where e.id))
  from public.contract_acceptances a join public.legal_documents d on d.id = a.document_id join public.tenants t on t.id = a.tenant_id
  where a.id = p_acceptance
$$;

-- Envio da cópia: só ao e-mail do representante, depois de verificado e com PDF pronto.
create or replace function app.contract_enqueue_copy(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  select a.tenant_id, 'contract_copy', 'email', a.representative_email, a.id::text, jsonb_build_object('acceptance_id', a.id)
  from public.contract_acceptances a where a.id = p_id and a.email_verified_at is not null and a.pdf_status = 'ready'
  on conflict do nothing
$$;

create or replace function public.complete_contract_pdf(p_acceptance uuid, p_path text, p_sha256 text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.contract_acceptances;
begin
  select * into a from public.contract_acceptances where id = p_acceptance for update;
  if not found then raise exception 'Aceite não encontrado.' using errcode = 'P0002'; end if;
  if a.pdf_status = 'ready' then return jsonb_build_object('path', a.pdf_path, 'sha256', a.pdf_sha256, 'replayed', true); end if;
  if p_path !~ ('^' || a.tenant_id || '/contracts/' || a.id || '/[A-Za-z0-9-]{8,80}\.pdf$') or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF inválido.' using errcode = '22023';
  end if;
  update public.contract_acceptances set pdf_status = 'ready', pdf_path = p_path, pdf_sha256 = p_sha256 where id = a.id;
  perform app.contract_enqueue_copy(a.id);
  return jsonb_build_object('path', p_path, 'sha256', p_sha256, 'replayed', false);
end $$;

-- Código de 6 dígitos (o banco guarda só o hash). Reenvio: 60 s entre envios, até 5 por aceite.
create or replace function public.contract_set_code(p_actor uuid, p_acceptance uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.contract_acceptances; v app.contract_verifications; v_now timestamptz := app.now();
begin
  select * into a from public.contract_acceptances where id = p_acceptance;
  if not found or not app.can_bill(a.tenant_id, p_actor) then raise exception 'Aceite não encontrado.' using errcode = 'P0002'; end if;
  if a.status <> 'pending_verification' then raise exception 'Este aceite não aguarda verificação.' using errcode = 'P0001'; end if;
  if p_code !~ '^\d{6}$' then raise exception 'Código inválido.' using errcode = '22023'; end if;
  select * into v from app.contract_verifications where acceptance_id = a.id for update;
  if found then
    if v.last_sent_at > v_now - interval '60 seconds' then raise exception 'Aguarde um minuto para pedir outro código.' using errcode = 'P0001'; end if;
    if v.sends >= 5 then raise exception 'Limite de códigos atingido para este aceite. Faça um novo aceite.' using errcode = 'P0001'; end if;
    update app.contract_verifications set code_hash = app.sha256_hex(a.id::text || ':' || p_code), expires_at = v_now + interval '15 minutes',
      attempts = 0, sends = sends + 1, last_sent_at = v_now where acceptance_id = a.id;
  else
    insert into app.contract_verifications (acceptance_id, code_hash, expires_at, last_sent_at)
    values (a.id, app.sha256_hex(a.id::text || ':' || p_code), v_now + interval '15 minutes', v_now);
  end if;
end $$;

create or replace function public.contract_verify(p_actor uuid, p_acceptance uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.contract_acceptances; v app.contract_verifications; v_now timestamptz := app.now();
begin
  select * into a from public.contract_acceptances where id = p_acceptance for update;
  if not found or not app.can_bill(a.tenant_id, p_actor) then raise exception 'Aceite não encontrado.' using errcode = 'P0002'; end if;
  if a.status <> 'pending_verification' then return jsonb_build_object('status', a.status); end if;
  select * into v from app.contract_verifications where acceptance_id = a.id for update;
  if not found then raise exception 'Nenhum código foi enviado. Peça um código.' using errcode = 'P0001'; end if;
  if v.attempts >= 5 then raise exception 'Tentativas esgotadas. Peça um novo código.' using errcode = 'P0001'; end if;
  if v.expires_at <= v_now then raise exception 'Código expirado. Peça um novo código.' using errcode = 'P0001'; end if;
  if coalesce(p_code, '') !~ '^\d{6}$' or app.sha256_hex(a.id::text || ':' || p_code) <> v.code_hash then
    update app.contract_verifications set attempts = attempts + 1 where acceptance_id = a.id;
    return jsonb_build_object('status', a.status, 'error', 'Código incorreto.', 'attempts_left', 4 - v.attempts);
  end if;
  perform pg_advisory_xact_lock(hashtext('contract:' || a.tenant_id::text));
  -- Aditivo: o anterior deixa de ser vigente só quando o novo é confirmado.
  update public.contract_acceptances set status = 'superseded', superseded_by = a.id
   where tenant_id = a.tenant_id and status = 'active' and id <> a.id;
  update public.contract_acceptances set status = 'active', email_verified_at = v_now where id = a.id;
  update app.contract_verifications set attempts = 5, expires_at = v_now where acceptance_id = a.id; -- uso único
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (a.tenant_id, p_actor, 'contract.email_verified', 'contract_acceptance', a.id::text, '{}'::jsonb);
  perform app.contract_enqueue_copy(a.id);
  return jsonb_build_object('status', 'active', 'verified_at', v_now);
end $$;

-- Reenvio da cópia: o mesmo PDF/hash; recoloca o job existente na fila (limite de 5 min).
create or replace function public.contract_resend_copy(p_actor uuid, p_acceptance uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.contract_acceptances;
begin
  select * into a from public.contract_acceptances where id = p_acceptance;
  if not found or not app.can_bill(a.tenant_id, p_actor) then raise exception 'Aceite não encontrado.' using errcode = 'P0002'; end if;
  if a.email_verified_at is null then raise exception 'Confirme o e-mail do representante antes de enviar a cópia.' using errcode = 'P0001'; end if;
  if a.pdf_status <> 'ready' then raise exception 'O PDF ainda está sendo gerado. Tente em instantes.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.audit_logs where target_id = a.id::text and action = 'contract.copy_resent' and created_at > now() - interval '5 minutes') then
    raise exception 'Aguarde 5 minutos para reenviar.' using errcode = 'P0001';
  end if;
  update public.notification_jobs set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null, locked_until = null, updated_at = now()
   where event = 'contract_copy' and ref_id = a.id::text and status not in ('queued', 'sending');
  perform app.contract_enqueue_copy(a.id);
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (a.tenant_id, p_actor, 'contract.copy_resent', 'contract_acceptance', a.id::text, jsonb_build_object('pdf_sha256', a.pdf_sha256));
  return jsonb_build_object('queued', true, 'pdf_sha256', a.pdf_sha256);
end $$;

-- Acesso ao PDF (API emite URL assinada curta do bucket privado).
create or replace function public.contract_pdf_access(p_actor uuid, p_acceptance uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.contract_acceptances;
begin
  select * into a from public.contract_acceptances where id = p_acceptance;
  -- Qualquer admin ativo do condomínio (user_permissions só existe para vínculo admin ativo).
  if not found or app.user_permissions(a.tenant_id, p_actor) is null then
    raise exception 'Aceite não encontrado.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('status', a.pdf_status, 'path', a.pdf_path, 'sha256', a.pdf_sha256, 'tenant_id', a.tenant_id);
end $$;

-- Situação contratual do condomínio (admins do próprio condomínio).
create or replace function public.contract_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare cur public.legal_documents; act public.contract_acceptances; s public.subscriptions; v_now timestamptz := app.now();
begin
  perform app.require(app.is_admin(p_tenant));
  select * into cur from public.legal_documents where kind = 'contrato_saas' and status = 'published';
  select * into act from public.contract_acceptances where tenant_id = p_tenant and status = 'active';
  select * into s from public.subscriptions where tenant_id = p_tenant;
  return jsonb_build_object(
    'state', case when act.id is null then 'none'
      when s.status = 'canceled' and v_now >= coalesce(app.access_until(p_tenant), v_now) then 'ended'
      when s.cancel_at_period_end or s.status = 'canceled' then 'ending' else 'active' end,
    'ends_at', case when s.cancel_at_period_end or s.status = 'canceled' then app.access_until(p_tenant) end,
    'current_version', cur.version,
    'needs_new_acceptance', act.id is not null and cur.id is not null and act.document_id <> cur.id and cur.material_change,
    'can_manage', app.has_perm(p_tenant, 'billing'),
    'acceptances', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'status', a.status, 'previous_id', a.previous_id,
       'document_version', a.document_version, 'document_sha256', a.document_sha256, 'terms', a.terms,
       'representative_name', a.representative_name, 'representative_email', app.mask_recipient('email', a.representative_email),
       'accepted_at', a.accepted_at, 'email_verified_at', a.email_verified_at, 'pdf_status', a.pdf_status, 'pdf_sha256', a.pdf_sha256,
       'copy_status', (select j.status from public.notification_jobs j where j.event = 'contract_copy' and j.ref_id = a.id::text order by j.updated_at desc limit 1))
       order by a.accepted_at desc) from public.contract_acceptances a where a.tenant_id = p_tenant), '[]'));
end $$;

-- Cancelamento pelo próprio cliente (sem contato comercial). Reutiliza cancel_subscription:
-- fim no término do período já liberado, sem nova cobrança. Prévia lista os efeitos.
create or replace function public.contract_cancel_preview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  perform app.require(app.has_perm(p_tenant, 'billing'));
  select * into s from public.subscriptions where tenant_id = p_tenant;
  return jsonb_build_object('status', s.status, 'access_until', app.access_until(p_tenant), 'already', s.cancel_at_period_end or s.status = 'canceled',
    'effects', jsonb_build_array(
      'Nenhuma nova cobrança será gerada; pedidos de pagamento em aberto são cancelados.',
      'O acesso completo continua até o fim do período já liberado (teste ou período pago).',
      'Depois disso, o acesso fica restrito: consulta, exportação de dados e retirada de encomendas já guardadas continuam disponíveis.',
      'Histórico de entregas, comprovantes e registros de aceite são mantidos pelos prazos de retenção da política de privacidade (prazos em definição).',
      'Você pode reativar antes do fim do período sem perder dados.'));
end $$;

create or replace function public.contract_cancel(p_tenant uuid, p_confirm boolean, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require(app.has_perm(p_tenant, 'billing'));
  if p_confirm is not true then raise exception 'Confirme o cancelamento.' using errcode = '22023'; end if;
  v := public.contract_cancel_preview(p_tenant);
  perform public.cancel_subscription(p_tenant);
  perform app.audit(p_tenant, 'contract.cancel_requested', 'tenant', p_tenant::text,
    jsonb_build_object('access_until', v -> 'access_until', 'effects', v -> 'effects', 'reason', left(p_reason, 500)));
  return v || jsonb_build_object('canceled', true);
end $$;

-- Admin Master: aceites com evidências mascaradas.
create or replace function public.platform_contract_acceptances(p_tenant uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.platform_require('legal');
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'tenant_id', a.tenant_id, 'tenant_name', t.name, 'kind', a.kind,
    'status', a.status, 'document_version', a.document_version, 'document_sha256', a.document_sha256,
    'plan', a.terms ->> 'plan_code', 'cycle', a.terms ->> 'cycle', 'amount_cents', a.terms -> 'amount_cents', 'source', a.terms ->> 'source',
    'representative', left(a.representative_name, 1) || '•••', 'representative_email', app.mask_recipient('email', a.representative_email),
    'representative_cpf', case when a.representative_cpf is not null then '•••.•••.•' || right(a.representative_cpf, 4) end,
    'ip', case when a.ip ~ '^\d+\.\d+\.' then split_part(a.ip, '.', 1) || '.' || split_part(a.ip, '.', 2) || '.•.•' when a.ip is not null then left(a.ip, 9) || '…' end,
    'user_agent', left(a.user_agent, 40), 'accepted_at', a.accepted_at, 'email_verified_at', a.email_verified_at,
    'pdf_sha256', a.pdf_sha256) order by a.accepted_at desc)
    from (select * from public.contract_acceptances where p_tenant is null or tenant_id = p_tenant order by accepted_at desc limit 200) a
    join public.tenants t on t.id = a.tenant_id), '[]');
end $$;

-- Aceite dos termos no cadastro do TESTE (sem contrato de compra): grava a versão
-- publicada vigente; sem versão publicada, registra a minuta exibida como não vigente.
create or replace function public.record_trial_consent(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text; v text; out jsonb := '{}';
begin
  perform app.require(app.is_admin(p_tenant));
  foreach k in array array['termos', 'privacidade'] loop
    v := coalesce((select version from public.legal_documents where kind = k and status = 'published'), 'minuta-nao-vigente');
    insert into public.consent_records (tenant_id, user_id, kind, version)
    values (p_tenant, auth.uid(), case k when 'termos' then 'terms' else 'privacy' end, v);
    out := out || jsonb_build_object(k, v);
  end loop;
  return out;
end $$;

-- RLS: só admins do próprio condomínio leem; ninguém escreve direto; nada para anon.
alter table public.contract_acceptances enable row level security;
revoke all on public.contract_acceptances from public, anon, authenticated;
grant select on public.contract_acceptances to authenticated;
grant all on public.contract_acceptances to service_role;
create policy contract_acceptances_select on public.contract_acceptances for select to authenticated using (app.is_admin(tenant_id));

-- PDFs de contrato: bucket privado; só o backend grava e emite URL assinada.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-contracts', 'tenant-contracts', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Contexto do outbox: encadeia o existente (renomeado) e acrescenta o contrato.
do $$
begin
  if to_regprocedure('app.notification_context_pre_contracts(uuid)') is null then
    alter function public.notification_context(uuid) rename to notification_context_pre_contracts;
    alter function public.notification_context_pre_contracts(uuid) set schema app;
  end if;
end $$;
create or replace function public.notification_context(p_job uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select app.notification_context_pre_contracts(p_job) || jsonb_build_object('contract',
    (select jsonb_build_object('id', a.id, 'document_version', a.document_version, 'document_sha256', a.document_sha256,
       'accepted_at', a.accepted_at, 'plan_name', a.terms ->> 'plan_name', 'cycle', a.terms ->> 'cycle', 'amount_cents', a.terms -> 'amount_cents',
       'representative_name', a.representative_name, 'pdf_path', case when a.pdf_status = 'ready' then a.pdf_path end, 'pdf_sha256', a.pdf_sha256)
     from public.notification_jobs j join public.contract_acceptances a on a.id::text = j.ref_id and a.tenant_id = j.tenant_id
     where j.id = p_job and j.event = 'contract_copy'))
$$;

revoke all on function app.contract_acceptance_guard(), app.can_bill(uuid, uuid), app.contract_terms(uuid, text, text, text),
  app.contract_enqueue_copy(uuid), app.notification_context_pre_contracts(uuid) from public, anon, authenticated;
revoke all on function public.contract_quote(uuid, text, text, text),
  public.contract_accept(uuid, uuid, text, boolean, text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.contract_pdf_data(uuid), public.complete_contract_pdf(uuid, text, text), public.contract_set_code(uuid, uuid, text),
  public.contract_verify(uuid, uuid, text), public.contract_resend_copy(uuid, uuid), public.contract_pdf_access(uuid, uuid),
  public.contract_overview(uuid), public.contract_cancel_preview(uuid), public.contract_cancel(uuid, boolean, text),
  public.platform_contract_acceptances(uuid), public.record_trial_consent(uuid), public.notification_context(uuid)
  from public, anon, authenticated;
grant execute on function public.contract_quote(uuid, text, text, text), public.contract_overview(uuid),
  public.contract_cancel_preview(uuid), public.contract_cancel(uuid, boolean, text),
  public.platform_contract_acceptances(uuid), public.record_trial_consent(uuid) to authenticated, service_role;
grant execute on function
  public.contract_accept(uuid, uuid, text, boolean, text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.contract_pdf_data(uuid), public.complete_contract_pdf(uuid, text, text), public.contract_set_code(uuid, uuid, text),
  public.contract_verify(uuid, uuid, text), public.contract_resend_copy(uuid, uuid), public.contract_pdf_access(uuid, uuid),
  public.notification_context(uuid), app.notification_context_pre_contracts(uuid) to service_role;
