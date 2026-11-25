-- =============================================================================
-- Correção do pré-cadastro pelo WhatsApp (produção, 25/11/2026).
-- Causa: o Supabase Auth grava um hash de senha aleatória mesmo quando a conta é criada sem senha. A regra
-- "encrypted_password vazio" recusava a própria conta criada pelo bot ("Não foi possível concluir").
-- Agora uma conta é "criada pelo bot e ainda sem senha escolhida" quando:
--   * tem app_metadata.resident_bot_provisioned = true (só o servidor grava app_metadata);
--   * nunca entrou no app (last_sign_in_at nulo);
--   * o hash de senha continua o mesmo de quando o bot a vinculou (ninguém definiu senha depois).
-- O vínculo exige e-mail confirmado por código nesta conversa há até 2 h. Conta comum (sem o marcador) nunca é elegível.
-- Mesmas assinaturas e grants (create or replace). Aditiva.
-- =============================================================================

alter table public.resident_bot_accounts add column if not exists initial_password_hash text;

-- plpgsql (validado só na execução): encrypted_password/raw_app_meta_data/last_sign_in_at são colunas do GoTrue.
create or replace function app.bot_password_eligible(p_user uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return exists (
    select 1 from public.resident_bot_accounts a
      join auth.users u on u.id = a.user_id and lower(u.email) = a.email
     where a.user_id = p_user
       and u.email_confirmed_at is not null
       and u.last_sign_in_at is null
       and u.encrypted_password is not distinct from a.initial_password_hash
       and coalesce((u.raw_app_meta_data->>'resident_bot_provisioned')::boolean, false));
end $$;

/** E-mail confirmado há até 2 h e a conta dele. bot_provisioned: conta criada pelo bot que ninguém usou ainda. */
create or replace function public.resident_bot_account(p_tenant uuid, p_who text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.resident_bot_sessions; u auth.users;
begin
  select * into s from public.resident_bot_sessions where tenant_id = p_tenant and who = app.bot_who(p_who);
  if not found or s.email is null or s.verified_at is null or s.verified_at < now() - interval '2 hours' then
    raise exception 'Confirme seu e-mail de novo para enviar o cadastro.' using errcode = '42501';
  end if;
  select * into u from auth.users where lower(email) = s.email limit 1;
  return jsonb_build_object('email', s.email, 'user_id', u.id, 'confirmed', u.email_confirmed_at is not null,
    'bot_provisioned', u.id is not null and u.last_sign_in_at is null
      and coalesce((u.raw_app_meta_data->>'resident_bot_provisioned')::boolean, false));
end $$;

/**
 * Vincula a conta criada pelo bot à conversa que confirmou o MESMO e-mail por código há até 2 h e guarda o hash de
 * senha atual (aleatório, desconhecido). Nunca aceita conta sem o marcador do servidor ou que já entrou no app.
 */
create or replace function public.resident_bot_account_bind(p_tenant uuid, p_who text, p_user uuid) returns jsonb
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
  if not found or u.email_confirmed_at is null or u.last_sign_in_at is not null
     or not coalesce((u.raw_app_meta_data->>'resident_bot_provisioned')::boolean, false) then
    raise exception 'Conta não elegível para provisionamento pelo WhatsApp.' using errcode = '42501';
  end if;
  insert into public.resident_bot_accounts (user_id, tenant_id, who, email, initial_password_hash)
  values (u.id, p_tenant, s.who, s.email, u.encrypted_password)
  on conflict (user_id) do update set tenant_id = excluded.tenant_id, who = excluded.who
   where public.resident_bot_accounts.email = excluded.email
     and public.resident_bot_accounts.initial_password_hash is not distinct from excluded.initial_password_hash;
  if not found then
    raise exception 'Conta não elegível para provisionamento pelo WhatsApp.' using errcode = '42501';
  end if;
  update public.resident_bot_sessions set user_id = u.id, updated_at = now()
   where tenant_id = s.tenant_id and who = s.who;
  perform app.audit(p_tenant, 'resident_bot.account_bound', 'user', u.id::text, jsonb_build_object('who', s.who));
  return jsonb_build_object('email', s.email, 'user_id', u.id, 'confirmed', true);
end $$;
