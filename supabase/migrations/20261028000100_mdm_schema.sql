-- =============================================================================
-- Dispositivos gerenciados (Portaria Prime Kiosk, Android Device Owner).
-- Separado do totem PWA (device_enrollments), que continua igual.
--  * Inscrição: token curto, uso único, vinculado ao aparelho pretendido (hash no banco).
--  * Credencial: chave EC P-256 gerada no Android Keystore; o banco guarda só a chave
--    pública e o último contador (anti-replay). Revogável e rotacionável.
--  * Políticas versionadas e validadas no banco; atribuição fixa uma versão publicada.
--  * Comandos enumerados, idempotentes, com expiração e ACK do aparelho.
--  * Manutenção com motivo, escopo e expiração; códigos de recuperação offline guardados
--    apenas como PBKDF2 (o texto é exibido uma vez ao síndico).
-- Nenhum grant direto a clientes: tudo via RPC com validação de tenant no servidor.
-- =============================================================================

-- Catálogo de apps que um condomínio pode autorizar no Multi-App (curado pela plataforma).
create table public.mdm_app_catalog (
  package_name text primary key check (package_name ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' and length(package_name) <= 150),
  label text not null check (length(btrim(label)) between 2 and 60),
  min_version_code bigint not null default 0 check (min_version_code >= 0),
  notes text check (notes is null or length(notes) <= 300),
  active boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.mdm_app_catalog (package_name, label, notes) values
  ('com.google.android.calculator', 'Calculadora', 'Calculadora do Google.'),
  ('com.google.android.apps.authenticator2', 'Google Authenticator', 'Códigos de verificação em duas etapas do operador.');

create table public.mdm_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 60),
  concierge_location_id uuid,
  purpose text not null default 'portaria' check (purpose in ('portaria', 'totem_equipe', 'painel')),
  state text not null default 'pending' check (state in ('pending', 'provisioned', 'active', 'failed', 'deactivation_pending', 'deactivated')),
  management text not null default 'unknown' check (management in ('unknown', 'device_owner', 'unmanaged')),
  agent_id text check (agent_id is null or agent_id ~ '^[A-Za-z0-9-]{16,64}$'),
  manufacturer text check (manufacturer is null or length(manufacturer) <= 60),
  model text check (model is null or length(model) <= 60),
  android_release text check (android_release is null or length(android_release) <= 20),
  sdk_int int check (sdk_int is null or sdk_int between 21 and 99),
  agent_version text check (agent_version is null or agent_version ~ '^[A-Za-z0-9._+-]{1,40}$'),
  battery_pct int check (battery_pct is null or battery_pct between 0 and 100),
  charging boolean,
  applied_policy_version_id uuid,
  report jsonb not null default '{}'::jsonb,       -- capacidades/inventário sanitizados
  last_error text check (last_error is null or length(last_error) <= 300),
  last_seen_at timestamptz,
  recovery_version int not null default 0,
  last_seq bigint not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  deactivated_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, concierge_location_id) references public.concierge_locations (tenant_id, id)
);
create index mdm_devices_tenant_idx on public.mdm_devices (tenant_id, created_at desc);

create table public.mdm_enrollment_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  device_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, device_id) references public.mdm_devices (tenant_id, id) on delete cascade
);

create table public.mdm_device_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  device_id uuid not null,
  public_key text not null check (public_key ~ '^[A-Za-z0-9+/=]+$' and length(public_key) between 80 and 400),   -- SPKI DER em base64
  last_counter bigint not null default 0,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (tenant_id, device_id) references public.mdm_devices (tenant_id, id) on delete cascade
);
create unique index mdm_one_active_credential on public.mdm_device_credentials (device_id) where status = 'active';

create table public.mdm_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 60),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table public.mdm_policy_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  policy_id uuid not null,
  version int not null check (version >= 1),
  config jsonb not null,
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (policy_id, version),
  unique (tenant_id, id),
  foreign key (tenant_id, policy_id) references public.mdm_policies (tenant_id, id) on delete cascade
);

-- Atribuição: política desejada de cada aparelho (versão publicada fixada).
create table public.mdm_assignments (
  device_id uuid primary key,
  tenant_id uuid not null,
  policy_version_id uuid not null,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  foreign key (tenant_id, device_id) references public.mdm_devices (tenant_id, id) on delete cascade,
  foreign key (tenant_id, policy_version_id) references public.mdm_policy_versions (tenant_id, id)
);

create table public.mdm_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  device_id uuid not null,
  seq bigint not null,
  action text not null check (action in ('sync_policy', 'start_maintenance', 'end_maintenance', 'reboot', 'wifi_apply', 'deactivate')),
  params jsonb not null default '{}'::jsonb,
  secret_params jsonb,               -- só senha de Wi-Fi; apagada ao terminar; nunca exibida
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9-]{8,80}$'),
  status text not null default 'pending' check (status in ('pending', 'received', 'applying', 'applied', 'failed', 'expired', 'cancelled')),
  detail text check (detail is null or length(detail) <= 300),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, idempotency_key),
  unique (device_id, seq),
  foreign key (tenant_id, device_id) references public.mdm_devices (tenant_id, id) on delete cascade
);
create index mdm_commands_device_idx on public.mdm_commands (device_id, seq);

create table public.mdm_command_results (
  id bigint generated always as identity primary key,
  command_id uuid not null references public.mdm_commands(id) on delete cascade,
  status text not null check (status in ('received', 'applying', 'applied', 'failed', 'expired')),
  detail text check (detail is null or length(detail) <= 300),
  reported_at timestamptz not null
);
create trigger mdm_command_results_append_only before update or delete on public.mdm_command_results
  for each row execute function app.block_mutation();

create table public.mdm_maintenance_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  device_id uuid not null,
  method text not null check (method in ('remote', 'offline_code')),
  scope text not null check (scope in ('settings', 'wifi', 'apps')),
  reason text not null check (length(btrim(reason)) between 3 and 200),
  command_id uuid references public.mdm_commands(id),
  authorized_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('manual', 'expired', 'reboot', 'policy', 'device', 'deactivated')),
  foreign key (tenant_id, device_id) references public.mdm_devices (tenant_id, id) on delete cascade
);
create index mdm_maintenance_device_idx on public.mdm_maintenance_sessions (device_id, started_at desc);

-- Códigos de recuperação offline: só PBKDF2-HMAC-SHA256 (sal por código). Texto nunca guardado.
create table public.mdm_recovery_codes (
  device_id uuid not null,
  tenant_id uuid not null,
  version int not null,
  idx int not null check (idx between 0 and 19),
  salt text not null check (salt ~ '^[0-9a-f]{32}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  iterations int not null check (iterations between 10000 and 1000000),
  used_at timestamptz,
  primary key (device_id, version, idx),
  foreign key (tenant_id, device_id) references public.mdm_devices (tenant_id, id) on delete cascade
);

create table public.mdm_audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  device_id uuid,
  actor_id uuid,
  source text not null check (source in ('painel', 'aparelho', 'plataforma')),
  event text not null check (event ~ '^[a-z_.]{3,60}$'),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index mdm_audit_device_idx on public.mdm_audit_events (tenant_id, device_id, id desc);
create trigger mdm_audit_append_only before update or delete on public.mdm_audit_events
  for each row execute function app.block_mutation();

do $$ declare t text; begin
  foreach t in array array['mdm_app_catalog','mdm_devices','mdm_enrollment_tokens','mdm_device_credentials','mdm_policies',
    'mdm_policy_versions','mdm_assignments','mdm_commands','mdm_command_results','mdm_maintenance_sessions','mdm_recovery_codes','mdm_audit_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Validação de política (única fonte; o agente revalida localmente).
-- Câmera nunca pode ser bloqueada; atualização do sistema nunca adiada indefinidamente.
-- ---------------------------------------------------------------------------
create function app.mdm_restriction_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array['no_install_apps','no_uninstall_apps','no_unknown_sources','no_add_user','no_modify_accounts','no_debugging',
    'no_safe_boot','no_screen_capture','no_factory_reset','no_config_wifi','no_usb_file_transfer','no_config_bluetooth']
$$;

create function app.mdm_policy_config(p jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  mode text := coalesce(p->>'mode', 'single_app');
  feats text[]; restr text[]; apps text[]; bad text; v jsonb; su jsonb;
  allowed_keys text[] := array['mode','start_path','apps','lock_task_features','status_bar_disabled','restrictions','keep_screen_on',
    'stay_on_plugged','orientation','brightness','system_update','maintenance_max_minutes','sync_interval_seconds'];
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Política inválida.' using errcode = '22023'; end if;
  select k into bad from jsonb_object_keys(p) k where k <> all (allowed_keys) limit 1;
  if bad is not null then raise exception 'Campo de política desconhecido: %.', bad using errcode = '22023'; end if;
  if mode not in ('single_app', 'multi_app') then raise exception 'Modo deve ser single_app ou multi_app.' using errcode = '22023'; end if;
  if coalesce(p->>'start_path', 'portaria') not in ('portaria', 'totem-equipe', 'painel') then
    raise exception 'Tela inicial deve ser portaria, totem-equipe ou painel.' using errcode = '22023';
  end if;

  feats := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'lock_task_features', '[]')) x), '{}');
  select x into bad from unnest(feats) x where x <> all (array['system_info','notifications','home','overview','global_actions','keyguard']) limit 1;
  if bad is not null then raise exception 'Recurso de bloqueio desconhecido: %.', bad using errcode = '22023'; end if;
  if mode = 'single_app' and feats && array['home','overview','notifications'] then
    raise exception 'Single-App não libera Início, Recentes nem notificações do sistema.' using errcode = '22023';
  end if;
  if 'overview' = any (feats) and not 'home' = any (feats) then
    raise exception 'Recentes exige o botão Início liberado (regra do Android).' using errcode = '22023';
  end if;
  if 'notifications' = any (feats) and not 'home' = any (feats) then
    raise exception 'Notificações exigem o botão Início liberado (regra do Android).' using errcode = '22023';
  end if;

  restr := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'restrictions', '[]')) x), '{}');
  if restr && array['camera','no_camera','disable_camera'] then
    raise exception 'A câmera não pode ser bloqueada: OCR, QR e foto de entrega dependem dela.' using errcode = '22023';
  end if;
  select x into bad from unnest(restr) x where x <> all (app.mdm_restriction_keys()) limit 1;
  if bad is not null then raise exception 'Restrição desconhecida: %.', bad using errcode = '22023'; end if;

  apps := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'apps', '[]')) x), '{}');
  if mode = 'single_app' and cardinality(apps) > 0 then raise exception 'Single-App não aceita outros aplicativos.' using errcode = '22023'; end if;
  if cardinality(apps) > 12 then raise exception 'No máximo 12 aplicativos autorizados.' using errcode = '22023'; end if;
  select x into bad from unnest(apps) x where not exists (select 1 from public.mdm_app_catalog c where c.package_name = x and c.active) limit 1;
  if bad is not null then raise exception 'Aplicativo fora do catálogo autorizado: %.', bad using errcode = '22023'; end if;

  if coalesce(p->>'orientation', 'auto') not in ('auto', 'portrait', 'landscape') then
    raise exception 'Orientação inválida.' using errcode = '22023';
  end if;
  if p ? 'brightness' and p->'brightness' <> 'null'::jsonb and not (jsonb_typeof(p->'brightness') = 'number' and (p->>'brightness')::numeric between 10 and 255) then
    raise exception 'Brilho deve estar entre 10 e 255.' using errcode = '22023';
  end if;
  foreach bad in array array['status_bar_disabled','keep_screen_on','stay_on_plugged'] loop
    if p ? bad and jsonb_typeof(p->bad) <> 'boolean' then raise exception 'Campo % deve ser verdadeiro/falso.', bad using errcode = '22023'; end if;
  end loop;

  su := coalesce(p->'system_update', '{"type":"automatic"}');
  if su->>'type' = 'windowed' then
    if not ((su->>'start_min') ~ '^\d+$' and (su->>'end_min') ~ '^\d+$' and (su->>'start_min')::int < 1440 and (su->>'end_min')::int < 1440
            and (su->>'start_min')::int <> (su->>'end_min')::int) then
      raise exception 'Janela de atualização inválida.' using errcode = '22023';
    end if;
    su := jsonb_build_object('type', 'windowed', 'start_min', (su->>'start_min')::int, 'end_min', (su->>'end_min')::int);
  elsif su->>'type' = 'automatic' then su := '{"type":"automatic"}';
  else raise exception 'Atualização do sistema: automática ou em janela (adiar indefinidamente não é permitido).' using errcode = '22023';
  end if;

  if coalesce(p->>'maintenance_max_minutes', '30') !~ '^\d+$' or coalesce(p->>'maintenance_max_minutes', '30')::int not between 5 and 240 then
    raise exception 'Manutenção máxima entre 5 e 240 minutos.' using errcode = '22023';
  end if;
  if coalesce(p->>'sync_interval_seconds', '300') !~ '^\d+$' or coalesce(p->>'sync_interval_seconds', '300')::int not between 60 and 3600 then
    raise exception 'Intervalo de sincronização entre 60 e 3600 segundos.' using errcode = '22023';
  end if;

  -- Forma canônica (padrões explícitos) — é isso que o aparelho recebe.
  v := jsonb_build_object(
    'mode', mode, 'start_path', coalesce(p->>'start_path', 'portaria'),
    'apps', to_jsonb(apps), 'lock_task_features', to_jsonb(coalesce((select array_agg(distinct x order by x) from unnest(feats) x), '{}')),
    'status_bar_disabled', coalesce((p->>'status_bar_disabled')::boolean, mode = 'single_app'),
    'restrictions', to_jsonb(coalesce((select array_agg(distinct x order by x) from unnest(restr) x), '{}')),
    'keep_screen_on', coalesce((p->>'keep_screen_on')::boolean, true),
    'stay_on_plugged', coalesce((p->>'stay_on_plugged')::boolean, false),
    'orientation', coalesce(p->>'orientation', 'auto'),
    'brightness', case when p->'brightness' is null or p->'brightness' = 'null'::jsonb then null else (p->>'brightness')::int end,
    'system_update', su,
    'maintenance_max_minutes', coalesce(p->>'maintenance_max_minutes', '30')::int,
    'sync_interval_seconds', coalesce(p->>'sync_interval_seconds', '300')::int);
  return v;
end $$;

-- Política padrão: Single-App, operação da portaria, restrições seguras (sem câmera).
create function app.mdm_default_config() returns jsonb
language sql stable set search_path = '' as $$
  select app.mdm_policy_config(jsonb_build_object('mode', 'single_app', 'start_path', 'portaria',
    'lock_task_features', jsonb_build_array('global_actions', 'system_info'),
    'restrictions', jsonb_build_array('no_add_user', 'no_debugging', 'no_factory_reset', 'no_install_apps', 'no_modify_accounts',
      'no_safe_boot', 'no_uninstall_apps', 'no_unknown_sources', 'no_usb_file_transfer')))
$$;

create function app.mdm_event(p_tenant uuid, p_device uuid, p_source text, p_event text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.mdm_audit_events (tenant_id, device_id, actor_id, source, event, data, created_at)
  values (p_tenant, p_device, auth.uid(), p_source, p_event, coalesce(p_data, '{}'::jsonb), app.now())
$$;

-- Reautenticação recente (≤ 5 min) pelo carimbo "amr" do JWT do Supabase; com MFA cadastrado exige aal2.
create function app.mdm_require_recent_auth() returns void
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb; ts bigint; mfa boolean := false;
begin
  select max((e->>'timestamp')::bigint) into ts from jsonb_array_elements(coalesce(c->'amr', '[]')) e
   where e->>'method' in ('password', 'otp', 'totp', 'magiclink', 'recovery');
  if ts is null or to_timestamp(ts) < app.now() - interval '5 minutes' then
    raise exception 'Confirme sua senha para esta ação.' using errcode = '42501', hint = 'reauth';
  end if;
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select exists(select 1 from auth.mfa_factors where user_id=$1 and status=''verified'')' into mfa using auth.uid();
    if mfa and c->>'aal' is distinct from 'aal2' then raise exception 'Confirme o MFA antes desta ação.' using errcode = '42501'; end if;
  end if;
end $$;

-- Estado exibido no painel. "offline" = sem contato recente, não certeza de aparelho desligado.
create function app.mdm_display_state(d public.mdm_devices) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when d.state = 'deactivated' then 'desativado'
    when d.state = 'pending' then 'pendente_provisionamento'
    when d.state = 'deactivation_pending' then 'desativacao_pendente'
    when d.state = 'failed' then 'falha'
    when exists (select 1 from public.mdm_maintenance_sessions m where m.device_id = d.id and m.ended_at is null and m.expires_at > app.now()) then 'em_manutencao'
    when d.last_seen_at is null or d.last_seen_at < app.now() - make_interval(secs => greatest(600, 3 * coalesce(
      (select (v.config->>'sync_interval_seconds')::int from public.mdm_assignments a join public.mdm_policy_versions v on v.id = a.policy_version_id where a.device_id = d.id), 300)))
      then 'offline'
    when d.applied_policy_version_id is distinct from (select a.policy_version_id from public.mdm_assignments a where a.device_id = d.id) then 'politica_pendente'
    when d.state = 'provisioned' then 'provisionado'
    else 'ativo' end
$$;

revoke all on function app.mdm_restriction_keys(), app.mdm_policy_config(jsonb), app.mdm_default_config(),
  app.mdm_event(uuid, uuid, text, text, jsonb), app.mdm_require_recent_auth(), app.mdm_display_state(public.mdm_devices)
  from public, anon, authenticated;
