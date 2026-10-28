-- =============================================================================
-- Canal do agente Android (somente service_role, via /api/totem/kiosk-*).
-- A API verifica a assinatura ECDSA (chave do Keystore) ANTES de chamar estas RPCs;
-- aqui o contador estritamente crescente impede replay e corrida entre requisições.
-- Credencial revogada não lê política nem comandos (mas o aparelho mantém o caminho
-- local de recuperação: códigos offline e procedimento institucional).
-- =============================================================================

create function public.mdm_agent_enroll(p_token_hash text, p_agent_id text, p_public_key text, p_info jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.mdm_enrollment_tokens; d public.mdm_devices;
begin
  select * into t from public.mdm_enrollment_tokens where token_hash = p_token_hash for update;
  if not found or t.revoked_at is not null or t.consumed_at is not null or t.expires_at <= app.now() then
    if found then perform app.mdm_event(t.tenant_id, t.device_id, 'aparelho', 'enrollment.rejected',
      jsonb_build_object('reason', case when t.consumed_at is not null then 'reutilizado' when t.revoked_at is not null then 'revogado' else 'expirado' end)); end if;
    -- Sem exceção: o evento de tentativa rejeitada precisa persistir (a API responde 409).
    return jsonb_build_object('error', 'Código de inscrição inválido, expirado ou já usado. Gere outro no painel.');
  end if;
  select * into d from public.mdm_devices where id = t.device_id for update;
  if d.state in ('deactivated', 'deactivation_pending') then raise exception 'Aparelho desativado no painel.' using errcode = 'P0001'; end if;
  if not app.can_operate(d.tenant_id) then raise exception 'Condomínio sem acesso ativo.' using errcode = '42501'; end if;
  update public.mdm_enrollment_tokens set consumed_at = app.now() where id = t.id;
  update public.mdm_device_credentials set status = 'revoked', revoked_at = app.now() where device_id = d.id and status = 'active';
  insert into public.mdm_device_credentials (tenant_id, device_id, public_key) values (d.tenant_id, d.id, p_public_key);
  update public.mdm_devices set agent_id = p_agent_id,
    state = case when p_info->>'managed' = 'true' then 'provisioned' else 'failed' end,
    management = case when p_info->>'managed' = 'true' then 'device_owner' else 'unmanaged' end,
    last_error = case when p_info->>'managed' = 'true' then null else 'Aplicativo sem Device Owner: quiosque não está protegido.' end,
    manufacturer = left(p_info->>'manufacturer', 60), model = left(p_info->>'model', 60),
    android_release = left(p_info->>'release', 20),
    sdk_int = case when (p_info->>'sdk') ~ '^\d{2}$' then (p_info->>'sdk')::int end,
    agent_version = case when (p_info->>'agent_version') ~ '^[A-Za-z0-9._+-]{1,40}$' then p_info->>'agent_version' end,
    last_seen_at = app.now(), last_seq = 0
  where id = d.id;
  perform app.mdm_event(d.tenant_id, d.id, 'aparelho', 'enrollment.consumed',
    jsonb_build_object('managed', p_info->>'managed' = 'true', 'model', left(p_info->>'model', 60), 'sdk', p_info->>'sdk'));
  return jsonb_build_object('device_id', d.id, 'device_name', d.name,
    'tenant_slug', (select slug from public.tenants where id = d.tenant_id));
end $$;

-- Chave pública para a API verificar a assinatura.
create function public.mdm_agent_key(p_device uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('public_key', c.public_key, 'last_counter', c.last_counter, 'state', d.state)
    from public.mdm_device_credentials c join public.mdm_devices d on d.id = c.device_id
   where c.device_id = p_device and c.status = 'active'
$$;

-- Consome o contador (anti-replay). Devolve o aparelho travado para a transação.
create function app.mdm_agent_auth(p_device uuid, p_counter bigint) returns public.mdm_devices
language plpgsql security definer set search_path = '' as $$
declare c public.mdm_device_credentials; d public.mdm_devices;
begin
  select * into c from public.mdm_device_credentials where device_id = p_device and status = 'active' for update;
  if not found then raise exception 'Credencial do aparelho revogada ou inexistente.' using errcode = '42501'; end if;
  if p_counter is null or p_counter <= c.last_counter then raise exception 'Requisição repetida ou fora de ordem.' using errcode = '42501'; end if;
  update public.mdm_device_credentials set last_counter = p_counter where id = c.id;
  select * into d from public.mdm_devices where id = p_device for update;
  return d;
end $$;

create function app.mdm_expire_commands(p_device uuid) returns void
language sql security definer set search_path = '' as $$
  with x as (
    update public.mdm_commands set status = 'expired', updated_at = app.now(), secret_params = null
     where device_id = p_device and status in ('pending', 'received') and expires_at <= app.now()
    returning id)
  insert into public.mdm_command_results (command_id, status, detail, reported_at) select id, 'expired', 'Expirou sem confirmação do aparelho.', app.now() from x
$$;

create function public.mdm_agent_sync(p_device uuid, p_counter bigint, p_report jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_agent_auth(p_device, p_counter); want public.mdm_policy_versions := app.mdm_desired_version(p_device);
  v_applied uuid; v_apps jsonb; v_failed jsonb;
begin
  perform app.mdm_expire_commands(d.id);
  v_applied := case when (p_report->>'applied_version_id') ~ '^[0-9a-f-]{36}$' then (p_report->>'applied_version_id')::uuid end;
  if v_applied is not null and not exists (select 1 from public.mdm_policy_versions where id = v_applied and tenant_id = d.tenant_id) then v_applied := null; end if;
  -- Inventário só de pacotes do catálogo (sem listar apps pessoais).
  select coalesce(jsonb_agg(jsonb_build_object('package_name', e->>'package_name', 'version_code', (e->>'version_code')::bigint)), '[]') into v_apps
    from jsonb_array_elements(case when jsonb_typeof(p_report->'apps') = 'array' then p_report->'apps' else '[]' end) e
   where exists (select 1 from public.mdm_app_catalog c where c.package_name = e->>'package_name') and (e->>'version_code') ~ '^\d{1,15}$';
  select coalesce(jsonb_agg(x), '[]') into v_failed
    from jsonb_array_elements_text(case when jsonb_typeof(p_report->'failed_restrictions') = 'array' then p_report->'failed_restrictions' else '[]' end) x
   where x = any (app.mdm_restriction_keys() || array['lock_task', 'status_bar', 'system_update', 'keyguard']);
  update public.mdm_devices set last_seen_at = app.now(),
    applied_policy_version_id = coalesce(v_applied, applied_policy_version_id),
    management = case when p_report->>'managed' = 'true' then 'device_owner' when p_report->>'managed' = 'false' then 'unmanaged' else management end,
    state = case when state in ('deactivated', 'deactivation_pending') then state
                 when p_report->>'managed' = 'false' then 'failed'
                 when v_applied is not null and v_applied = want.id and jsonb_array_length(v_failed) = 0 then 'active'
                 when state = 'failed' and p_report->>'managed' = 'true' then 'provisioned'
                 else state end,
    battery_pct = case when (p_report->>'battery_pct') ~ '^\d{1,3}$' and (p_report->>'battery_pct')::int <= 100 then (p_report->>'battery_pct')::int end,
    charging = case when jsonb_typeof(p_report->'charging') = 'boolean' then (p_report->>'charging')::boolean end,
    agent_version = case when (p_report->>'agent_version') ~ '^[A-Za-z0-9._+-]{1,40}$' then p_report->>'agent_version' else agent_version end,
    sdk_int = case when (p_report->>'sdk') ~ '^\d{2}$' then (p_report->>'sdk')::int else sdk_int end,
    android_release = coalesce(left(p_report->>'release', 20), android_release),
    last_error = left(nullif(p_report->>'last_error', ''), 300),
    report = jsonb_build_object('apps', v_apps, 'failed_restrictions', v_failed,
      'lock_task', p_report->'lock_task', 'maintenance', p_report->'maintenance',
      'capabilities', case when jsonb_typeof(p_report->'capabilities') = 'object' then p_report->'capabilities' else '{}'::jsonb end,
      'network', left(p_report->>'network', 40), 'recovery_version', p_report->'recovery_version', 'reported_at', app.now())
  where id = d.id returning * into d;
  return jsonb_build_object(
    'server_time', app.now(),
    'device', jsonb_build_object('id', d.id, 'name', d.name, 'state', d.state,
      'tenant_slug', (select slug from public.tenants where id = d.tenant_id),
      'tenant_active', app.can_operate(d.tenant_id)),
    'policy', case when want.id is null then null else jsonb_build_object('version_id', want.id, 'version', want.version, 'config', want.config) end,
    'apps_meta', coalesce((select jsonb_agg(jsonb_build_object('package_name', c.package_name, 'label', c.label, 'min_version_code', c.min_version_code) order by c.label)
      from public.mdm_app_catalog c where c.package_name in (select jsonb_array_elements_text(coalesce(want.config->'apps', '[]')))), '[]'),
    'commands', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'seq', c.seq, 'action', c.action,
        'params', c.params || coalesce(c.secret_params, '{}'::jsonb), 'expires_at', c.expires_at, 'status', c.status) order by c.seq)
      from public.mdm_commands c where c.device_id = d.id and c.status in ('pending', 'received', 'applying')), '[]'),
    -- Hashes de recuperação só quando o aparelho ainda não tem a versão atual.
    'recovery', case when coalesce((p_report->>'recovery_version')::int, -1) is distinct from d.recovery_version and d.recovery_version > 0 then
      jsonb_build_object('version', d.recovery_version, 'codes', (select jsonb_agg(jsonb_build_object('idx', r.idx, 'salt', r.salt, 'hash', r.hash,
        'iterations', r.iterations, 'used', r.used_at is not null) order by r.idx)
        from public.mdm_recovery_codes r where r.device_id = d.id and r.version = d.recovery_version)) end,
    'used_recovery', (select coalesce(jsonb_agg(r.idx), '[]') from public.mdm_recovery_codes r where r.device_id = d.id and r.version = d.recovery_version and r.used_at is not null));
exception when invalid_text_representation then
  raise exception 'Relatório do aparelho inválido.' using errcode = '22023';
end $$;

create function public.mdm_agent_ack(p_device uuid, p_counter bigint, p_command uuid, p_status text, p_detail text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_agent_auth(p_device, p_counter); c public.mdm_commands; v_terminal boolean;
begin
  perform app.mdm_expire_commands(d.id);
  select * into c from public.mdm_commands where id = p_command and device_id = d.id for update;
  if not found then raise exception 'Comando não encontrado para este aparelho.' using errcode = 'P0002'; end if;
  if p_status not in ('received', 'applying', 'applied', 'failed') then raise exception 'Estado inválido.' using errcode = '22023'; end if;
  if c.status in ('applied', 'failed', 'expired', 'cancelled') then
    return jsonb_build_object('status', c.status, 'replayed', true);  -- estado final não regride
  end if;
  -- Ordem: pending → received → applying → applied|failed (pular etapas à frente é aceito; voltar não).
  if array_position(array['pending', 'received', 'applying', 'applied'], p_status) <= array_position(array['pending', 'received', 'applying', 'applied'], c.status)
     and p_status <> 'failed' then
    return jsonb_build_object('status', c.status, 'replayed', true);
  end if;
  v_terminal := p_status in ('applied', 'failed');
  update public.mdm_commands set status = p_status, detail = left(p_detail, 300), updated_at = app.now(),
    secret_params = case when v_terminal then null else secret_params end where id = c.id;
  insert into public.mdm_command_results (command_id, status, detail, reported_at) values (c.id, p_status, left(p_detail, 300), app.now());

  if c.action = 'start_maintenance' and p_status = 'applied' then
    update public.mdm_maintenance_sessions set started_at = app.now(), expires_at = app.now() + make_interval(mins => (c.params->>'minutes')::int)
     where command_id = c.id;
  elsif c.action = 'start_maintenance' and p_status = 'failed' then
    update public.mdm_maintenance_sessions set ended_at = app.now(), end_reason = 'device' where command_id = c.id and ended_at is null;
  elsif c.action = 'end_maintenance' and p_status = 'applied' then
    update public.mdm_maintenance_sessions set ended_at = app.now(), end_reason = 'manual' where device_id = d.id and ended_at is null;
  elsif c.action = 'deactivate' and p_status = 'applied' then
    update public.mdm_devices set state = 'deactivated', deactivated_at = app.now(), management = 'unknown' where id = d.id;
    update public.mdm_device_credentials set status = 'revoked', revoked_at = app.now() where device_id = d.id and status = 'active';
    update public.mdm_maintenance_sessions set ended_at = app.now(), end_reason = 'deactivated' where device_id = d.id and ended_at is null;
    update public.mdm_commands set status = 'cancelled', updated_at = app.now(), secret_params = null where device_id = d.id and status in ('pending', 'received', 'applying');
  elsif c.action = 'deactivate' and p_status = 'failed' then
    update public.mdm_devices set state = 'active', last_error = left(p_detail, 300) where id = d.id and state = 'deactivation_pending';
  end if;
  perform app.mdm_event(d.tenant_id, d.id, 'aparelho', 'command.' || p_status, jsonb_build_object('action', c.action, 'seq', c.seq, 'detail', left(p_detail, 120)));
  return jsonb_build_object('status', p_status, 'replayed', false);
end $$;

-- Eventos locais do aparelho (manutenção offline, expiração, reboot, falhas de código).
create function public.mdm_agent_event(p_device uuid, p_counter bigint, p_event text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.mdm_devices := app.mdm_agent_auth(p_device, p_counter); v_idx int; v_ver int; v_min int; v_at timestamptz;
begin
  if p_event not in ('boot', 'agent.restart', 'maintenance.offline_start', 'maintenance.end', 'recovery.failed', 'recovery.locked',
                     'policy.failed', 'wifi.rollback', 'wifi.applied', 'kiosk.unmanaged', 'shift.logout') then
    raise exception 'Evento desconhecido.' using errcode = '22023';
  end if;
  -- Horário informado pelo aparelho é só referência; o servidor registra o próprio.
  if p_event = 'maintenance.offline_start' then
    v_idx := (p_data->>'idx')::int; v_ver := (p_data->>'version')::int; v_min := least(greatest(coalesce((p_data->>'minutes')::int, 15), 5), 60);
    update public.mdm_recovery_codes set used_at = coalesce(used_at, app.now())
     where device_id = d.id and version = v_ver and idx = v_idx;
    if not found then raise exception 'Código de recuperação desconhecido.' using errcode = '22023'; end if;
    v_at := app.now();
    insert into public.mdm_maintenance_sessions (tenant_id, device_id, method, scope, reason, started_at, expires_at)
    values (d.tenant_id, d.id, 'offline_code', 'settings', 'Recuperação offline com código descartável', v_at, v_at + make_interval(mins => v_min));
  elsif p_event = 'maintenance.end' then
    update public.mdm_maintenance_sessions set ended_at = app.now(),
      end_reason = case when p_data->>'reason' in ('manual', 'expired', 'reboot', 'policy', 'device') then p_data->>'reason' else 'device' end
     where device_id = d.id and ended_at is null;
  end if;
  perform app.mdm_event(d.tenant_id, d.id, 'aparelho', p_event, jsonb_build_object(
    'idx', p_data->'idx', 'version', p_data->'version', 'reason', left(p_data->>'reason', 40), 'detail', left(p_data->>'detail', 120)));
  update public.mdm_devices set last_seen_at = app.now() where id = d.id;
  return jsonb_build_object('ok', true);
exception when invalid_text_representation then
  raise exception 'Dados do evento inválidos.' using errcode = '22023';
end $$;

-- Retenção: eventos/resultados > 180 dias e tokens vencidos > 30 dias (chamado pelo job diário).
create function public.mdm_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a int; b int;
begin
  alter table public.mdm_audit_events disable trigger mdm_audit_append_only;
  delete from public.mdm_audit_events where created_at < app.now() - interval '180 days';
  get diagnostics a = row_count;
  alter table public.mdm_audit_events enable trigger mdm_audit_append_only;
  delete from public.mdm_enrollment_tokens where expires_at < app.now() - interval '30 days';
  get diagnostics b = row_count;
  update public.mdm_commands set secret_params = null where secret_params is not null and expires_at < app.now();
  return jsonb_build_object('events', a, 'tokens', b);
end $$;

revoke all on function app.mdm_agent_auth(uuid, bigint), app.mdm_expire_commands(uuid) from public, anon, authenticated;
revoke all on function public.mdm_agent_enroll(text, text, text, jsonb), public.mdm_agent_key(uuid),
  public.mdm_agent_sync(uuid, bigint, jsonb), public.mdm_agent_ack(uuid, bigint, uuid, text, text),
  public.mdm_agent_event(uuid, bigint, text, jsonb), public.mdm_retention() from public, anon, authenticated;
grant execute on function public.mdm_agent_enroll(text, text, text, jsonb), public.mdm_agent_key(uuid),
  public.mdm_agent_sync(uuid, bigint, jsonb), public.mdm_agent_ack(uuid, bigint, uuid, text, text),
  public.mdm_agent_event(uuid, bigint, text, jsonb), public.mdm_retention() to service_role;
