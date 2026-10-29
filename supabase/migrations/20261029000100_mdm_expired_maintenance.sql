-- =============================================================================
-- Correção (achada no emulador): comando de manutenção que EXPIRA sem ser aplicado deixava a sessão
-- de manutenção aberta, e o painel mostrava "em manutenção" para um aparelho que estava em quiosque.
--  * Ao expirar/cancelar um start_maintenance, a sessão vinculada é encerrada (end_reason='expired').
--  * O estado "em manutenção" passa a exigir sessão confirmada pelo aparelho (comando aplicado ou
--    manutenção offline por código), não apenas pedida.
--  * Saneia sessões já abertas nessa situação.
-- =============================================================================

create or replace function app.mdm_expire_commands(p_device uuid) returns void
language sql security definer set search_path = '' as $$
  with x as (
    update public.mdm_commands set status = 'expired', updated_at = app.now(), secret_params = null
     where device_id = p_device and status in ('pending', 'received') and expires_at <= app.now()
    returning id),
  r as (
    insert into public.mdm_command_results (command_id, status, detail, reported_at)
    select id, 'expired', 'Expirou sem confirmação do aparelho.', app.now() from x)
  update public.mdm_maintenance_sessions set ended_at = app.now(), end_reason = 'expired'
   where command_id in (select id from x) and ended_at is null
$$;
revoke all on function app.mdm_expire_commands(uuid) from public, anon, authenticated;

create or replace function app.mdm_display_state(d public.mdm_devices) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when d.state = 'deactivated' then 'desativado'
    when d.state = 'pending' then 'pendente_provisionamento'
    when d.state = 'deactivation_pending' then 'desativacao_pendente'
    when d.state = 'failed' then 'falha'
    when exists (select 1 from public.mdm_maintenance_sessions m left join public.mdm_commands c on c.id = m.command_id
                  where m.device_id = d.id and m.ended_at is null and m.expires_at > app.now()
                    and (m.method = 'offline_code' or c.status = 'applied')) then 'em_manutencao'
    when d.last_seen_at is null or d.last_seen_at < app.now() - make_interval(secs => greatest(600, 3 * coalesce(
      (select (v.config->>'sync_interval_seconds')::int from public.mdm_assignments a join public.mdm_policy_versions v on v.id = a.policy_version_id where a.device_id = d.id), 300)))
      then 'offline'
    when d.applied_policy_version_id is distinct from (select a.policy_version_id from public.mdm_assignments a where a.device_id = d.id) then 'politica_pendente'
    when d.state = 'provisioned' then 'provisionado'
    else 'ativo' end
$$;
revoke all on function app.mdm_display_state(public.mdm_devices) from public, anon, authenticated;

-- Comando cancelado (substituído por outro do mesmo tipo) também fecha a sessão que ele abriu.
update public.mdm_maintenance_sessions m set ended_at = c.updated_at, end_reason = 'expired'
  from public.mdm_commands c
 where c.id = m.command_id and m.ended_at is null and c.status in ('expired', 'cancelled', 'failed');
