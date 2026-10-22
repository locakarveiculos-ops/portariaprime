-- =============================================================================
-- Operação dos avisos: agendador no próprio banco (pg_cron + pg_net), batimento
-- do worker, falha final visível e alertada ao síndico, reprocessamento pelo
-- condomínio, teste de WhatsApp e inscrição push com troca segura de usuário.
-- =============================================================================

create table public.worker_runs (
  name text primary key,
  last_finished_at timestamptz,
  last_result jsonb not null default '{}'::jsonb
);
revoke all on public.worker_runs from public, anon, authenticated;

create function public.record_worker_run(p_name text, p_result jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.worker_runs (name, last_finished_at, last_result) values (p_name, now(), coalesce(p_result, '{}'::jsonb))
  on conflict (name) do update set last_finished_at = now(), last_result = excluded.last_result
$$;

-- Alerta operacional ao síndico (push), além dos avisos de encomenda.
alter table public.notification_jobs drop constraint if exists notification_jobs_event_check;
alter table public.notification_jobs add constraint notification_jobs_event_check check (event in
  ('package_received', 'package_picked_up', 'invitation', 'trial_reminder', 'billing_order', 'billing_paid', 'ops_alert'));

create or replace function app.notification_allowed(j public.notification_jobs) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare u uuid;
begin
  if not exists(select 1 from public.tenants where id = j.tenant_id and status = 'active') then return false; end if;
  if j.event in ('package_received','package_picked_up') then
    select unit_id into u from public.packages where tenant_id = j.tenant_id and id::text = j.ref_id;
    if u is null then return false; end if;
    if j.channel = 'push' then
      return exists(select 1 from public.unit_memberships um join public.tenant_memberships m
        on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
        where um.tenant_id = j.tenant_id and um.unit_id = u and um.user_id::text = j.recipient and um.status = 'active');
    end if;
    return exists(select 1 from public.resident_contacts c where c.tenant_id = j.tenant_id and c.unit_id = u and c.active
      and ((j.channel = 'email' and c.notify_email and c.email = j.recipient)
        or (j.channel = 'whatsapp' and c.notify_whatsapp and c.phone = j.recipient))
      and (c.user_id is null or exists(select 1 from public.unit_memberships um join public.tenant_memberships m
        on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
        where um.tenant_id = c.tenant_id and um.unit_id = c.unit_id and um.user_id = c.user_id and um.status = 'active')));
  end if;
  if j.event = 'ops_alert' then
    return j.channel = 'push' and exists(select 1 from public.tenant_memberships
      where tenant_id = j.tenant_id and user_id::text = j.recipient and role = 'admin' and status = 'active');
  end if;
  if j.event in ('trial_reminder','billing_order','billing_paid') then
    return j.channel = 'email' and j.recipient in (select app.billing_admin_emails(j.tenant_id));
  end if;
  return false;
end $$;

-- Central do síndico (1 a cada 6 h por pessoa) + push deduplicado na mesma janela.
create function app.ops_alert(p_tenant uuid, p_title text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare a record;
  v_ref text := 'ops:' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || ':' || (extract(hour from now() at time zone 'UTC')::int / 6);
begin
  for a in select user_id from public.tenant_memberships where tenant_id = p_tenant and role = 'admin' and status = 'active' loop
    if not exists (select 1 from public.notifications where tenant_id = p_tenant and user_id = a.user_id
                    and kind = 'ops_alert' and created_at > now() - interval '6 hours') then
      insert into public.notifications (tenant_id, user_id, kind, title, body) values (p_tenant, a.user_id, 'ops_alert', p_title, p_body);
    end if;
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id)
    values (p_tenant, 'ops_alert', 'push', a.user_id::text, v_ref) on conflict do nothing;
  end loop;
end $$;

-- p_final: erro permanente (ex.: número sem WhatsApp) vira falha final sem retry.
drop function public.complete_notification_job(uuid, text, text, text);
create function public.complete_notification_job(
  p_job uuid, p_status text, p_provider_ref text default null, p_error text default null, p_final boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare j public.notification_jobs;
begin
  if p_status not in ('accepted', 'delivered', 'failed', 'disabled') then raise exception 'status inválido'; end if;
  update public.notification_jobs set status = p_status, last_error = left(p_error, 500), locked_until = null,
    -- Tempo esgotado depois do envio é ambíguo: não repete sozinho (evita mensagem duplicada).
    attempts = case when p_status = 'failed' and (p_final or p_error ~* '^ambiguous') then greatest(attempts, 5) else attempts end,
    next_attempt_at = case when p_status = 'failed'
      then now() + make_interval(mins => power(4, least(attempts, 4) - 1)::int) + random() * interval '30 seconds'
      else next_attempt_at end,
    updated_at = now()
  where id = p_job returning * into j;
  if not found then return; end if;
  insert into public.notification_attempts (job_id, tenant_id, ok, provider_ref, error)
  values (j.id, j.tenant_id, p_status in ('accepted', 'delivered'), p_provider_ref, left(p_error, 500));
  if p_status in ('accepted', 'delivered') and j.event = 'package_received' then
    update public.packages set notified_at = coalesce(notified_at, now())
     where tenant_id = j.tenant_id and id = (j.payload ->> 'package_id')::uuid;
  end if;
  if j.status = 'failed' and j.attempts >= 5 and j.event <> 'ops_alert' then
    perform app.ops_alert(j.tenant_id, 'Avisos com falha',
      'Alguns avisos não puderam ser enviados. Abra Configurações › Avisos e WhatsApp para ver e reenviar.');
  end if;
end $$;

-- Worker: instância do condomínio desconectada vira alerta ao síndico (sem detalhe técnico ao morador).
create function public.ops_alert_whatsapp(p_tenant uuid) returns void
language sql security definer set search_path = '' as $$
  select app.ops_alert(p_tenant, 'WhatsApp desconectado',
    'O WhatsApp do condomínio está desconectado. Avisos aguardam na fila. Reconecte em Configurações › WhatsApp.')
$$;
revoke all on function public.ops_alert_whatsapp(uuid) from public, anon, authenticated;
grant execute on function public.ops_alert_whatsapp(uuid) to service_role;

-- Destinatário mascarado: o síndico identifica o contato sem expor o dado completo.
create function app.mask_recipient(p_channel text, p_recipient text) returns text
language sql immutable set search_path = '' as $$
  select case p_channel
    when 'whatsapp' then '••••' || right(p_recipient, 4)
    when 'email' then left(p_recipient, 2) || '•••@' || split_part(p_recipient, '@', 2)
    else 'aplicativo' end
$$;

create function public.notification_health(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_admin(p_tenant));
  return jsonb_build_object(
    'worker_last_run', (select last_finished_at from public.worker_runs where name = 'tick'),
    'whatsapp', (select jsonb_build_object('enabled', enabled, 'configured', nullif(config ->> 'instance', '') is not null)
                   from public.tenant_integrations where tenant_id = p_tenant and provider = 'whatsapp_evolution'),
    'counts', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
      select channel || ':' || case when status = 'failed' and attempts >= 5 then 'failed_final'
                                    when status = 'failed' then 'failed_retryable' else status end k, count(*) n
        from public.notification_jobs where tenant_id = p_tenant and created_at > now() - interval '7 days' group by 1) x),
    'failures', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'channel', channel, 'event', event,
        'recipient', app.mask_recipient(channel, recipient), 'attempts', attempts, 'error', last_error,
        'final', attempts >= 5, 'ambiguous', coalesce(last_error, '') ~* '^ambiguous', 'at', updated_at) order by updated_at desc), '[]'::jsonb)
      from (select * from public.notification_jobs where tenant_id = p_tenant and status = 'failed'
             order by updated_at desc limit 20) f));
end $$;

-- Reenvio manual: nova tentativa do MESMO job (não cria outro recebimento).
create function public.retry_notification_job(p_tenant uuid, p_job uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.notification_jobs;
begin
  perform app.require(app.is_admin(p_tenant));
  select * into j from public.notification_jobs where tenant_id = p_tenant and id = p_job for update;
  if not found or j.status <> 'failed' or j.attempts < 5 then
    raise exception 'Somente aviso com falha final pode ser reenviado.' using errcode = 'P0001';
  end if;
  if not app.notification_allowed(j) then raise exception 'Destinatário não está mais autorizado.' using errcode = '42501'; end if;
  update public.notification_jobs set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null,
    locked_until = null, updated_at = now() where id = j.id;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id)
  values (p_tenant, auth.uid(), 'notification.retry', 'notification_job', j.id::text);
end $$;

-- Teste de WhatsApp: só administrador com "settings", plano com WhatsApp, 1 a cada 2 min,
-- conta na franquia e fica auditado (apenas os 4 últimos dígitos).
create function public.whatsapp_test_gate(p_tenant uuid, p_last4 text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_instance text;
begin
  perform app.require(app.has_perm(p_tenant, 'settings') and app.has_feature(p_tenant, 'whatsapp'),
    'Requer permissão de configurações e plano com WhatsApp.');
  select config ->> 'instance' into v_instance from public.tenant_integrations
   where tenant_id = p_tenant and provider = 'whatsapp_evolution' and enabled;
  if v_instance is null then raise exception 'WhatsApp do condomínio não está conectado.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.audit_logs where tenant_id = p_tenant and action = 'whatsapp.test'
              and created_at > now() - interval '2 minutes') then
    raise exception 'Aguarde 2 minutos entre testes.' using errcode = 'P0001';
  end if;
  if not app.consume_usage(p_tenant, 'whatsapp', (app.entitlements(p_tenant)).whatsapp_monthly) then
    raise exception 'Franquia de WhatsApp do mês esgotada.' using errcode = 'P0001';
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, data)
  values (p_tenant, auth.uid(), 'whatsapp.test', 'whatsapp', jsonb_build_object('last4', left(p_last4, 4)));
  return v_instance;
end $$;

-- Inscrição push: o servidor decide o usuário. O mesmo endpoint (mesmo perfil de
-- navegador) deixa de entregar avisos do usuário anterior.
create function public.register_push_subscription(p_tenant uuid, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(auth.uid() is not null and app.is_member(p_tenant));
  if not app.valid_push_endpoint(p_endpoint) or length(coalesce(p_p256dh, '')) not between 20 and 200
     or length(coalesce(p_auth, '')) not between 8 and 100 then
    raise exception 'Inscrição de notificação inválida.' using errcode = '22023';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id <> auth.uid();
  insert into public.push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
  values (p_tenant, auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 200))
  on conflict (tenant_id, user_id, endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end $$;

-- Agendador no banco: dispara o worker a cada minuto, mesmo com navegador fechado.
-- URL e segredo ficam no Supabase Vault (fora do git). Sem as extensões, nada muda.
create function app.trigger_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_url text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'pp_cron_secret';
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'pp_app_url';
  if v_secret is null or v_url is null then return; end if;
  perform net.http_post(url := v_url || '/api/jobs/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
    create extension if not exists pg_cron;
    perform cron.schedule('pp-notification-tick', '* * * * *', 'select app.trigger_tick()');
  end if;
end $$;

revoke all on function public.record_worker_run(text, jsonb), app.ops_alert(uuid, text, text), app.trigger_tick(),
  public.notification_health(uuid), public.retry_notification_job(uuid, uuid), public.whatsapp_test_gate(uuid, text),
  public.register_push_subscription(uuid, text, text, text, text), app.mask_recipient(text, text) from public, anon;
revoke all on function public.record_worker_run(text, jsonb), app.ops_alert(uuid, text, text), app.trigger_tick() from authenticated;
revoke all on function public.complete_notification_job(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.complete_notification_job(uuid, text, text, text, boolean) to service_role;
grant execute on function public.record_worker_run(text, jsonb) to service_role;
grant execute on function public.notification_health(uuid), public.retry_notification_job(uuid, uuid),
  public.whatsapp_test_gate(uuid, text), public.register_push_subscription(uuid, text, text, text, text) to authenticated, service_role;
