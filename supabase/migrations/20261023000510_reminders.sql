-- =============================================================================
-- Lembretes de encomenda parada, configuráveis por condomínio.
--  - Desligado por padrão. Primeiro lembrete após X horas na portaria; depois a
--    cada N horas; só dentro da janela de horário local; no máximo M vezes.
--  - Mesmos destinatários do aviso de chegada (contatos deduplicados + push por
--    morador ativo). ref_id = '<package_id>:<n>' (dedupe por lembrete).
--  - Encerram na retirada/exceção: nada novo é gerado, os pendentes são
--    desativados e o worker revalida (encomenda precisa ainda ocupar espaço).
--  - Gerados por public.enqueue_package_reminders(), chamada pelo /api/jobs/tick.
-- =============================================================================

alter table public.tenant_settings
  add column if not exists reminder_enabled boolean not null default false,
  add column if not exists reminder_after_hours int not null default 48 check (reminder_after_hours between 1 and 720),
  add column if not exists reminder_interval_hours int not null default 24 check (reminder_interval_hours between 1 and 168),
  add column if not exists reminder_start_hour smallint not null default 8 check (reminder_start_hour between 0 and 23),
  add column if not exists reminder_end_hour smallint not null default 20 check (reminder_end_hour between 1 and 24),
  add column if not exists reminder_max int not null default 3 check (reminder_max between 1 and 10);
alter table public.tenant_settings drop constraint if exists tenant_settings_reminder_window_check;
alter table public.tenant_settings add constraint tenant_settings_reminder_window_check check (reminder_start_hour < reminder_end_hour);
-- Mesma política de settings_update (permissão "settings"); colunas liberadas explicitamente.
grant update (reminder_enabled, reminder_after_hours, reminder_interval_hours, reminder_start_hour, reminder_end_hour, reminder_max)
  on public.tenant_settings to authenticated;

-- Estado por encomenda (quantos lembretes já saíram e quando). Só o servidor escreve.
-- (Sem "if not exists": scripts/backup-prime.mjs descobre tabelas por "create table public.")
create table public.package_reminders (
  tenant_id uuid not null,
  package_id uuid primary key,
  sent int not null default 0,
  last_at timestamptz not null,
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id)
);
revoke all on public.package_reminders from public, anon, authenticated;

-- Versão geral do enfileiramento (cópia fiel da última, 20261022000500) com ref_id
-- explícito. A de 2 argumentos vira atalho com ref = id da encomenda (comportamento igual).
create or replace function app.enqueue_package_notifications_ref(p_pkg public.packages, p_event text, p_ref text)
returns int language plpgsql security definer set search_path = '' as $$
declare s public.tenant_settings; n int := 0; c record; v_title text; v_body text; v_ref text := p_ref;
  v_status text := case when p_event = 'package_picked_up' then 'hold' else 'queued' end;
begin
  select * into s from public.tenant_settings where tenant_id = p_pkg.tenant_id;
  if p_event = 'package_received' then
    v_title := 'Nova encomenda na portaria';
    v_body := 'Há uma encomenda (' || p_pkg.carrier || ') aguardando retirada. Abra o app para ver o QR Code.';
  elsif p_event = 'package_reminder' then
    v_title := 'Encomenda aguardando retirada';
    v_body := 'Há uma encomenda (' || p_pkg.carrier || ') aguardando retirada na portaria. Abra o app para ver o QR Code.';
  else
    v_title := 'Encomenda retirada';
    v_body := 'Uma encomenda da sua unidade foi retirada. O comprovante está disponível no app.';
  end if;
  if coalesce(s.notify_whatsapp, true) and app.has_feature(p_pkg.tenant_id, 'whatsapp') then
    for c in select distinct phone from public.resident_contacts
              where tenant_id = p_pkg.tenant_id and unit_id = p_pkg.unit_id and active and notify_whatsapp and phone is not null loop
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload, status)
      values (p_pkg.tenant_id, p_event, 'whatsapp', c.phone, v_ref, jsonb_build_object('package_id', p_pkg.id), v_status) on conflict do nothing;
      if found then n := n + 1; end if;
    end loop;
  end if;
  if coalesce(s.notify_email, true) then
    for c in select distinct email from public.resident_contacts
              where tenant_id = p_pkg.tenant_id and unit_id = p_pkg.unit_id and active and notify_email and email is not null loop
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload, status)
      values (p_pkg.tenant_id, p_event, 'email', c.email, v_ref, jsonb_build_object('package_id', p_pkg.id), v_status) on conflict do nothing;
      if found then n := n + 1; end if;
    end loop;
  end if;
  for c in select distinct um.user_id from public.unit_memberships um
             join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
            where um.tenant_id = p_pkg.tenant_id and um.unit_id = p_pkg.unit_id and um.status = 'active' loop
    -- Central: chegada/retirada uma vez por encomenda; cada lembrete é chamado uma única vez por número.
    insert into public.notifications (tenant_id, user_id, kind, title, body, package_id)
    select p_pkg.tenant_id, c.user_id, p_event, v_title, v_body, p_pkg.id
     where p_event = 'package_reminder' or not exists(select 1 from public.notifications where tenant_id = p_pkg.tenant_id
                       and user_id = c.user_id and package_id = p_pkg.id and kind = p_event);
    if coalesce(s.notify_push, true) then
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'push', c.user_id::text, v_ref, jsonb_build_object('package_id', p_pkg.id)) on conflict do nothing;
      if found then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

create or replace function app.enqueue_package_notifications(p_pkg public.packages, p_event text)
returns int language sql security definer set search_path = '' as $$
  select app.enqueue_package_notifications_ref(p_pkg, p_event, p_pkg.id::text)
$$;

-- Destinatário do lembrete: ref '<pacote>:<n>', encomenda ainda ocupando espaço e
-- MESMA regra de destinatário da chegada (contato/morador ativo da unidade).
-- Função própria, encadeada em app.notification_allowed ANTES de notification_allowed_ext:
-- outras frentes podem redefinir a _ext sem afrouxar esta regra.
create or replace function app.package_reminder_allowed(j public.notification_jobs) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(j.ref_id, '') !~ '^[0-9a-f-]{36}:[0-9]{1,2}$' then return false; end if;
  return exists(select 1 from public.packages p where p.tenant_id = j.tenant_id and p.id::text = split_part(j.ref_id, ':', 1)
      and app.occupies_space(p.status))
    and app.notification_allowed(jsonb_populate_record(j, jsonb_build_object('event', 'package_received', 'ref_id', split_part(j.ref_id, ':', 1))));
end $$;
revoke all on function app.package_reminder_allowed(public.notification_jobs) from public, anon, authenticated;

do $$
declare src text;
begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if src !~ 'package_reminder_allowed' then
    src := regexp_replace(src, '\n(\s*)if j\.event in \(''package_reminder''',
      E'\n\\1if j.event = ''package_reminder'' then return app.package_reminder_allowed(j); end if;\n\\1if j.event in (''package_reminder''');
    if src !~ 'package_reminder_allowed' then raise exception 'Não foi possível encadear a regra do lembrete em notification_allowed.'; end if;
    execute src;
  end if;
end $$;

-- Gera os lembretes devidos. Idempotente e seguro em paralelo: o avanço do
-- contador é um upsert condicional (a segunda execução concorrente não passa no WHERE).
create or replace function public.enqueue_package_reminders(p_limit int default 200) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_now timestamptz := app.now(); v_n int; v_jobs int := 0; v_pk int := 0;
begin
  for r in
    select p.*, s.reminder_interval_hours iv, s.reminder_max mx
      from public.tenant_settings s
      join public.tenants t on t.id = s.tenant_id and t.status = 'active'
      join public.packages p on p.tenant_id = s.tenant_id and app.occupies_space(p.status)
      left join public.package_reminders pr on pr.package_id = p.id
     where s.reminder_enabled
       and extract(hour from v_now at time zone t.timezone) >= s.reminder_start_hour
       and extract(hour from v_now at time zone t.timezone) < s.reminder_end_hour
       and p.received_at <= v_now - make_interval(hours => s.reminder_after_hours)
       and (pr.package_id is null or (pr.sent < s.reminder_max and pr.last_at <= v_now - make_interval(hours => s.reminder_interval_hours)))
     order by p.received_at
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)
     for update of p skip locked
  loop
    v_n := null;
    insert into public.package_reminders as pr (tenant_id, package_id, sent, last_at) values (r.tenant_id, r.id, 1, v_now)
    on conflict (package_id) do update set sent = pr.sent + 1, last_at = v_now
      where pr.sent < r.mx and pr.last_at <= v_now - make_interval(hours => r.iv)
    returning sent into v_n;
    if v_n is null then continue; end if;
    v_pk := v_pk + 1;
    v_jobs := v_jobs + app.enqueue_package_notifications_ref(
      (select p from public.packages p where p.id = r.id), 'package_reminder', r.id::text || ':' || v_n);
  end loop;
  return jsonb_build_object('packages', v_pk, 'jobs', v_jobs);
end $$;

-- Retirada/exceção: lembretes ainda não enviados deixam de sair na hora.
create or replace function app.stop_package_reminders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.notification_jobs set status = 'disabled', last_error = 'Encomenda não aguarda mais retirada', locked_until = null, updated_at = now()
   where tenant_id = new.tenant_id and event = 'package_reminder' and ref_id like new.id::text || ':%'
     and status in ('queued', 'failed', 'hold');
  return null;
end $$;
drop trigger if exists packages_stop_reminders on public.packages;
create trigger packages_stop_reminders after update of status on public.packages
  for each row when (old.status in ('RECEBIDA', 'ARMAZENADA') and new.status not in ('RECEBIDA', 'ARMAZENADA'))
  execute function app.stop_package_reminders();

revoke all on function app.enqueue_package_notifications_ref(public.packages, text, text), app.stop_package_reminders(),
  public.enqueue_package_reminders(int) from public, anon, authenticated;
grant execute on function public.enqueue_package_reminders(int) to service_role;
