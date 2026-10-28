-- =============================================================================
-- Admin Master: visão de suporte dos dispositivos gerenciados (somente leitura, auditada).
--  * Capacidade "devices" para owner, support e auditor (encadeada na definição atual).
--  * Nenhuma ação remota sobre aparelhos de clientes a partir da plataforma: manutenção,
--    Wi-Fi, reinício e desativação são do síndico. Suporte orienta; não assume o aparelho.
--  * Publicação da versão do agente (APK HTTPS + checksum) exige "devices_release" (owner) + MFA.
-- =============================================================================

do $$
declare def text;
begin
  def := pg_get_functiondef('public.platform_context()'::regprocedure);
  def := replace(def, $x$'organizations','organizations_manage']$x$, $x$'organizations','organizations_manage','devices','devices_release']$x$);
  def := replace(def, $x$'support','support_manage','quotes']$x$, $x$'support','support_manage','quotes','devices']$x$);
  def := replace(def, $x$'quotes','costs','legal','support','organizations']$x$, $x$'quotes','costs','legal','support','organizations','devices']$x$);
  if def not like '%''devices_release''%' or (length(def) - length(replace(def, '''devices''', ''))) / length('''devices''') < 3 then
    raise exception 'platform_context: não foi possível incluir a capacidade devices';
  end if;
  execute def;
end $$;

-- "devices" é leitura (sem MFA); "devices_release" é ação (exige MFA via app.platform_require).
create function public.platform_devices(p_tenant uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  perform app.platform_require('devices');
  select coalesce(jsonb_agg(x order by x->>'tenant_name'), '[]') into r from (
    select jsonb_build_object('tenant_id', t.id, 'tenant_name', t.name, 'total', count(d.*),
      'by_state', (select jsonb_object_agg(s, n) from (select app.mdm_display_state(d2) s, count(*) n from public.mdm_devices d2 where d2.tenant_id = t.id group by 1) z),
      'unmanaged', count(*) filter (where d.management = 'unmanaged'),
      'last_seen_at', max(d.last_seen_at),
      'agent_versions', (select jsonb_agg(distinct d3.agent_version) from public.mdm_devices d3 where d3.tenant_id = t.id and d3.agent_version is not null),
      'devices', case when p_tenant = t.id then (select jsonb_agg(jsonb_build_object('id', d4.id, 'name', d4.name, 'state', app.mdm_display_state(d4),
          'management', d4.management, 'model', d4.model, 'android_release', d4.android_release, 'agent_version', d4.agent_version,
          'last_seen_at', d4.last_seen_at, 'last_error', d4.last_error,
          'failed_restrictions', d4.report->'failed_restrictions') order by d4.created_at) from public.mdm_devices d4 where d4.tenant_id = t.id) end) x
    from public.tenants t join public.mdm_devices d on d.tenant_id = t.id
    where p_tenant is null or t.id = p_tenant
    group by t.id, t.name) q;
  if p_tenant is not null then
    insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id) values (p_tenant, auth.uid(), 'platform.devices_view', 'tenant', p_tenant::text);
  end if;
  return jsonb_build_object('tenants', r,
    'release', (select jsonb_build_object('version_code', version_code, 'version_name', version_name, 'apk_url', apk_url, 'signature_checksum', signature_checksum, 'created_at', created_at)
      from public.mdm_agent_releases where active));
end $$;

create function public.platform_agent_release(p_version_code int, p_version_name text, p_apk_url text, p_signature_checksum text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.platform_require('devices_release');
  update public.mdm_agent_releases set active = false where active;
  insert into public.mdm_agent_releases (version_code, version_name, apk_url, signature_checksum, active)
  values (p_version_code, p_version_name, p_apk_url, p_signature_checksum, true)
  on conflict (version_code) do update set version_name = excluded.version_name, apk_url = excluded.apk_url,
    signature_checksum = excluded.signature_checksum, active = true;
  insert into public.audit_logs (actor_id, action, target_type, target_id, data)
  values (auth.uid(), 'platform.agent_release', 'agent_release', p_version_code::text, jsonb_build_object('apk_url', p_apk_url, 'version_name', p_version_name));
exception when check_violation then
  raise exception 'Versão inválida: URL HTTPS e checksum base64url de 43 caracteres.' using errcode = '22023';
end $$;

revoke all on function public.platform_devices(uuid), public.platform_agent_release(int, text, text, text) from public, anon;
grant execute on function public.platform_devices(uuid), public.platform_agent_release(int, text, text, text) to authenticated, service_role;
