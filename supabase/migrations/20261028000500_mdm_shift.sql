-- =============================================================================
-- Troca de turno auditada no quiosque: operador (JWT), aparelho e condomínio (resolvidos
-- pelo servidor a partir de um nonce do aparelho) e horário do servidor.
--  * O nonce é emitido ao agente no sync autenticado (assinatura do Keystore) e entregue à
--    página no fragmento da URL inicial (#ppk=...). Sem bridge JavaScript.
--  * Rotação a cada 24 h; o anterior vale mais 24 h (sessões longas sem recarregar a página).
--  * O nonce só permite registrar início/fim de turno de quem JÁ é equipe ativa daquele
--    condomínio; não concede acesso a nada. Fica em coluna sem grant para clientes.
-- =============================================================================

alter table public.mdm_devices
  add column shift_nonce text check (shift_nonce is null or shift_nonce ~ '^[0-9a-f]{64}$'),
  add column shift_nonce_prev text check (shift_nonce_prev is null or shift_nonce_prev ~ '^[0-9a-f]{64}$'),
  add column shift_nonce_at timestamptz;

-- Somente service_role (chamado pela API logo após um sync assinado e aceito).
create function public.mdm_shift_nonce(p_device uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices;
begin
  select * into d from public.mdm_devices where id = p_device and state in ('provisioned', 'active') for update;
  if not found then return null; end if;
  if d.shift_nonce is null or d.shift_nonce_at < app.now() - interval '24 hours' then
    -- app.random_token() = 64 hex (dois UUID v4 sem hífen).
    update public.mdm_devices set shift_nonce_prev = shift_nonce, shift_nonce = app.random_token(), shift_nonce_at = app.now()
     where id = d.id returning * into d;
  end if;
  return d.shift_nonce;
end $$;

create function public.mdm_shift_event(p_nonce text, p_event text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices; v_role text; last_ev public.mdm_audit_events;
begin
  if auth.uid() is null or p_event not in ('shift.start', 'shift.end') or coalesce(p_nonce, '') !~ '^[0-9a-f]{64}$' then return false; end if;
  select * into d from public.mdm_devices
   where state in ('provisioned', 'active')
     and ((shift_nonce = p_nonce and shift_nonce_at > app.now() - interval '48 hours')
       or (shift_nonce_prev = p_nonce and shift_nonce_at > app.now() - interval '24 hours'));
  if not found then return false; end if;
  -- Só equipe ativa DESTE condomínio (morador ou outro condomínio: nada registrado).
  select role into v_role from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
   where m.tenant_id = d.tenant_id and m.user_id = auth.uid() and m.status = 'active' and t.status = 'active' and m.role in ('admin', 'porteiro')
   order by case m.role when 'porteiro' then 0 else 1 end limit 1;
  if v_role is null then return false; end if;
  -- Evita duplicar início de turno ao recarregar a página.
  select * into last_ev from public.mdm_audit_events where device_id = d.id and event like 'shift.%' order by id desc limit 1;
  if p_event = 'shift.start' and last_ev.event = 'shift.start' and last_ev.actor_id = auth.uid() then return true; end if;
  perform app.mdm_event(d.tenant_id, d.id, 'aparelho', p_event, jsonb_build_object('role', v_role));
  return true;
end $$;

revoke all on function public.mdm_shift_nonce(uuid), public.mdm_shift_event(text, text) from public, anon, authenticated;
grant execute on function public.mdm_shift_nonce(uuid) to service_role;
grant execute on function public.mdm_shift_event(text, text) to authenticated, service_role;
