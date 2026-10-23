-- =============================================================================
-- Suporte da plataforma com protocolo.
--  * Abre chamado: equipe (admin/porteiro) de um condomínio ativo. Morador NÃO abre:
--    continua falando com a portaria do próprio condomínio.
--  * Protocolo legível e sequencial por ano (fuso de São Paulo): SUP-AAAA-000001.
--  * Contexto técnico seguro: só rota (sem query/hash) e versão do app. Nada de
--    dados pessoais, coleta automática ou captura de tela.
--  * Mensagens append-only. Nota interna (internal) só aparece para a plataforma.
--  * Resposta pública da equipe gera job support_reply (e-mail + push) só para quem abriu.
--  * Tempos de primeira resposta e resolução vêm de timestamps reais (sem estimativa).
-- Acesso às tabelas somente via RPC (RLS ligada, nenhum grant para clientes).
-- =============================================================================

create table app.support_protocol_seq (year int primary key, last_value int not null);
revoke all on app.support_protocol_seq from public, anon, authenticated;

create table public.support_settings (
  id boolean primary key default true check (id),
  hours text check (hours is null or length(hours) <= 300),
  channels text check (channels is null or length(channels) <= 300),
  first_response_target text check (first_response_target is null or length(first_response_target) <= 120),
  approved boolean not null default false,       -- prazo de 1ª resposta só é exibido se aprovado
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  protocol text not null unique check (protocol ~ '^SUP-[0-9]{4}-[0-9]{6,}$'),
  -- ponytail: hoje só a equipe de um condomínio abre; nulo reservado a chamados sem condomínio.
  tenant_id uuid references public.tenants(id) on delete set null,
  opened_by uuid references auth.users(id) on delete set null,
  opener_role text not null check (opener_role in ('admin', 'porteiro')),
  kind text not null check (kind in ('operacional', 'comercial')),
  subject text not null check (length(btrim(subject)) between 3 and 140),
  category text not null check (category in ('encomendas', 'moradores', 'equipe', 'totem', 'avisos', 'cobranca', 'acesso', 'outro')),
  priority text not null default 'normal' check (priority in ('baixa', 'normal', 'alta', 'urgente')),
  status text not null default 'aberto' check (status in ('aberto', 'em_atendimento', 'aguardando_cliente', 'resolvido', 'encerrado')),
  ctx_route text check (ctx_route is null or ctx_route ~ '^/[A-Za-z0-9/_-]{0,199}$'),
  ctx_app_version text check (ctx_app_version is null or ctx_app_version ~ '^[A-Za-z0-9._+-]{1,40}$'),
  assigned_to uuid references auth.users(id) on delete set null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  first_response_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz
);
create index support_tickets_tenant_idx on public.support_tickets (tenant_id, created_at desc);
create index support_tickets_queue_idx on public.support_tickets (status, priority, created_at);

create table public.support_messages (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id),
  author_id uuid,
  author_side text not null check (author_side in ('cliente', 'equipe')),
  internal boolean not null default false check (not internal or author_side = 'equipe'),
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null
);
create index support_messages_ticket_idx on public.support_messages (ticket_id, id);
create trigger support_messages_append_only before update or delete on public.support_messages
  for each row execute function app.block_mutation();

alter table public.support_settings enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
revoke all on public.support_settings, public.support_tickets, public.support_messages from public, anon, authenticated;
grant all on public.support_settings, public.support_tickets, public.support_messages to service_role;

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
create function app.support_text(p text, p_min int, p_max int, p_label text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p, ''));
begin
  if length(v) < p_min or length(v) > p_max then
    raise exception '% deve ter entre % e % caracteres.', p_label, p_min, p_max using errcode = '22023';
  end if;
  return v;
end $$;

-- Cliente: admin do condomínio vê todos os chamados dele; porteiro só os que abriu (com vínculo ativo).
create function app.support_client_can(t public.support_tickets) returns boolean
language sql stable security definer set search_path = '' as $$
  select t.tenant_id is not null and (app.is_admin(t.tenant_id) or (t.opened_by = auth.uid() and app.is_staff(t.tenant_id)))
$$;

create function app.support_ticket_json(t public.support_tickets) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'protocol', t.protocol, 'tenant_id', t.tenant_id, 'kind', t.kind, 'subject', t.subject,
    'category', t.category, 'priority', t.priority, 'status', t.status, 'created_at', t.created_at, 'updated_at', t.updated_at,
    'first_response_at', t.first_response_at, 'resolved_at', t.resolved_at, 'closed_at', t.closed_at,
    'opener_role', t.opener_role, 'opened_by_me', t.opened_by = auth.uid(),
    'opener_name', (select coalesce(nullif(btrim(p.full_name), ''), 'Equipe do condomínio') from public.profiles p where p.id = t.opened_by))
$$;

create function app.support_messages_json(p_ticket uuid, p_with_internal boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'side', m.author_side, 'internal', m.internal, 'body', m.body,
      'created_at', m.created_at, 'mine', m.author_id = auth.uid(),
      'author', case when m.author_side = 'equipe' then 'Equipe Portaria Prime'
                     else (select coalesce(nullif(btrim(p.full_name), ''), 'Equipe do condomínio') from public.profiles p where p.id = m.author_id) end)
    order by m.id), '[]'::jsonb)
  from public.support_messages m where m.ticket_id = p_ticket and (p_with_internal or not m.internal)
$$;

-- ---------------------------------------------------------------------------
-- Cliente (equipe do condomínio)
-- ---------------------------------------------------------------------------
create function public.support_open(p_tenant uuid, p_kind text, p_subject text, p_category text, p_body text,
  p_priority text default 'normal', p_route text default null, p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := app.now(); v_year int; v_seq int; t public.support_tickets;
begin
  perform app.require(app.is_staff(p_tenant), 'Somente a equipe do condomínio abre chamados com o suporte. Moradores falam com a portaria.');
  if p_kind not in ('operacional', 'comercial') then raise exception 'Tipo de chamado inválido.' using errcode = '22023'; end if;
  if coalesce(p_priority, 'normal') not in ('baixa', 'normal', 'alta') then
    raise exception 'Prioridade inválida. Urgência é definida pela equipe de suporte.' using errcode = '22023';
  end if;
  if (select count(*) from public.support_tickets where opened_by = auth.uid() and created_at > v_now - interval '1 hour') >= 5 then
    raise exception 'Muitos chamados abertos em sequência. Aguarde alguns minutos ou responda a um chamado existente.' using errcode = 'P0001';
  end if;
  v_year := extract(year from v_now at time zone 'America/Sao_Paulo')::int;
  insert into app.support_protocol_seq as s (year, last_value) values (v_year, 1)
    on conflict (year) do update set last_value = s.last_value + 1
    returning last_value into v_seq;
  insert into public.support_tickets (protocol, tenant_id, opened_by, opener_role, kind, subject, category, priority,
    ctx_route, ctx_app_version, created_at, updated_at)
  values ('SUP-' || v_year || '-' || lpad(v_seq::text, 6, '0'), p_tenant, auth.uid(),
    case when app.is_admin(p_tenant) then 'admin' else 'porteiro' end, p_kind,
    app.support_text(p_subject, 3, 140, 'O assunto'), p_category, coalesce(p_priority, 'normal'),
    case when p_route ~ '^/[A-Za-z0-9/_-]{0,199}$' then p_route end,
    case when p_app_version ~ '^[A-Za-z0-9._+-]{1,40}$' then p_app_version end, v_now, v_now)
  returning * into t;
  insert into public.support_messages (ticket_id, author_id, author_side, body, created_at)
  values (t.id, auth.uid(), 'cliente', app.support_text(p_body, 1, 4000, 'A mensagem'), v_now);
  perform app.audit(p_tenant, 'support.opened', 'support_ticket', t.id::text, jsonb_build_object('protocol', t.protocol, 'category', t.category));
  return jsonb_build_object('id', t.id, 'protocol', t.protocol);
end $$;

create function public.support_my_tickets(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_staff(p_tenant));
  return coalesce((select jsonb_agg(app.support_ticket_json(t) order by t.updated_at desc)
    from public.support_tickets t where t.tenant_id = p_tenant and app.support_client_can(t)), '[]'::jsonb);
end $$;

create function public.support_ticket(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_ticket;
  perform app.require(found and app.support_client_can(t));
  return app.support_ticket_json(t) || jsonb_build_object('messages', app.support_messages_json(t.id, false));
end $$;

create function public.support_reply(p_ticket uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.support_tickets; v_now timestamptz := app.now();
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  perform app.require(found and app.support_client_can(t));
  if t.status = 'encerrado' then raise exception 'Chamado encerrado. Abra um novo chamado.' using errcode = 'P0001'; end if;
  insert into public.support_messages (ticket_id, author_id, author_side, body, created_at)
  values (t.id, auth.uid(), 'cliente', app.support_text(p_body, 1, 4000, 'A mensagem'), v_now);
  -- Resposta do cliente reabre o atendimento (resolução anterior deixa de valer).
  update public.support_tickets set updated_at = v_now,
    status = case when status in ('aguardando_cliente', 'resolvido') then 'aberto' else status end,
    resolved_at = case when status = 'resolvido' then null else resolved_at end
  where id = t.id;
end $$;

create function public.support_close(p_ticket uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.support_tickets; v_now timestamptz := app.now();
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  perform app.require(found and app.support_client_can(t));
  if t.status = 'encerrado' then return; end if;
  update public.support_tickets set status = 'encerrado', closed_at = v_now, updated_at = v_now where id = t.id;
  perform app.audit(t.tenant_id, 'support.closed_by_client', 'support_ticket', t.id::text, jsonb_build_object('protocol', t.protocol));
end $$;

-- Horário/canais configurados pela plataforma. Prazo de 1ª resposta só sai se aprovado.
create function public.support_settings_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.support_settings; v_full boolean := (public.platform_context()->'capabilities') ? 'support';
begin
  perform app.require(auth.uid() is not null);
  select * into s from public.support_settings where id;
  if not found then return null; end if;
  return jsonb_build_object('hours', s.hours, 'channels', s.channels, 'approved', s.approved,
    'first_response_target', case when s.approved or v_full then s.first_response_target end,
    'updated_at', case when v_full then s.updated_at end);
end $$;

-- ---------------------------------------------------------------------------
-- Plataforma (capacidades support / support_manage)
-- ---------------------------------------------------------------------------
create function public.support_admin_list(p_status text default null, p_priority text default null, p_category text default null,
  p_query text default null, p_tenant uuid default null, p_mine boolean default false, p_page int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := nullif(lower(btrim(coalesce(p_query, ''))), ''); v_page int := greatest(coalesce(p_page, 0), 0);
begin
  perform app.platform_require('support');
  return (with f as (
      select t.* from public.support_tickets t
       where (nullif(p_status, '') is null or (p_status = 'ativos' and t.status not in ('resolvido', 'encerrado')) or t.status = p_status)
         and (nullif(p_priority, '') is null or t.priority = p_priority)
         and (nullif(p_category, '') is null or t.category = p_category)
         and (p_tenant is null or t.tenant_id = p_tenant)
         and (not coalesce(p_mine, false) or t.assigned_to = auth.uid())
         and (q is null or position(q in lower(t.protocol || ' ' || t.subject)) > 0))
    select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(r order by o) from (
      select row_number() over (order by (f.status in ('resolvido', 'encerrado')),
               array_position(array['urgente', 'alta', 'normal', 'baixa'], f.priority), f.created_at) o,
        app.support_ticket_json(f) || jsonb_build_object(
          'tenant_name', (select coalesce(b.display_name, tn.name) from public.tenants tn left join public.tenant_branding b on b.tenant_id = tn.id where tn.id = f.tenant_id),
          'assigned_to_me', f.assigned_to = auth.uid(),
          'assigned_name', (select coalesce(nullif(btrim(p.full_name), ''), 'Equipe') from public.profiles p where p.id = f.assigned_to),
          'awaiting_team', (select m.author_side = 'cliente' from public.support_messages m where m.ticket_id = f.id and not m.internal order by m.id desc limit 1)) r
        from f
       order by (f.status in ('resolvido', 'encerrado')), array_position(array['urgente', 'alta', 'normal', 'baixa'], f.priority), f.created_at
       limit 25 offset v_page * 25) x), '[]'::jsonb)));
end $$;

create function public.support_admin_ticket(p_ticket uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.support_tickets;
begin
  perform app.platform_require('support');
  select * into t from public.support_tickets where id = p_ticket;
  perform app.require(found, 'Chamado não encontrado.');
  return app.support_ticket_json(t) || jsonb_build_object(
    'tenant_name', (select coalesce(b.display_name, tn.name) from public.tenants tn left join public.tenant_branding b on b.tenant_id = tn.id where tn.id = t.tenant_id),
    'tenant_slug', (select slug from public.tenants where id = t.tenant_id),
    'ctx_route', t.ctx_route, 'ctx_app_version', t.ctx_app_version, 'assigned_to_me', t.assigned_to = auth.uid(),
    'assigned_name', (select coalesce(nullif(btrim(p.full_name), ''), 'Equipe') from public.profiles p where p.id = t.assigned_to),
    'messages', app.support_messages_json(t.id, true));
end $$;

create function public.support_admin_assign(p_ticket uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.support_tickets;
begin
  perform app.platform_require('support_manage');
  select * into t from public.support_tickets where id = p_ticket for update;
  perform app.require(found, 'Chamado não encontrado.');
  update public.support_tickets set assigned_to = auth.uid(), updated_at = app.now(),
    status = case when status = 'aberto' then 'em_atendimento' else status end where id = t.id;
  perform app.audit(t.tenant_id, 'support.assigned', 'support_ticket', t.id::text, jsonb_build_object('protocol', t.protocol));
end $$;

create function public.support_admin_reply(p_ticket uuid, p_body text, p_internal boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.support_tickets; v_now timestamptz := app.now(); v_msg bigint; v_internal boolean := coalesce(p_internal, false);
begin
  perform app.platform_require('support_manage');
  select * into t from public.support_tickets where id = p_ticket for update;
  perform app.require(found, 'Chamado não encontrado.');
  if t.status = 'encerrado' and not v_internal then
    raise exception 'Chamado encerrado. Reabra antes de responder ao cliente.' using errcode = 'P0001';
  end if;
  insert into public.support_messages (ticket_id, author_id, author_side, internal, body, created_at)
  values (t.id, auth.uid(), 'equipe', v_internal, app.support_text(p_body, 1, 4000, 'A mensagem'), v_now)
  returning id into v_msg;
  if v_internal then return; end if;   -- nota interna: não conta como resposta nem avisa o cliente
  update public.support_tickets set updated_at = v_now, first_response_at = coalesce(first_response_at, v_now),
    assigned_to = coalesce(assigned_to, auth.uid()),
    status = case when status in ('aberto', 'em_atendimento') then 'aguardando_cliente' else status end
  where id = t.id;
  -- Aviso só para quem abriu e enquanto ainda for da equipe do condomínio (regra do outbox revalida no envio).
  if exists (select 1 from public.tenant_memberships m where m.tenant_id = t.tenant_id and m.user_id = t.opened_by
              and m.status = 'active' and m.role in ('admin', 'porteiro')) then
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
    select t.tenant_id, 'support_reply', c.channel, c.recipient, t.id::text || ':' || v_msg, jsonb_build_object('ticket_id', t.id)
      from (select 'email' channel, lower(u.email::text) recipient from auth.users u where u.id = t.opened_by and u.email is not null
            union all select 'push', t.opened_by::text) c
    on conflict do nothing;
  end if;
  perform app.audit(t.tenant_id, 'support.replied', 'support_ticket', t.id::text, jsonb_build_object('protocol', t.protocol));
end $$;

create function public.support_admin_set(p_ticket uuid, p_status text default null, p_priority text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.support_tickets; v_now timestamptz := app.now(); v_status text; v_priority text;
begin
  perform app.platform_require('support_manage');
  select * into t from public.support_tickets where id = p_ticket for update;
  perform app.require(found, 'Chamado não encontrado.');
  v_status := coalesce(nullif(p_status, ''), t.status);
  v_priority := coalesce(nullif(p_priority, ''), t.priority);
  if v_status not in ('aberto', 'em_atendimento', 'aguardando_cliente', 'resolvido', 'encerrado') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if v_priority not in ('baixa', 'normal', 'alta', 'urgente') then raise exception 'Prioridade inválida.' using errcode = '22023'; end if;
  update public.support_tickets set status = v_status, priority = v_priority, updated_at = v_now,
    resolved_at = case when v_status = 'resolvido' then coalesce(resolved_at, v_now)
                       when v_status = 'encerrado' then resolved_at else null end,
    closed_at = case when v_status = 'encerrado' then coalesce(closed_at, v_now) else null end
  where id = t.id;
  perform app.audit(t.tenant_id, 'support.updated', 'support_ticket', t.id::text,
    jsonb_build_object('protocol', t.protocol, 'status', v_status, 'priority', v_priority));
end $$;

-- Métricas do período (fuso de São Paulo, fim inclusivo). Tempos em horas; nulos sem amostra.
create function public.support_metrics(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare tz text := 'America/Sao_Paulo'; a timestamptz; b timestamptz;
begin
  perform app.platform_require('support');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Período inválido (máximo de 1 ano).' using errcode = '22023';
  end if;
  a := p_from::timestamp at time zone tz;
  b := (p_to + 1)::timestamp at time zone tz;
  return (with p as (select * from public.support_tickets where created_at >= a and created_at < b)
    select jsonb_build_object('from', p_from, 'to', p_to, 'timezone', tz,
      'opened', (select count(*) from p),
      'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'n', n) order by n desc, category), '[]'::jsonb)
                        from (select category, count(*) n from p group by 1) c),
      'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from p group by 1) k),
      'first_response', (select jsonb_build_object('n', count(h), 'pending', count(*) - count(h),
                            'avg_h', round(avg(h)::numeric, 1), 'median_h', round((percentile_cont(0.5) within group (order by h))::numeric, 1))
                           from (select extract(epoch from first_response_at - created_at) / 3600 h from p) x),
      'resolution', (select jsonb_build_object('n', count(h), 'avg_h', round(avg(h)::numeric, 1),
                        'median_h', round((percentile_cont(0.5) within group (order by h))::numeric, 1))
                       from (select extract(epoch from resolved_at - created_at) / 3600 h from p) x),
      'backlog', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
                    select status, count(*) n from public.support_tickets where status not in ('resolvido', 'encerrado') group by 1) s)));
end $$;

create function public.support_settings_save(p_hours text, p_channels text, p_first_response_target text, p_approved boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.platform_require('support_manage');
  insert into public.support_settings (id, hours, channels, first_response_target, approved, updated_by, updated_at)
  values (true, nullif(btrim(left(p_hours, 300)), ''), nullif(btrim(left(p_channels, 300)), ''),
    nullif(btrim(left(p_first_response_target, 120)), ''), coalesce(p_approved, false), auth.uid(), now())
  on conflict (id) do update set hours = excluded.hours, channels = excluded.channels,
    first_response_target = excluded.first_response_target, approved = excluded.approved,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform app.audit(null, 'support.settings_saved', 'support_settings', 'singleton', jsonb_build_object('approved', coalesce(p_approved, false)));
end $$;

-- ---------------------------------------------------------------------------
-- Contexto do template support_reply: encadeia o notification_context existente
-- (renomeado para app.*) sem reescrevê-lo. Só protocolo e id; nada do conteúdo.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('app.notification_context_before_support(uuid)') is null then
    alter function public.notification_context(uuid) rename to notification_context_before_support;
    alter function public.notification_context_before_support(uuid) set schema app;
  end if;
end $$;

create or replace function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := app.notification_context_before_support(p_job); j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job;
  if j.event = 'support_reply' then
    v := coalesce(v, '{}'::jsonb) || jsonb_build_object('support', (select jsonb_build_object('ticket_id', t.id, 'protocol', t.protocol)
      from public.support_tickets t where t.id::text = split_part(j.ref_id, ':', 1)));
  end if;
  return v;
end $$;

revoke all on function app.notification_context_before_support(uuid), app.support_text(text, int, int, text),
  app.support_client_can(public.support_tickets), app.support_ticket_json(public.support_tickets),
  app.support_messages_json(uuid, boolean) from public, anon, authenticated;
revoke all on function public.notification_context(uuid) from public, anon, authenticated;
grant execute on function public.notification_context(uuid), app.notification_context_before_support(uuid) to service_role;

revoke all on function public.support_open(uuid, text, text, text, text, text, text, text), public.support_my_tickets(uuid),
  public.support_ticket(uuid), public.support_reply(uuid, text), public.support_close(uuid), public.support_settings_get(),
  public.support_admin_list(text, text, text, text, uuid, boolean, int), public.support_admin_ticket(uuid),
  public.support_admin_assign(uuid), public.support_admin_reply(uuid, text, boolean), public.support_admin_set(uuid, text, text),
  public.support_metrics(date, date), public.support_settings_save(text, text, text, boolean) from public, anon;
grant execute on function public.support_open(uuid, text, text, text, text, text, text, text), public.support_my_tickets(uuid),
  public.support_ticket(uuid), public.support_reply(uuid, text), public.support_close(uuid), public.support_settings_get(),
  public.support_admin_list(text, text, text, text, uuid, boolean, int), public.support_admin_ticket(uuid),
  public.support_admin_assign(uuid), public.support_admin_reply(uuid, text, boolean), public.support_admin_set(uuid, text, text),
  public.support_metrics(date, date), public.support_settings_save(text, text, text, boolean) to authenticated, service_role;
