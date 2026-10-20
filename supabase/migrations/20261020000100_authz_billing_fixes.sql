-- =============================================================================
-- PORTARIA PRIME — 1200: correções de autorização de convites e de cobrança
-- 1. Convite não delega permissão que o emissor não tem.
-- 2. Convite perde validade se o emissor perde o poder de convidar.
-- 3. Valor-base pago diferente do pedido vai para revisão.
-- 4. Checkout novo exige plano publicado e preço ativo.
-- 5. Tentativa de criar link no provedor é reservada (sem link duplicado / retry cego).
-- 6. Versão de preço é imutável; só se desativa e cria nova versão.
-- =============================================================================

-- Permissões atuais de um usuário no condomínio (vínculo admin ativo).
create or replace function app.user_permissions(p_tenant uuid, p_user uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.permissions from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant and m.user_id = p_user and m.role = 'admin'
      and m.status = 'active' and t.status = 'active'), null)
$$;

-- O emissor ainda pode conceder este convite?
create or replace function app.can_grant_invitation(p_tenant uuid, p_user uuid, p_role text, p_permissions text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when app.user_permissions(p_tenant, p_user) is null then false
    when p_role = 'morador' then 'approve' = any (app.user_permissions(p_tenant, p_user))
    else 'team' = any (app.user_permissions(p_tenant, p_user))
      and coalesce(p_permissions, '{}') <@ app.user_permissions(p_tenant, p_user)
  end
$$;

create or replace function public.create_invitation(
  p_tenant uuid, p_email text, p_role text, p_unit uuid default null, p_permissions text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_token text := app.random_token(); v_inv public.invitations; v_email text := lower(btrim(p_email));
begin
  if p_role not in ('admin', 'porteiro', 'morador') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
  if p_role <> 'admin' and coalesce(array_length(p_permissions, 1), 0) > 0 then
    raise exception 'Permissões só se aplicam a administradores.' using errcode = '22023';
  end if;
  if not app.can_grant_invitation(p_tenant, auth.uid(), p_role, p_permissions) then
    raise exception 'Sem permissão para conceder este acesso. Você só pode delegar permissões que possui.' using errcode = '42501';
  end if;
  if p_role = 'morador' then
    perform app.require(exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active), 'Unidade inválida.');
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;

  update public.invitations set revoked_at = now()
   where tenant_id = p_tenant and email = v_email and role = p_role and unit_id is not distinct from p_unit
     and accepted_at is null and revoked_at is null;

  insert into public.invitations (tenant_id, email, role, permissions, unit_id, token_hash, expires_at, created_by)
  values (p_tenant, v_email, p_role, coalesce(p_permissions, '{}'), case when p_role = 'morador' then p_unit end,
          app.sha256_hex(v_token), app.now() + interval '7 days', auth.uid())
  returning * into v_inv;
  perform app.audit(p_tenant, 'invitation.created', 'invitation', v_inv.id::text, jsonb_build_object('role', p_role));
  return jsonb_build_object('invitation_id', v_inv.id, 'token', v_token, 'expires_at', v_inv.expires_at);
end $$;

-- Aceite revalida o emissor no momento do uso (revogação vale para convites pendentes).
create or replace function public.accept_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invitations; v_uid uuid := auth.uid(); v_max int; v_count int; v_name text;
begin
  perform app.require(v_uid is not null, 'Faça login para aceitar o convite.');
  perform app.require(app.email_verified(), 'Confirme seu e-mail antes de aceitar o convite.');
  select * into v from public.invitations where token_hash = app.sha256_hex(coalesce(p_token, '')) for update;
  if not found or v.revoked_at is not null then raise exception 'Convite inválido ou revogado.' using errcode = 'P0001'; end if;
  if v.accepted_at is not null then raise exception 'Este convite já foi utilizado.' using errcode = 'P0001'; end if;
  if v.expires_at <= app.now() then raise exception 'Convite expirado. Peça um novo ao síndico.' using errcode = 'P0001'; end if;
  if v.email <> app.current_email() then
    raise exception 'Este convite foi enviado para outro e-mail. Entre com a conta de %.', v.email using errcode = '42501';
  end if;
  if v.created_by is null or not app.can_grant_invitation(v.tenant_id, v.created_by, v.role, v.permissions) then
    update public.invitations set revoked_at = now() where id = v.id;
    raise exception 'Convite revogado: quem o emitiu não tem mais permissão para conceder este acesso. Peça um novo convite.' using errcode = 'P0001';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
  values (v.tenant_id, v_uid, v.role, v.permissions, 'active')
  on conflict (tenant_id, user_id, role) do update set status = 'active', permissions = excluded.permissions, updated_at = now();

  if v.role = 'morador' then
    perform 1 from public.units where id = v.unit_id and tenant_id = v.tenant_id and active for update;
    if not found then raise exception 'A unidade deste convite não está mais ativa.' using errcode = 'P0001'; end if;
    select max_residents_per_unit into v_max from public.tenant_settings where tenant_id = v.tenant_id;
    select count(*) into v_count from public.unit_memberships
     where unit_id = v.unit_id and status = 'active' and user_id <> v_uid;
    if v_count >= coalesce(v_max, 10) then
      raise exception 'A unidade já atingiu o limite de % moradores.', v_max using errcode = 'P0001';
    end if;
    insert into public.unit_memberships (tenant_id, unit_id, user_id)
    values (v.tenant_id, v.unit_id, v_uid)
    on conflict (unit_id, user_id) do update set status = 'active';
    select coalesce(full_name, split_part(v.email, '@', 1)) into v_name from public.profiles where id = v_uid;
    if not exists (select 1 from public.resident_contacts where unit_id = v.unit_id and user_id = v_uid) then
      insert into public.resident_contacts (tenant_id, unit_id, user_id, name, email)
      values (v.tenant_id, v.unit_id, v_uid, coalesce(v_name, 'Morador'), v.email);
    end if;
  end if;

  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v.id;
  perform app.audit(v.tenant_id, 'invitation.accepted', 'invitation', v.id::text, jsonb_build_object('role', v.role));
  return jsonb_build_object('tenant_id', v.tenant_id, 'role', v.role,
    'slug', (select slug from public.tenants where id = v.tenant_id));
end $$;

-- Revogar/rebaixar administrador revoga os convites pendentes que ele emitiu.
create or replace function app.revoke_invitations_of_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'admin' and (new.status <> 'active' or not (new.permissions @> old.permissions)) then
    update public.invitations i set revoked_at = now()
     where i.tenant_id = new.tenant_id and i.created_by = new.user_id
       and i.accepted_at is null and i.revoked_at is null
       and not app.can_grant_invitation(i.tenant_id, i.created_by, i.role, i.permissions);
  end if;
  return new;
end $$;
create trigger membership_invitations_revoked after update of status, permissions on public.tenant_memberships
  for each row execute function app.revoke_invitations_of_member();

-- -----------------------------------------------------------------------------
-- Preço versionado imutável
-- -----------------------------------------------------------------------------
create or replace function app.plan_price_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.plan_id <> old.plan_id or new.cycle <> old.cycle or new.amount_cents <> old.amount_cents
     or new.currency <> old.currency or new.version <> old.version then
    raise exception 'Versão de preço é imutável. Crie uma nova versão em vez de alterar a existente.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger plan_prices_immutable before update on public.plan_prices
  for each row execute function app.plan_price_immutable();

-- -----------------------------------------------------------------------------
-- Checkout: plano publicado e reserva da criação do link
-- -----------------------------------------------------------------------------
alter table public.billing_orders
  add column link_state text not null default 'none' check (link_state in ('none', 'creating', 'ready', 'failed', 'ambiguous')),
  add column link_attempt_id uuid,
  add column link_attempt_at timestamptz;

create or replace function app.price_purchasable(p_price uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.plan_prices pr join public.plans p on p.id = pr.plan_id
    where pr.id = p_price and pr.active and p.published and not p.is_custom)
$$;

alter function public.prepare_checkout(uuid) rename to prepare_checkout_before_authz_fix;
create function public.prepare_checkout(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  perform app.require(app.has_perm(p_tenant, 'billing'), 'Somente quem gerencia o faturamento pode pagar a assinatura.');
  select * into s from public.subscriptions where tenant_id = p_tenant;
  -- Pedido já aberto é obrigação existente: mantém o snapshot mesmo que o catálogo mude.
  if not exists (select 1 from public.billing_orders where subscription_id = s.id and status in ('pending', 'link_failed'))
     and not app.price_purchasable(coalesce(s.next_price_id, s.price_id)) then
    raise exception 'O plano escolhido não está mais disponível. Escolha outro plano em Assinatura antes de pagar.' using errcode = 'P0001';
  end if;
  return public.prepare_checkout_before_authz_fix(p_tenant);
end $$;

-- Reserva: só uma tentativa de criar link por vez; resultado ambíguo (timeout)
-- não permite nova tentativa automática, porque o link pode já existir no provedor.
create or replace function public.claim_checkout_link(p_order uuid, p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.billing_orders;
begin
  select * into o from public.billing_orders where id = p_order for update;
  if not found or o.status not in ('pending', 'link_failed') then
    return jsonb_build_object('claimed', false, 'reason', 'not_open');
  end if;
  if o.link_state = 'ready' and o.checkout_url is not null then
    return jsonb_build_object('claimed', false, 'reason', 'ready', 'checkout_url', o.checkout_url);
  end if;
  if o.link_state = 'ambiguous' then
    return jsonb_build_object('claimed', false, 'reason', 'ambiguous');
  end if;
  if o.link_state = 'creating' and o.link_attempt_at > now() - interval '2 minutes' then
    return jsonb_build_object('claimed', false, 'reason', 'in_progress');
  end if;
  -- 'creating' antigo (função caiu no meio): o resultado é desconhecido.
  if o.link_state = 'creating' then
    update public.billing_orders set link_state = 'ambiguous', updated_at = now() where id = o.id;
    return jsonb_build_object('claimed', false, 'reason', 'ambiguous');
  end if;
  update public.billing_orders set link_state = 'creating', link_attempt_id = p_attempt, link_attempt_at = now(), updated_at = now()
   where id = o.id;
  return jsonb_build_object('claimed', true);
end $$;

create or replace function public.finish_checkout_link(p_order uuid, p_attempt uuid, p_url text, p_state text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_state not in ('ready', 'failed', 'ambiguous') then raise exception 'estado inválido' using errcode = '22023'; end if;
  if p_state = 'ready' and (p_url is null or p_url !~ '^https://') then raise exception 'URL inválida' using errcode = '22023'; end if;
  update public.billing_orders set link_state = p_state,
    checkout_url = case when p_state = 'ready' then p_url else checkout_url end,
    status = case when p_state = 'failed' then 'link_failed' else 'pending' end, updated_at = now()
   where id = p_order and link_attempt_id = p_attempt and link_state = 'creating';
  return found;
end $$;

-- Liberação manual de tentativa ambígua (superadmin, após conferir no painel da InfinitePay).
create or replace function public.admin_release_checkout_link(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  perform app.require(app.is_platform_admin());
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Justificativa obrigatória (mín. 10 caracteres).' using errcode = '22023'; end if;
  update public.billing_orders set link_state = 'none', link_attempt_id = null, updated_at = now()
   where id = p_order and link_state = 'ambiguous' returning tenant_id into v_tenant;
  if v_tenant is null then raise exception 'Pedido não está em estado ambíguo.' using errcode = 'P0001'; end if;
  perform app.audit(v_tenant, 'admin.checkout_link_released', 'billing_order', p_order::text, jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- -----------------------------------------------------------------------------
-- Valor-base: precisa ser igual ao pedido; paid_amount pode ser maior (encargos).
-- -----------------------------------------------------------------------------
alter function public.apply_verified_payment(text, text, text, int, int, int, text, text)
  rename to apply_verified_payment_before_authz_fix;
create function public.apply_verified_payment(
  p_order_nsu text, p_transaction_nsu text, p_slug text, p_amount int, p_paid_amount int,
  p_installments int, p_capture_method text, p_receipt_url text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.billing_orders;
begin
  select * into o from public.billing_orders where order_nsu = p_order_nsu for update;
  if found and o.status in ('pending', 'link_failed')
     and not exists (select 1 from public.payments where transaction_nsu = p_transaction_nsu)
     and (p_amount is distinct from o.amount_cents) then
    update public.billing_orders set status = 'review', review_reason = 'Valor-base divergente do pedido', updated_at = now() where id = o.id;
    insert into public.billing_incidents (tenant_id, order_id, kind, detail) values (o.tenant_id, o.id, 'amount_mismatch',
      jsonb_build_object('expected', o.amount_cents, 'amount', p_amount, 'paid_amount', p_paid_amount, 'transaction_nsu', p_transaction_nsu));
    return jsonb_build_object('result', 'review', 'reason', 'amount_mismatch');
  end if;
  return public.apply_verified_payment_before_authz_fix(p_order_nsu, p_transaction_nsu, p_slug, p_amount, p_paid_amount,
    p_installments, p_capture_method, p_receipt_url);
end $$;

-- -----------------------------------------------------------------------------
-- Privilégios
-- -----------------------------------------------------------------------------
revoke all on function app.user_permissions(uuid, uuid), app.can_grant_invitation(uuid, uuid, text, text[]),
  app.revoke_invitations_of_member(), app.plan_price_immutable(), app.price_purchasable(uuid) from public, anon, authenticated;
revoke all on function public.prepare_checkout_before_authz_fix(uuid),
  public.apply_verified_payment_before_authz_fix(text, text, text, int, int, int, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.create_invitation(uuid, text, text, uuid, text[]), public.accept_invitation(text),
  public.prepare_checkout(uuid), public.claim_checkout_link(uuid, uuid), public.finish_checkout_link(uuid, uuid, text, text),
  public.admin_release_checkout_link(uuid, text),
  public.apply_verified_payment(text, text, text, int, int, int, text, text) from public, anon, authenticated;
grant execute on function public.create_invitation(uuid, text, text, uuid, text[]), public.accept_invitation(text),
  public.prepare_checkout(uuid), public.admin_release_checkout_link(uuid, text) to authenticated, service_role;
grant execute on function public.claim_checkout_link(uuid, uuid), public.finish_checkout_link(uuid, uuid, text, text),
  public.apply_verified_payment(text, text, text, int, int, int, text, text) to service_role;
grant execute on all functions in schema app to service_role;
