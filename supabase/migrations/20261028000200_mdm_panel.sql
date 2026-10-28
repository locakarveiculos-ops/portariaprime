-- =============================================================================
-- Dispositivos e quiosque: RPCs do painel do síndico (permissão "settings").
-- Ações sensíveis (inscrição, manutenção, Wi-Fi, reinício, desativação, códigos de
-- recuperação, atribuição de política) exigem login recente (≤ 5 min) e MFA se cadastrado.
-- Tenant sempre derivado do registro no banco, nunca do cliente.
-- =============================================================================

-- Versões do agente publicadas pela plataforma (URL HTTPS + checksum da assinatura para o QR).
create table public.mdm_agent_releases (
  version_code int primary key check (version_code > 0),
  version_name text not null check (version_name ~ '^[0-9A-Za-z._+-]{1,40}$'),
  apk_url text not null check (apk_url ~ '^https://[^[:space:]]+$' and length(apk_url) between 16 and 400),
  signature_checksum text not null check (signature_checksum ~ '^[A-Za-z0-9_-]{43}=?$'),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index mdm_one_active_release on public.mdm_agent_releases (active) where active;
alter table public.mdm_agent_releases enable row level security;
revoke all on public.mdm_agent_releases from public, anon, authenticated;
grant all on public.mdm_agent_releases to service_role;

create function app.mdm_device_admin(p_device uuid) returns public.mdm_devices
language plpgsql stable security definer set search_path = '' as $$
declare d public.mdm_devices;
begin
  select * into d from public.mdm_devices where id = p_device;
  perform app.require(found and app.has_perm(d.tenant_id, 'settings'));
  return d;
end $$;

create function app.mdm_desired_version(p_device uuid) returns public.mdm_policy_versions
language sql stable security definer set search_path = '' as $$
  select v.* from public.mdm_assignments a join public.mdm_policy_versions v on v.id = a.policy_version_id where a.device_id = p_device
$$;

-- Política padrão do condomínio (criada e publicada na primeira vez).
create function app.mdm_default_version(p_tenant uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p uuid; v uuid;
begin
  select id into p from public.mdm_policies where tenant_id = p_tenant and name = 'Portaria (Single-App)';
  if p is null then
    insert into public.mdm_policies (tenant_id, name, created_by) values (p_tenant, 'Portaria (Single-App)', auth.uid()) returning id into p;
    insert into public.mdm_policy_versions (tenant_id, policy_id, version, config, published_at, created_by)
    values (p_tenant, p, 1, app.mdm_policy_config(app.mdm_default_config() || '{"sync_interval_seconds":120}'), app.now(), auth.uid());
  end if;
  select id into v from public.mdm_policy_versions where policy_id = p and published_at is not null order by version desc limit 1;
  return v;
end $$;

create function app.mdm_device_json(d public.mdm_devices) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'name', d.name, 'purpose', d.purpose, 'state', app.mdm_display_state(d),
    'raw_state', d.state, 'management', d.management, 'manufacturer', d.manufacturer, 'model', d.model,
    'android_release', d.android_release, 'sdk_int', d.sdk_int, 'agent_version', d.agent_version,
    'battery_pct', d.battery_pct, 'charging', d.charging, 'last_seen_at', d.last_seen_at, 'last_error', d.last_error,
    'concierge_location_id', d.concierge_location_id,
    'concierge_name', (select name from public.concierge_locations c where c.id = d.concierge_location_id),
    'desired_version_id', (select policy_version_id from public.mdm_assignments a where a.device_id = d.id),
    'applied_version_id', d.applied_policy_version_id,
    'compliant', d.state in ('provisioned', 'active') and d.management = 'device_owner' and d.applied_policy_version_id is not distinct from
      (select policy_version_id from public.mdm_assignments a where a.device_id = d.id)
      and coalesce(jsonb_array_length(d.report->'failed_restrictions'), 0) = 0,
    'created_at', d.created_at)
$$;

create function public.mdm_overview(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings'));
  return jsonb_build_object(
    'devices', coalesce((select jsonb_agg(app.mdm_device_json(d) order by d.created_at desc) from public.mdm_devices d where d.tenant_id = p_tenant), '[]'),
    'policies', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'versions',
        (select jsonb_agg(jsonb_build_object('id', v.id, 'version', v.version, 'config', v.config, 'published_at', v.published_at,
           'devices', (select count(*) from public.mdm_assignments a where a.policy_version_id = v.id),
           'applied', (select count(*) from public.mdm_devices d where d.applied_policy_version_id = v.id)) order by v.version desc)
         from public.mdm_policy_versions v where v.policy_id = p.id)) order by p.created_at)
      from public.mdm_policies p where p.tenant_id = p_tenant), '[]'),
    'catalog', coalesce((select jsonb_agg(jsonb_build_object('package_name', c.package_name, 'label', c.label, 'min_version_code', c.min_version_code, 'notes', c.notes) order by c.label)
      from public.mdm_app_catalog c where c.active), '[]'),
    'concierges', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by created_at) from public.concierge_locations where tenant_id = p_tenant and active), '[]'),
    'release', (select jsonb_build_object('version_code', version_code, 'version_name', version_name, 'apk_url', apk_url, 'signature_checksum', signature_checksum)
      from public.mdm_agent_releases where active));
end $$;

create function public.mdm_device_detail(p_device uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_device_admin(p_device); want public.mdm_policy_versions := app.mdm_desired_version(p_device);
begin
  return app.mdm_device_json(d) || jsonb_build_object(
    'desired', case when want.id is null then null else jsonb_build_object('id', want.id, 'version', want.version, 'config', want.config,
      'policy', (select name from public.mdm_policies where id = want.policy_id)) end,
    'applied', (select jsonb_build_object('id', v.id, 'version', v.version, 'config', v.config, 'policy', p.name)
      from public.mdm_policy_versions v join public.mdm_policies p on p.id = v.policy_id where v.id = d.applied_policy_version_id),
    'report', d.report,
    'commands', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'seq', c.seq, 'action', c.action, 'params', c.params, 'status', c.status,
        'detail', c.detail, 'created_at', c.created_at, 'expires_at', c.expires_at, 'updated_at', c.updated_at) order by c.seq desc)
      from (select * from public.mdm_commands where device_id = d.id order by seq desc limit 30) c), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'source', e.source, 'data', e.data, 'created_at', e.created_at) order by e.id desc)
      from (select * from public.mdm_audit_events where device_id = d.id order by id desc limit 50) e), '[]'),
    'maintenance', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'method', m.method, 'scope', m.scope, 'reason', m.reason,
        'started_at', m.started_at, 'expires_at', m.expires_at, 'ended_at', m.ended_at, 'end_reason', m.end_reason) order by m.started_at desc)
      from (select * from public.mdm_maintenance_sessions where device_id = d.id order by started_at desc limit 10) m), '[]'),
    'recovery', jsonb_build_object('version', d.recovery_version,
      'total', (select count(*) from public.mdm_recovery_codes r where r.device_id = d.id and r.version = d.recovery_version),
      'remaining', (select count(*) from public.mdm_recovery_codes r where r.device_id = d.id and r.version = d.recovery_version and r.used_at is null)),
    'enrollment_pending', exists (select 1 from public.mdm_enrollment_tokens t where t.device_id = d.id and t.consumed_at is null
      and t.revoked_at is null and t.expires_at > app.now()));
end $$;

create function public.mdm_device_create(p_tenant uuid, p_name text, p_purpose text default 'portaria', p_concierge uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.require(app.has_perm(p_tenant, 'settings'));
  perform app.require(app.can_operate(p_tenant), 'Condomínio sem acesso ativo. Regularize o plano para cadastrar aparelhos.');
  -- ponytail: teto fixo por condomínio; vira franquia do plano se houver cobrança por aparelho.
  if (select count(*) from public.mdm_devices where tenant_id = p_tenant and state <> 'deactivated') >= 20 then
    raise exception 'Limite de 20 aparelhos gerenciados por condomínio.' using errcode = 'P0001';
  end if;
  if p_concierge is not null and not exists (select 1 from public.concierge_locations where tenant_id = p_tenant and id = p_concierge and active) then
    raise exception 'Portaria inválida.' using errcode = '22023';
  end if;
  insert into public.mdm_devices (tenant_id, name, purpose, concierge_location_id, created_by)
  values (p_tenant, btrim(p_name), coalesce(p_purpose, 'portaria'), coalesce(p_concierge, app.default_concierge(p_tenant)), auth.uid())
  returning id into v_id;
  insert into public.mdm_assignments (device_id, tenant_id, policy_version_id, assigned_by)
  values (v_id, p_tenant, app.mdm_default_version(p_tenant), auth.uid());
  perform app.mdm_event(p_tenant, v_id, 'painel', 'device.created', jsonb_build_object('name', btrim(p_name)));
  return jsonb_build_object('device_id', v_id);
end $$;

-- Token de inscrição: uso único, curto, vinculado a este aparelho. Texto devolvido uma única vez.
create function public.mdm_enrollment_create(p_device uuid, p_minutes int default 60) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_device_admin(p_device); v_token text; v_exp timestamptz;
begin
  perform app.mdm_require_recent_auth();
  if d.state in ('deactivated', 'deactivation_pending') then raise exception 'Aparelho desativado. Cadastre um novo.' using errcode = 'P0001'; end if;
  if p_minutes not between 10 and 120 then raise exception 'Validade entre 10 e 120 minutos.' using errcode = '22023'; end if;
  update public.mdm_enrollment_tokens set revoked_at = app.now() where device_id = d.id and consumed_at is null and revoked_at is null;
  v_token := upper(substr(app.random_token(), 1, 24));
  v_exp := app.now() + make_interval(mins => p_minutes);
  insert into public.mdm_enrollment_tokens (tenant_id, device_id, token_hash, expires_at, created_by)
  values (d.tenant_id, d.id, app.sha256_hex(v_token), v_exp, auth.uid());
  perform app.mdm_event(d.tenant_id, d.id, 'painel', 'enrollment.created', jsonb_build_object('expires_at', v_exp));
  return jsonb_build_object('token', v_token, 'expires_at', v_exp,
    'tenant_slug', (select slug from public.tenants where id = d.tenant_id));
end $$;

-- Nova versão (rascunho) validada; publicar é passo separado.
create function public.mdm_policy_save(p_tenant uuid, p_policy uuid, p_name text, p_config jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_policy uuid := p_policy; v_cfg jsonb; v_ver int; v_id uuid;
begin
  perform app.require(app.has_perm(p_tenant, 'settings'));
  v_cfg := app.mdm_policy_config(p_config);
  if v_policy is null then
    insert into public.mdm_policies (tenant_id, name, created_by) values (p_tenant, btrim(p_name), auth.uid()) returning id into v_policy;
  else
    perform app.require(exists (select 1 from public.mdm_policies where id = v_policy and tenant_id = p_tenant));
  end if;
  select coalesce(max(version), 0) + 1 into v_ver from public.mdm_policy_versions where policy_id = v_policy;
  insert into public.mdm_policy_versions (tenant_id, policy_id, version, config, created_by)
  values (p_tenant, v_policy, v_ver, v_cfg, auth.uid()) returning id into v_id;
  perform app.mdm_event(p_tenant, null, 'painel', 'policy.saved', jsonb_build_object('policy_id', v_policy, 'version', v_ver));
  return jsonb_build_object('policy_id', v_policy, 'version_id', v_id, 'version', v_ver, 'config', v_cfg);
end $$;

create function public.mdm_policy_publish(p_version uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.mdm_policy_versions;
begin
  select * into v from public.mdm_policy_versions where id = p_version;
  perform app.require(found and app.has_perm(v.tenant_id, 'settings'));
  perform app.mdm_policy_config(v.config);  -- revalida (catálogo pode ter mudado)
  update public.mdm_policy_versions set published_at = coalesce(published_at, app.now()) where id = v.id;
  perform app.mdm_event(v.tenant_id, null, 'painel', 'policy.published', jsonb_build_object('version_id', v.id, 'version', v.version));
end $$;

-- Atribuição: só versão publicada; lote exige piloto aplicado com sucesso em um aparelho.
create function public.mdm_assign(p_devices uuid[], p_version uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v public.mdm_policy_versions; n int;
begin
  select * into v from public.mdm_policy_versions where id = p_version;
  perform app.require(found and app.has_perm(v.tenant_id, 'settings'));
  perform app.mdm_require_recent_auth();
  if v.published_at is null then raise exception 'Publique a versão antes de atribuir.' using errcode = 'P0001'; end if;
  if coalesce(cardinality(p_devices), 0) = 0 then raise exception 'Escolha ao menos um aparelho.' using errcode = '22023'; end if;
  if exists (select 1 from unnest(p_devices) x where not exists (
      select 1 from public.mdm_devices d where d.id = x and d.tenant_id = v.tenant_id and d.state not in ('deactivated', 'deactivation_pending'))) then
    raise exception 'Aparelho inválido para este condomínio.' using errcode = '42501';
  end if;
  if cardinality(p_devices) > 1 and not exists (select 1 from public.mdm_devices d where d.applied_policy_version_id = v.id) then
    raise exception 'Aplique primeiro em um aparelho piloto e confirme o resultado antes do lote.' using errcode = 'P0001';
  end if;
  insert into public.mdm_assignments (device_id, tenant_id, policy_version_id, assigned_by, assigned_at)
  select x, v.tenant_id, v.id, auth.uid(), app.now() from unnest(p_devices) x
  on conflict (device_id) do update set policy_version_id = excluded.policy_version_id, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at;
  get diagnostics n = row_count;
  insert into public.mdm_audit_events (tenant_id, device_id, actor_id, source, event, data, created_at)
  select v.tenant_id, x, auth.uid(), 'painel', 'policy.assigned', jsonb_build_object('version_id', v.id, 'version', v.version), app.now() from unnest(p_devices) x;
  return n;
end $$;

-- Comandos enumerados. Parâmetros validados aqui; o aparelho revalida.
create function public.mdm_command_create(p_device uuid, p_action text, p_params jsonb, p_idempotency_key text, p_secret text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_device_admin(p_device); c public.mdm_commands; v_params jsonb := '{}'; v_ttl interval := interval '24 hours';
  v_max int; v_min int; v_seq bigint; v_session uuid;
begin
  select * into c from public.mdm_commands where tenant_id = d.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if c.device_id <> d.id or c.action <> p_action then raise exception 'Chave de idempotência já usada em outro comando.' using errcode = '22023'; end if;
    return jsonb_build_object('id', c.id, 'seq', c.seq, 'status', c.status, 'replayed', true);
  end if;
  if p_action <> 'sync_policy' then perform app.mdm_require_recent_auth(); end if;
  if d.state in ('pending', 'deactivated') then raise exception 'O aparelho ainda não foi inscrito ou já foi desativado.' using errcode = 'P0001'; end if;
  if d.state = 'deactivation_pending' then raise exception 'Desativação em andamento: aguarde a confirmação do aparelho.' using errcode = 'P0001'; end if;

  case p_action
  when 'sync_policy' then null;
  when 'start_maintenance' then
    select coalesce((v.config->>'maintenance_max_minutes')::int, 30) into v_max from public.mdm_assignments a
      join public.mdm_policy_versions v on v.id = a.policy_version_id where a.device_id = d.id;
    v_min := case when (p_params->>'minutes') ~ '^\d{1,3}$' then (p_params->>'minutes')::int end;
    if v_min is null or v_min < 5 or v_min > coalesce(v_max, 30) then
      raise exception 'Duração entre 5 e % minutos.', coalesce(v_max, 30) using errcode = '22023';
    end if;
    if coalesce(p_params->>'scope', '') not in ('settings', 'wifi', 'apps') then raise exception 'Escopo inválido.' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_params->>'reason', ''))) not between 3 and 200 then raise exception 'Informe o motivo (3 a 200 caracteres).' using errcode = '22023'; end if;
    v_params := jsonb_build_object('minutes', v_min, 'scope', p_params->>'scope', 'reason', btrim(p_params->>'reason'));
    v_ttl := interval '10 minutes';  -- comando de desbloqueio velho não vale após reconexão
  when 'end_maintenance' then null;
  when 'reboot' then v_ttl := interval '15 minutes';
  when 'wifi_apply' then
    if length(coalesce(p_params->>'ssid', '')) not between 1 and 32 then raise exception 'Nome da rede (SSID) inválido.' using errcode = '22023'; end if;
    if coalesce(p_params->>'security', '') not in ('open', 'wpa2', 'wpa3') then raise exception 'Segurança deve ser aberta, WPA2 ou WPA3.' using errcode = '22023'; end if;
    if p_params->>'security' <> 'open' and length(coalesce(p_secret, '')) not between 8 and 63 then
      raise exception 'Senha do Wi-Fi entre 8 e 63 caracteres.' using errcode = '22023';
    end if;
    v_params := jsonb_build_object('ssid', p_params->>'ssid', 'security', p_params->>'security', 'hidden', coalesce((p_params->>'hidden')::boolean, false));
    v_ttl := interval '30 minutes';
  when 'deactivate' then
    v_ttl := interval '30 days';
  else raise exception 'Ação desconhecida.' using errcode = '22023';
  end case;

  -- Um único comando do mesmo tipo pendente por vez (exceto sync, que é idempotente por natureza).
  update public.mdm_commands set status = 'cancelled', updated_at = app.now(), secret_params = null
   where device_id = d.id and action = p_action and status = 'pending';
  select coalesce(max(seq), 0) + 1 into v_seq from public.mdm_commands where device_id = d.id;
  insert into public.mdm_commands (tenant_id, device_id, seq, action, params, secret_params, idempotency_key, created_by, created_at, expires_at, updated_at)
  values (d.tenant_id, d.id, v_seq, p_action, v_params,
          case when p_action = 'wifi_apply' and p_secret is not null then jsonb_build_object('password', p_secret) end,
          p_idempotency_key, auth.uid(), app.now(), app.now() + v_ttl, app.now())
  returning * into c;
  if p_action = 'start_maintenance' then
    insert into public.mdm_maintenance_sessions (tenant_id, device_id, method, scope, reason, command_id, authorized_by, started_at, expires_at)
    values (d.tenant_id, d.id, 'remote', v_params->>'scope', v_params->>'reason', c.id, auth.uid(), app.now(), app.now() + make_interval(mins => v_min + 10))
    returning id into v_session;
    update public.mdm_commands set params = params || jsonb_build_object('session_id', v_session) where id = c.id;
  elsif p_action = 'deactivate' then
    update public.mdm_devices set state = 'deactivation_pending' where id = d.id;
  end if;
  perform app.mdm_event(d.tenant_id, d.id, 'painel', 'command.' || p_action, v_params - 'reason' || jsonb_build_object('seq', v_seq));
  return jsonb_build_object('id', c.id, 'seq', c.seq, 'status', c.status, 'expires_at', c.expires_at, 'replayed', false);
end $$;

-- Códigos de recuperação offline: gerados no navegador do síndico; aqui só chegam sal + PBKDF2.
create function public.mdm_recovery_set(p_device uuid, p_codes jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_device_admin(p_device); v_ver int; n int;
begin
  perform app.mdm_require_recent_auth();
  if jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) not between 5 and 20 then
    raise exception 'Envie de 5 a 20 códigos.' using errcode = '22023';
  end if;
  v_ver := d.recovery_version + 1;
  insert into public.mdm_recovery_codes (device_id, tenant_id, version, idx, salt, hash, iterations)
  select d.id, d.tenant_id, v_ver, (o - 1)::int, e->>'salt', e->>'hash', (e->>'iterations')::int
    from jsonb_array_elements(p_codes) with ordinality as x(e, o);
  get diagnostics n = row_count;
  update public.mdm_devices set recovery_version = v_ver where id = d.id;
  perform app.mdm_event(d.tenant_id, d.id, 'painel', 'recovery.generated', jsonb_build_object('version', v_ver, 'count', n));
  return v_ver;
exception when check_violation or invalid_text_representation or not_null_violation then
  raise exception 'Códigos de recuperação em formato inválido.' using errcode = '22023';
end $$;

-- Desativação sem ACK (aparelho perdido, resetado ou quebrado): o síndico declara a liberação
-- local verificada. Revoga a credencial; nada é apagado (auditoria preservada).
create function public.mdm_deactivation_confirm_local(p_device uuid, p_statement text) returns void
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_device_admin(p_device);
begin
  perform app.mdm_require_recent_auth();
  if d.state <> 'deactivation_pending' then raise exception 'Inicie a desativação supervisionada antes.' using errcode = 'P0001'; end if;
  if length(btrim(coalesce(p_statement, ''))) not between 10 and 300 then
    raise exception 'Descreva como o aparelho foi liberado (10 a 300 caracteres).' using errcode = '22023';
  end if;
  update public.mdm_devices set state = 'deactivated', deactivated_at = app.now(), management = 'unknown' where id = d.id;
  update public.mdm_device_credentials set status = 'revoked', revoked_at = app.now() where device_id = d.id and status = 'active';
  update public.mdm_commands set status = 'cancelled', updated_at = app.now(), secret_params = null where device_id = d.id and status in ('pending', 'received', 'applying');
  update public.mdm_maintenance_sessions set ended_at = app.now(), end_reason = 'deactivated' where device_id = d.id and ended_at is null;
  perform app.mdm_event(d.tenant_id, d.id, 'painel', 'deactivation.confirmed_local', jsonb_build_object('statement', btrim(p_statement)));
end $$;

revoke all on function app.mdm_device_admin(uuid), app.mdm_desired_version(uuid), app.mdm_default_version(uuid), app.mdm_device_json(public.mdm_devices)
  from public, anon, authenticated;
revoke all on function public.mdm_overview(uuid), public.mdm_device_detail(uuid), public.mdm_device_create(uuid, text, text, uuid),
  public.mdm_enrollment_create(uuid, int), public.mdm_policy_save(uuid, uuid, text, jsonb), public.mdm_policy_publish(uuid),
  public.mdm_assign(uuid[], uuid), public.mdm_command_create(uuid, text, jsonb, text, text), public.mdm_recovery_set(uuid, jsonb),
  public.mdm_deactivation_confirm_local(uuid, text) from public, anon;
grant execute on function public.mdm_overview(uuid), public.mdm_device_detail(uuid), public.mdm_device_create(uuid, text, text, uuid),
  public.mdm_enrollment_create(uuid, int), public.mdm_policy_save(uuid, uuid, text, jsonb), public.mdm_policy_publish(uuid),
  public.mdm_assign(uuid[], uuid), public.mdm_command_create(uuid, text, jsonb, text, text), public.mdm_recovery_set(uuid, jsonb),
  public.mdm_deactivation_confirm_local(uuid, text) to authenticated, service_role;
