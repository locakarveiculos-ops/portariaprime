-- =============================================================================
-- Atendimento ao morador pelo WhatsApp do condomínio (motor Whaileys, só botões, sem IA). Aditiva.
--  * Identidade ("who"): celular (55 + DDD + número) ou "lid:<n>" quando o WhatsApp esconde o número.
--    Reconhece pelo celular do cadastro (resident_contacts) ou por e-mail confirmado com código de 6 dígitos
--    (vínculo who -> conta guardado por 90 dias em resident_bot_sessions).
--  * Ações: resident_bot_call age COMO o morador (request.jwt.claim.sub na transação) e chama as RPCs do app;
--    nenhuma regra de permissão nova (is_unit_member / resident_units continuam valendo).
--  * Pré-cadastro: com o e-mail confirmado, resident_bot_signup chama o MESMO request_access do portal (termo,
--    avisos ao síndico e ao morador). Ao aprovar, o aviso de boas-vindas leva um link pessoal para criar a senha
--    (resident_password_links, 7 dias, uso único).
--  * QR de retirada: link curto de uso único (resident_bot_qr_links) trocado pelo token na página /qr.
--  * Tabelas sem acesso de usuários; funções só service_role (o webhook confere a assinatura do motor antes).
-- =============================================================================

create table public.resident_bot_sessions (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  who text not null check (who ~ '^(55\d{10,11}|lid:\d{5,30})$'),
  user_id uuid references auth.users(id) on delete set null,      -- conta ligada a este WhatsApp (e-mail confirmado)
  email text check (email is null or (email = lower(email) and length(email) <= 254)),
  verified_at timestamptz,
  state jsonb not null default '{}'::jsonb check (length(state::text) <= 8000),   -- passo da conversa
  updated_at timestamptz not null default now(),
  primary key (tenant_id, who)
);

create table public.resident_bot_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  who text not null check (who ~ '^(55\d{10,11}|lid:\d{5,30})$'),
  email text not null check (email = lower(email) and length(email) <= 254),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  code text not null check (code ~ '^\d{6}$'),               -- lido só pelo contexto do e-mail; zerado na verificação
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index resident_bot_codes_who_idx on public.resident_bot_codes (tenant_id, who, created_at desc);
create index resident_bot_codes_email_idx on public.resident_bot_codes (email, created_at desc);

create table public.resident_bot_qr_links (
  code text primary key check (code ~ '^[0-9a-f]{40}$'),
  tenant_id uuid not null,
  package_id uuid not null,
  token text not null,
  opened_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id) on delete cascade
);

-- Pedido de cadastro feito pelo WhatsApp (o pedido em si é o mesmo access_requests do portal).
create table public.resident_bot_signups (
  request_id uuid primary key references public.access_requests(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  who text not null check (who ~ '^(55\d{10,11}|lid:\d{5,30})$'),
  created_at timestamptz not null default now()
);

-- Conta criada pelo bot após OTP: somente estas contas (sem senha prévia) podem gerar/usar link de senha.
create table public.resident_bot_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  who text not null check (who ~ '^(55\d{10,11}|lid:\d{5,30})$'),
  email text not null check (email = lower(email) and length(email) <= 254),
  created_at timestamptz not null default now()
);

-- Link para criar a senha depois da aprovação (7 dias, uso único).
create table public.resident_password_links (
  request_id uuid primary key references public.access_requests(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique check (token ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.resident_bot_sessions enable row level security;
alter table public.resident_bot_codes enable row level security;
alter table public.resident_bot_qr_links enable row level security;
alter table public.resident_bot_signups enable row level security;
alter table public.resident_bot_accounts enable row level security;
alter table public.resident_password_links enable row level security;
revoke all on public.resident_bot_sessions, public.resident_bot_codes, public.resident_bot_qr_links,
  public.resident_bot_signups, public.resident_bot_accounts, public.resident_password_links from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
/** Celular brasileiro para 55 + DDD + número (com 9º dígito). Inválido = null. */
create function app.bot_phone(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when d ~ '^55\d{2}[6-9]\d{7}$' then left(d, 4) || '9' || right(d, 8)
    when d ~ '^\d{10,11}$' then app.bot_phone('55' || d)
    when d ~ '^55\d{10,11}$' then d
  end from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') d) x
$$;

/** Identidade no WhatsApp: "lid:<n>" como veio, ou o celular normalizado. Inválido = null. */
create function app.bot_who(p text) returns text
language sql immutable set search_path = '' as $$
  select case
    when coalesce(p, '') ~ '^lid:\d{5,30}$' then p
    when coalesce(p, '') ~ '^\+?[0-9() .-]+$' then app.bot_phone(p)
  end
$$;

/** Morador ativo do condomínio (papel morador, vínculo ativo e ao menos uma unidade ativa). */
create function app.bot_resident_ok(p_tenant uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
                  where m.tenant_id = p_tenant and m.user_id = p_user and m.role = 'morador' and m.status = 'active' and t.status = 'active')
     and exists (select 1 from public.unit_memberships um where um.tenant_id = p_tenant and um.user_id = p_user and um.status = 'active')
$$;

/** Moradores que este WhatsApp representa: celular do cadastro ou e-mail confirmado por código (90 dias). */
create function app.bot_users(p_tenant uuid, p_who text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.user_id from public.resident_bot_sessions s
    join auth.users u on u.id = s.user_id and lower(u.email) = s.email and u.email_confirmed_at is not null
   where s.tenant_id = p_tenant and s.who = app.bot_who(p_who)
     and s.verified_at > now() - interval '90 days'
     and app.bot_resident_ok(p_tenant, s.user_id)
$$;

/** Age como o morador nesta transação (as RPCs do app leem auth.uid()). */
create function app.bot_as(p_tenant uuid, p_who text, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user is null or not exists (select 1 from app.bot_users(p_tenant, p_who) u where u = p_user) then
    raise exception 'Número não autorizado para este morador.' using errcode = '42501';
  end if;
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'via', 'whatsapp_bot')::text, true);
end $$;

/** Conta provisionada pelo bot e ainda sem senha definida (elegível para link de criação de senha). */
-- plpgsql (validado só na execução): encrypted_password/raw_app_meta_data são colunas do GoTrue.
create function app.bot_password_eligible(p_user uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from public.resident_bot_accounts a
      join auth.users u on u.id = a.user_id and lower(u.email) = a.email
     where a.user_id = p_user
       and u.email_confirmed_at is not null
       and coalesce(btrim(u.encrypted_password), '') = ''
       and coalesce((u.raw_app_meta_data->>'resident_bot_provisioned')::boolean, false));
end $$;

revoke all on function app.bot_phone(text), app.bot_who(text), app.bot_resident_ok(uuid, uuid), app.bot_users(uuid, text),
  app.bot_as(uuid, text, uuid), app.bot_password_eligible(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Identidade e conversa
-- -----------------------------------------------------------------------------
/** Quem está falando + passo salvo da conversa. */
create function public.resident_bot_resolve(p_tenant uuid, p_who text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'status', case when exists (select 1 from app.bot_users(p_tenant, p_who)) then 'linked' else 'unknown' end,
    'verified_user_id', (select u from app.bot_users(p_tenant, p_who) u limit 1),
    'slug', t.slug, 'portal', '/c/' || t.slug, 'tenant_name', coalesce(b.display_name, t.name), 'active', t.status = 'active',
    'state', coalesce((select s.state from public.resident_bot_sessions s where s.tenant_id = p_tenant and s.who = app.bot_who(p_who)), '{}'::jsonb),
    'links', coalesce((select jsonb_agg(jsonb_build_object('user_id', u,
        'name', (select split_part(btrim(coalesce(p.full_name, '')), ' ', 1) from public.profiles p where p.id = u),
        'units', (select coalesce(jsonb_agg(jsonb_build_object('id', un.id, 'label', app.unit_display(p_tenant, un.block, un.label))
                    order by un.block nulls first, un.label), '[]'::jsonb)
                    from public.unit_memberships um join public.units un on un.id = um.unit_id
                   where um.tenant_id = p_tenant and um.user_id = u and um.status = 'active')))
      from app.bot_users(p_tenant, p_who) u), '[]'::jsonb))
  from public.tenants t left join public.tenant_branding b on b.tenant_id = t.id
  where t.id = p_tenant
$$;

/** Guarda o passo da conversa (não mexe no vínculo). */
create function public.resident_bot_save(p_tenant uuid, p_who text, p_state jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_who text := app.bot_who(p_who);
begin
  if v_who is null then raise exception 'Identidade inválida.' using errcode = '22023'; end if;
  insert into public.resident_bot_sessions (tenant_id, who, state, updated_at)
  values (p_tenant, v_who, coalesce(p_state, '{}'::jsonb), now())
  on conflict (tenant_id, who) do update set state = excluded.state, updated_at = now();
end $$;

/**
 * Envia o código de 6 dígitos ao e-mail (cadastro novo ou morador já cadastrado). Não diz se o e-mail tem conta.
 * Limites: 3 por WhatsApp/hora, 5 por e-mail/dia, 200 por condomínio/dia.
 */
create function public.resident_bot_email_start(p_tenant uuid, p_who text, p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_who text := app.bot_who(p_who); v_email text := lower(btrim(coalesce(p_email, ''))); v_code text; c public.resident_bot_codes;
begin
  if v_who is null then raise exception 'Identidade inválida.' using errcode = '22023'; end if;
  if v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$' or length(v_email) > 254 then
    return jsonb_build_object('sent', false, 'reason', 'email');
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant and status = 'active') then
    return jsonb_build_object('sent', false, 'reason', 'tenant');
  end if;
  perform pg_advisory_xact_lock(hashtext('bot_otp_who:' || p_tenant::text || ':' || v_who));
  perform pg_advisory_xact_lock(hashtext('bot_otp_email:' || v_email));
  perform pg_advisory_xact_lock(hashtext('bot_otp_tenant:' || p_tenant::text));
  if (select count(*) from public.resident_bot_codes where tenant_id = p_tenant and who = v_who and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.resident_bot_codes where email = v_email and created_at > now() - interval '1 day') >= 5
     or (select count(*) from public.resident_bot_codes where tenant_id = p_tenant and created_at > now() - interval '1 day') >= 200 then
    return jsonb_build_object('sent', false, 'reason', 'limit');
  end if;
  update public.resident_bot_codes set used_at = now(), code = '000000'
   where tenant_id = p_tenant and who = v_who and used_at is null;
  v_code := lpad(((('x' || left(app.random_token(), 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into public.resident_bot_codes (tenant_id, who, email, code_hash, code, expires_at)
  values (p_tenant, v_who, v_email, app.sha256_hex(p_tenant::text || ':' || v_who || ':' || v_code), v_code, now() + interval '10 minutes')
  returning * into c;
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  values (p_tenant, 'resident_bot_code', 'email', v_email, c.id::text, '{}'::jsonb)
  on conflict do nothing;
  return jsonb_build_object('sent', true);
end $$;

/**
 * Confere o código (10 min, 5 tentativas, uso único) e liga este WhatsApp ao e-mail por 90 dias.
 * status: linked (morador ativo daqui) | pending (pedido aguardando aprovação) | new (sem cadastro de morador aqui).
 */
create function public.resident_bot_email_verify(p_tenant uuid, p_who text, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_who text := app.bot_who(p_who); c public.resident_bot_codes; v_user uuid; v_status text;
begin
  if v_who is null or coalesce(p_code, '') !~ '^\d{6}$' then return jsonb_build_object('ok', false); end if;
  select * into c from public.resident_bot_codes
   where tenant_id = p_tenant and who = v_who and used_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if not found or c.attempts >= 5 then return jsonb_build_object('ok', false); end if;
  if c.code_hash <> app.sha256_hex(p_tenant::text || ':' || v_who || ':' || p_code) then
    update public.resident_bot_codes set attempts = attempts + 1 where id = c.id;
    return jsonb_build_object('ok', false);
  end if;
  update public.resident_bot_codes set used_at = now(), code = '000000' where id = c.id;
  select u.id into v_user from auth.users u where lower(u.email) = c.email and u.email_confirmed_at is not null limit 1;
  v_status := case
    when v_user is not null and app.bot_resident_ok(p_tenant, v_user) then 'linked'
    when v_user is not null and exists (select 1 from public.access_requests r where r.tenant_id = p_tenant and r.user_id = v_user and r.status = 'pending') then 'pending'
    else 'new' end;
  insert into public.resident_bot_sessions (tenant_id, who, user_id, email, verified_at, updated_at)
  values (p_tenant, v_who, v_user, c.email, now(), now())
  on conflict (tenant_id, who) do update set user_id = excluded.user_id, email = excluded.email, verified_at = now(), updated_at = now();
  perform app.audit(p_tenant, 'resident_bot.verified', 'user', coalesce(v_user::text, ''), jsonb_build_object('status', v_status));
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

/** E-mail confirmado há até 2 h neste WhatsApp e a conta dele (se já existir), para o pré-cadastro. */
create function public.resident_bot_account(p_tenant uuid, p_who text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.resident_bot_sessions; u auth.users;
begin
  select * into s from public.resident_bot_sessions where tenant_id = p_tenant and who = app.bot_who(p_who);
  if not found or s.email is null or s.verified_at is null or s.verified_at < now() - interval '2 hours' then
    raise exception 'Confirme seu e-mail de novo para enviar o cadastro.' using errcode = '42501';
  end if;
  select * into u from auth.users where lower(email) = s.email limit 1;
  return jsonb_build_object('email', s.email, 'user_id', u.id, 'confirmed', u.email_confirmed_at is not null);
end $$;

/**
 * Registra conta recém-provisionada pelo bot (sem senha prévia e com app_metadata.resident_bot_provisioned = true)
 * na sessão que confirmou esse mesmo e-mail por código há até 2 h. Nunca vincula conta preexistente ou com senha.
 */
create function public.resident_bot_account_bind(p_tenant uuid, p_who text, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.resident_bot_sessions; u auth.users;
begin
  if p_user is null then raise exception 'Conta inválida.' using errcode = '22023'; end if;
  select * into s from public.resident_bot_sessions where tenant_id = p_tenant and who = app.bot_who(p_who) for update;
  if not found or s.email is null or s.verified_at is null or s.verified_at < now() - interval '2 hours' then
    raise exception 'Confirme seu e-mail de novo para enviar o cadastro.' using errcode = '42501';
  end if;
  if s.user_id is not null and s.user_id <> p_user then
    raise exception 'Sessão já vinculada a outra conta.' using errcode = '42501';
  end if;
  select * into u from auth.users where id = p_user and lower(email) = s.email for update;
  if not found or u.email_confirmed_at is null
     or coalesce(btrim(u.encrypted_password), '') <> ''
     or not coalesce((u.raw_app_meta_data->>'resident_bot_provisioned')::boolean, false)
     or (u.created_at is not null and u.created_at < s.verified_at - interval '1 minute') then
    raise exception 'Conta não elegível para provisionamento pelo WhatsApp.' using errcode = '42501';
  end if;
  insert into public.resident_bot_accounts (user_id, tenant_id, who, email)
  values (u.id, p_tenant, s.who, s.email)
  on conflict (user_id) do update set tenant_id = excluded.tenant_id, who = excluded.who
   where public.resident_bot_accounts.email = excluded.email;
  if not found then
    raise exception 'Conta não elegível para provisionamento pelo WhatsApp.' using errcode = '42501';
  end if;
  update public.resident_bot_sessions set user_id = u.id, updated_at = now()
   where tenant_id = s.tenant_id and who = s.who;
  perform app.audit(p_tenant, 'resident_bot.account_bound', 'user', u.id::text, jsonb_build_object('who', s.who));
  return jsonb_build_object('email', s.email, 'user_id', u.id, 'confirmed', true);
end $$;

/** Unidades e termo do condomínio para o pré-cadastro (mesmas funções públicas do portal). */
create function public.resident_bot_signup_info(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('slug', t.slug,
    'units', public.portal_units(t.slug),
    'term', app.privacy_term_effective(t.id) - 'template_hash' - 'content')
  from public.tenants t where t.id = p_tenant and t.status = 'active'
$$;

/**
 * Pré-cadastro pelo WhatsApp: exige e-mail confirmado por código (2 h) e chama o MESMO request_access do portal como a
 * conta confirmada desse e-mail (termo, limites, avisos ao síndico e ao morador). A aprovação continua com o síndico.
 */
create function public.resident_bot_signup(p_tenant uuid, p_who text, p_full_name text, p_phone text, p_block text, p_unit text, p_privacy_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.resident_bot_sessions; u auth.users; v_slug text; r jsonb;
begin
  select * into s from public.resident_bot_sessions where tenant_id = p_tenant and who = app.bot_who(p_who) for update;
  if not found or s.email is null or s.verified_at is null or s.verified_at < now() - interval '2 hours' then
    raise exception 'Confirme seu e-mail de novo para enviar o cadastro.' using errcode = '42501';
  end if;
  select * into u from auth.users where lower(email) = s.email limit 1;
  if not found then raise exception 'Conta não encontrada. Tente de novo.' using errcode = 'P0002'; end if;
  if u.email_confirmed_at is null or (s.user_id is not null and s.user_id <> u.id) then
    raise exception 'Confirme seu e-mail antes de solicitar o cadastro.' using errcode = '42501';
  end if;
  if s.user_id is null and not app.bot_password_eligible(u.id) then
    raise exception 'Conta criada fora desta verificação. Confirme o código novamente.' using errcode = '42501';
  end if;
  select slug into v_slug from public.tenants where id = p_tenant;
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u.id, 'role', 'authenticated', 'via', 'whatsapp_bot')::text, true);
  r := public.request_access(v_slug, p_full_name, p_phone, p_block, p_unit, p_privacy_hash);
  insert into public.resident_bot_signups (request_id, tenant_id, user_id, who)
  values ((r->>'request_id')::uuid, p_tenant, u.id, s.who)
  on conflict (request_id) do update set who = excluded.who;
  update public.resident_bot_sessions set user_id = u.id, updated_at = now() where tenant_id = s.tenant_id and who = s.who;
  perform app.audit(p_tenant, 'resident_bot.signup', 'access_request', r->>'request_id', jsonb_build_object('via', 'whatsapp'));
  return r;
end $$;

-- -----------------------------------------------------------------------------
-- Ações (como o morador)
-- -----------------------------------------------------------------------------
create function public.resident_bot_call(p_tenant uuid, p_who text, p_user uuid, p_action text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a jsonb := coalesce(p_args, '{}'::jsonb); r jsonb; v_code text;
begin
  perform app.bot_as(p_tenant, p_who, p_user);
  if p_action = 'home' then
    return public.resident_home(p_tenant, nullif(a->>'unit', '')::uuid);
  elsif p_action = 'package' then
    return public.resident_package(p_tenant, (a->>'id')::uuid);
  elsif p_action = 'history' then
    return public.resident_history(p_tenant, nullif(a->>'unit', '')::uuid, null, null, null, null, null, null, 10);
  elsif p_action = 'keywords' then
    return public.list_delivery_keywords(p_tenant, null);
  elsif p_action = 'keyword_save' then
    return public.delivery_keyword_save_v2(p_tenant, null, (a->>'unit')::uuid, a->>'keyword', nullif(a->>'carrier', ''), null,
      'Cadastrada pelo WhatsApp.', null);
  elsif p_action = 'keyword_cancel' then
    return public.delivery_keyword_cancel(p_tenant, (a->>'id')::uuid);
  elsif p_action = 'reject' then
    return public.resident_reject_package(p_tenant, (a->>'id')::uuid, a->>'reason', nullif(a->>'note', ''));
  elsif p_action = 'qr' then
    r := public.issue_pickup_token(p_tenant, (a->>'id')::uuid);
    v_code := left(app.random_token(), 40);
    insert into public.resident_bot_qr_links (code, tenant_id, package_id, token, expires_at)
    values (v_code, p_tenant, (a->>'id')::uuid, r->>'token', least((r->>'expires_at')::timestamptz, now() + interval '24 hours'));
    return jsonb_build_object('link', v_code, 'expires_at', least((r->>'expires_at')::timestamptz, now() + interval '24 hours'));
  end if;
  raise exception 'Ação desconhecida.' using errcode = '22023';
end $$;

/** Página /qr: troca o link pelo token uma única vez; encomenda que não aguarda mais (retirada/recusada) não abre. */
create function public.resident_bot_qr_open(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.resident_bot_qr_links; p public.packages;
begin
  if coalesce(p_code, '') !~ '^[0-9a-f]{40}$' then return jsonb_build_object('invalid', true); end if;
  select * into l from public.resident_bot_qr_links where code = p_code for update;
  if not found then return jsonb_build_object('invalid', true); end if;
  if l.opened_at is not null then return jsonb_build_object('used', true); end if;
  select * into p from public.packages where tenant_id = l.tenant_id and id = l.package_id;
  update public.resident_bot_qr_links set opened_at = now(), token = '' where code = l.code;
  if l.expires_at <= now() or not app.occupies_space(p.status) or p.rejected_at is not null
     or not exists (select 1 from public.pickup_tokens t where t.tenant_id = l.tenant_id and t.package_id = l.package_id
                     and t.token_hash = app.token_hash_from_qr(l.token) and t.consumed_at is null and t.revoked_at is null) then
    return jsonb_build_object('unavailable', true);
  end if;
  return jsonb_build_object('token', l.token, 'expires_at', l.expires_at, 'carrier', p.carrier,
    'unit', (select app.unit_display(p.tenant_id, u.block, u.label) from public.units u where u.id = p.unit_id),
    'tenant_name', (select coalesce(b.display_name, t.name) from public.tenants t left join public.tenant_branding b on b.tenant_id = t.id where t.id = l.tenant_id));
end $$;

-- -----------------------------------------------------------------------------
-- Senha depois da aprovação (cadastro feito pelo WhatsApp, conta provisionada sem senha prévia)
-- -----------------------------------------------------------------------------
create function app.resident_bot_on_approve() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved'
     and exists (select 1 from public.resident_bot_signups b where b.request_id = new.id and b.user_id = new.user_id) then
    if app.bot_password_eligible(new.user_id) then
      insert into public.resident_password_links (request_id, tenant_id, user_id, token, expires_at)
      values (new.id, new.tenant_id, new.user_id, app.random_token(), now() + interval '7 days')
      on conflict (request_id) do update set token = excluded.token, expires_at = excluded.expires_at, used_at = null, created_at = now();
    end if;
  end if;
  return null;
end $$;
revoke all on function app.resident_bot_on_approve() from public, anon, authenticated;
create trigger access_request_bot_password after update of status on public.access_requests
  for each row execute function app.resident_bot_on_approve();

/** Situação do link (página /c/<slug>/criar-senha). user_id só para o servidor. */
create function public.resident_password_link_peek(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l public.resident_password_links; v_slug text; v_name text; v_email text;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('invalid', true); end if;
  select * into l from public.resident_password_links where token = p_token;
  if not found then return jsonb_build_object('invalid', true); end if;
  select t.slug, coalesce(b.display_name, t.name) into v_slug, v_name
    from public.tenants t left join public.tenant_branding b on b.tenant_id = t.id where t.id = l.tenant_id;
  if l.used_at is not null then return jsonb_build_object('used', true, 'slug', v_slug); end if;
  if l.expires_at <= now() then return jsonb_build_object('expired', true, 'slug', v_slug); end if;
  if not app.bot_resident_ok(l.tenant_id, l.user_id)
     or not exists (select 1 from public.access_requests r where r.id = l.request_id and r.tenant_id = l.tenant_id and r.user_id = l.user_id and r.status = 'approved')
     or not app.bot_password_eligible(l.user_id) then
    return jsonb_build_object('unavailable', true, 'slug', v_slug);
  end if;
  select lower(email) into v_email from auth.users where id = l.user_id;
  return jsonb_build_object('valid', true, 'slug', v_slug, 'tenant_name', v_name, 'email', v_email, 'user_id', l.user_id, 'expires_at', l.expires_at);
end $$;

/** Consome o link (uso único, sem reabertura) antes de gravar a senha inicial. */
create function public.resident_password_link_use(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.resident_password_links; v jsonb;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('invalid', true); end if;
  select * into l from public.resident_password_links where token = p_token for update;
  v := public.resident_password_link_peek(p_token);
  if not coalesce((v->>'valid')::boolean, false) then return v; end if;
  update public.resident_password_links set used_at = now() where request_id = l.request_id;
  perform app.audit(l.tenant_id, 'resident.password_link_used', 'user', l.user_id::text, '{}'::jsonb);
  return v;
end $$;

/** Limpeza: códigos (1 dia), links do QR (2 dias), sessões sem uso (90 dias), links de senha vencidos (30 dias). */
create function public.resident_bot_housekeeping() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a int; b int; c int; d int;
begin
  delete from public.resident_bot_codes where created_at < now() - interval '1 day'; get diagnostics a = row_count;
  delete from public.resident_bot_qr_links where created_at < now() - interval '2 days'; get diagnostics b = row_count;
  delete from public.resident_bot_sessions where updated_at < now() - interval '90 days'; get diagnostics c = row_count;
  delete from public.resident_password_links where coalesce(used_at, expires_at) < now() - interval '30 days'; get diagnostics d = row_count;
  return jsonb_build_object('codes', a, 'qr_links', b, 'sessions', c, 'password_links', d);
end $$;

revoke all on function public.resident_bot_resolve(uuid, text), public.resident_bot_save(uuid, text, jsonb),
  public.resident_bot_email_start(uuid, text, text), public.resident_bot_email_verify(uuid, text, text),
  public.resident_bot_account(uuid, text), public.resident_bot_account_bind(uuid, text, uuid),
  public.resident_bot_signup_info(uuid), public.resident_bot_signup(uuid, text, text, text, text, text, text),
  public.resident_bot_call(uuid, text, uuid, text, jsonb), public.resident_bot_qr_open(text),
  public.resident_password_link_peek(text), public.resident_password_link_use(text),
  public.resident_bot_housekeeping() from public, anon, authenticated;
grant execute on function public.resident_bot_resolve(uuid, text), public.resident_bot_save(uuid, text, jsonb),
  public.resident_bot_email_start(uuid, text, text), public.resident_bot_email_verify(uuid, text, text),
  public.resident_bot_account(uuid, text), public.resident_bot_account_bind(uuid, text, uuid),
  public.resident_bot_signup_info(uuid), public.resident_bot_signup(uuid, text, text, text, text, text, text),
  public.resident_bot_call(uuid, text, uuid, text, jsonb), public.resident_bot_qr_open(text),
  public.resident_password_link_peek(text), public.resident_password_link_use(text),
  public.resident_bot_housekeeping() to service_role;

-- -----------------------------------------------------------------------------
-- E-mail do código pela fila (evento novo; estende o CHECK vigente sem reescrever a lista)
-- -----------------------------------------------------------------------------
do $$ declare def text; begin
  select pg_get_constraintdef(oid) into def from pg_constraint
   where conrelid = 'public.notification_jobs'::regclass and conname = 'notification_jobs_event_check';
  if def is null then raise exception 'CHECK de eventos não encontrado'; end if;
  if position('resident_bot_code' in def) = 0 then
    alter table public.notification_jobs drop constraint notification_jobs_event_check;
    execute 'alter table public.notification_jobs add constraint notification_jobs_event_check CHECK (event = ''resident_bot_code'' OR (' || substr(def, 7) || '))';
  end if;
end $$;

/** Destinatário: o e-mail digitado para este código, código ainda válido. */
create function app.resident_bot_code_allowed(j public.notification_jobs) returns boolean
language sql stable security definer set search_path = '' as $$
  select j.channel = 'email' and exists (select 1 from public.resident_bot_codes c join public.tenants t on t.id = c.tenant_id and t.status = 'active'
    where c.id::text = j.ref_id and c.tenant_id = j.tenant_id and c.email = j.recipient and c.used_at is null and c.expires_at > now())
$$;
revoke all on function app.resident_bot_code_allowed(public.notification_jobs) from public, anon, authenticated;

do $$ declare src text; begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if position('resident_bot_code_allowed' in src) = 0 then
    src := regexp_replace(src, '(begin\s*\r?\n)', E'\\1  if j.event = ''resident_bot_code'' then return app.resident_bot_code_allowed(j); end if;\n');
    if position('resident_bot_code_allowed' in src) = 0 then raise exception 'Não foi possível encadear autorização do código'; end if;
    execute src;
  end if;
end $$;

-- Contexto: o código (só enquanto válido) e, nas boas-vindas de cadastro feito pelo WhatsApp, o link de senha.
alter function public.notification_context(uuid) rename to notification_context_before_bot;
alter function public.notification_context_before_bot(uuid) set schema app;
create function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := app.notification_context_before_bot(p_job); j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job;
  if j.event = 'resident_bot_code' then
    v := coalesce(v, '{}'::jsonb) || coalesce((select jsonb_build_object('bot_code', c.code) from public.resident_bot_codes c
      where c.id::text = j.ref_id and c.tenant_id = j.tenant_id and c.used_at is null and c.expires_at > now()), '{}'::jsonb);
  elsif j.event = 'access_decision' and coalesce(j.payload->>'approved', '') = 'true' then
    v := coalesce(v, '{}'::jsonb) || coalesce((select jsonb_build_object('password_link', jsonb_build_object('token', l.token, 'expires_at', l.expires_at))
      from public.resident_password_links l
      where l.request_id::text = j.ref_id and l.tenant_id = j.tenant_id and l.used_at is null and l.expires_at > now()
        and app.bot_resident_ok(l.tenant_id, l.user_id) and app.bot_password_eligible(l.user_id)), '{}'::jsonb);
  end if;
  return v;
end $$;
revoke all on function public.notification_context(uuid), app.notification_context_before_bot(uuid) from public, anon, authenticated;
grant execute on function public.notification_context(uuid), app.notification_context_before_bot(uuid) to service_role;
