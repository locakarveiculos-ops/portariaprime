-- =============================================================================
-- PORTARIA PRIME — Comercial (2/2): "Tenho um orçamento para comparar".
-- Solicitações (quote_requests), histórico append-only (quote_events), anexo privado,
-- sugestão de preço com piso, propostas versionadas imutáveis após envio e aceite por link.
--
-- CONTRATO — public.proposal_terms(p_token text) returns jsonb   [anon, authenticated, service_role]
--   Entrada: token opaco do link (64 hex, vem do fragmento /proposta#<token> ou de
--            /contratar?proposta=<token>). O banco guarda só sha256(token).
--   Saída (condições CONGELADAS no envio; nunca recalculadas):
--     { proposal_id uuid, quote_id uuid, protocol text, version int,
--       status 'sent'|'accepted', accepted boolean, accepted_at timestamptz|null,
--       plan_id uuid, plan_code text, plan_name text, is_custom boolean,
--       cycle 'monthly'|'quarterly'|'yearly', amount_cents int (valor TOTAL por ciclo),
--       limits jsonb (max_units, max_concierges, ocr_monthly, whatsapp_monthly, storage_mb, feature_*),
--       valid_until timestamptz, conditions text, org_name text, org_kind text,
--       units int, condos_count int, content_sha256 text }
--   Erros (SQLSTATE): P0002 proposta não encontrada/token inválido; P0001 vencida (status sent e
--     valid_until <= agora) ou retirada. Proposta ACEITA continua válida após o vencimento
--     (o aceite congela as condições). A frente de contratos deve usar amount_cents/limits daqui
--     e nunca valores vindos do navegador.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quote-attachments', 'quote-attachments', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
-- Sem policy em storage.objects para este bucket: só service_role (backend) lê/grava.

create table public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  protocol text not null unique,
  contact_name text not null check (length(btrim(contact_name)) between 2 and 120),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 200 and email = lower(email)),
  phone text check (phone is null or length(phone) between 8 and 30),
  org_kind text not null check (org_kind in ('condominio', 'administradora')),
  org_name text not null check (length(btrim(org_name)) between 2 and 160),
  units int not null check (units between 1 and 100000),
  concierges int not null default 1 check (concierges between 1 and 50),
  condos_count int not null default 1 check (condos_count between 1 and 1000),
  current_vendor text check (current_vendor is null or length(current_vendor) <= 120),
  budget_cents int check (budget_cents is null or budget_cents between 100 and 100000000),
  budget_cycle text check (budget_cycle is null or budget_cycle in ('monthly', 'quarterly', 'yearly')),
  budget_valid_until date,
  scope text check (scope is null or length(scope) <= 2000),
  attachment_path text,
  attachment_mime text check (attachment_mime is null or attachment_mime in ('application/pdf', 'image/jpeg', 'image/png')),
  attachment_bytes int check (attachment_bytes is null or attachment_bytes between 1 and 5242880),
  attachment_sha256 text,
  attachment_delete_after timestamptz,
  status text not null default 'recebida' check (status in ('recebida', 'em_analise', 'proposta_enviada', 'aceita', 'encerrada')),
  assigned_to uuid references auth.users(id) on delete set null,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((budget_cents is null) = (budget_cycle is null))
);
create index quote_requests_status_idx on public.quote_requests (status, created_at desc);
create index quote_requests_ip_idx on public.quote_requests (ip_hash, created_at);
create index quote_requests_purge_idx on public.quote_requests (attachment_delete_after) where attachment_path is not null;

create table public.quote_events (
  id bigint generated always as identity primary key,
  quote_id uuid not null references public.quote_requests(id) on delete cascade,
  actor_id uuid,
  kind text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index quote_events_quote_idx on public.quote_events (quote_id, id);
create trigger quote_events_append_only before update or delete on public.quote_events
  for each row execute function app.block_mutation();

create table public.quote_proposals (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quote_requests(id) on delete restrict,
  version int not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'expired', 'withdrawn')),
  plan_id uuid not null references public.plans(id),
  cycle text not null check (cycle in ('monthly', 'quarterly', 'yearly')),
  amount_cents int not null check (amount_cents > 0),     -- total por ciclo
  limits jsonb not null,
  valid_days int not null check (valid_days between 1 and 90),
  conditions text not null check (length(btrim(conditions)) between 10 and 4000),
  protocol text unique,
  valid_until timestamptz,
  content jsonb,
  content_sha256 text,
  token_hash text unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_by uuid,
  sent_at timestamptz,
  accepted_at timestamptz,
  withdrawn_at timestamptz,
  unique (quote_id, version),
  check (status = 'draft' or (protocol is not null and valid_until is not null and content is not null
    and content_sha256 is not null and token_hash is not null and sent_at is not null))
);

-- Enviada = imutável. Só transições de situação permitidas; conteúdo, preço, token e hash nunca mudam.
create function app.quote_proposal_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'Proposta enviada não pode ser excluída.' using errcode = '42501'; end if;
    return old;
  end if;
  if old.status = 'draft' then return new; end if;
  if (new.quote_id, new.version, new.plan_id, new.cycle, new.amount_cents, new.limits, new.valid_days, new.conditions,
      new.protocol, new.valid_until, new.content, new.content_sha256, new.token_hash, new.sent_at, new.sent_by, new.created_by)
     is distinct from
     (old.quote_id, old.version, old.plan_id, old.cycle, old.amount_cents, old.limits, old.valid_days, old.conditions,
      old.protocol, old.valid_until, old.content, old.content_sha256, old.token_hash, old.sent_at, old.sent_by, old.created_by)
     or not ((old.status = new.status)
       or (old.status = 'sent' and new.status in ('accepted', 'expired', 'withdrawn'))) then
    raise exception 'Proposta enviada é imutável. Crie uma nova versão.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger quote_proposals_guard before update or delete on public.quote_proposals
  for each row execute function app.quote_proposal_guard();

alter table public.quote_requests enable row level security;
alter table public.quote_events enable row level security;
alter table public.quote_proposals enable row level security;
revoke all on public.quote_requests, public.quote_events, public.quote_proposals from public, anon, authenticated;
grant all on public.quote_requests, public.quote_events, public.quote_proposals to service_role;

create function app.quote_event(p_quote uuid, p_kind text, p_data jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.quote_events (quote_id, actor_id, kind, data) values (p_quote, auth.uid(), p_kind, coalesce(p_data, '{}'::jsonb))
$$;

-- -----------------------------------------------------------------------------
-- Entrada pública (somente backend/service_role, depois de honeypot e validação do arquivo)
-- -----------------------------------------------------------------------------
create function public.quote_submit(p jsonb, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.quote_requests; s text;
  t text := to_char(app.now() at time zone 'America/Sao_Paulo', 'YYYYMMDD');
begin
  if p is null or jsonb_typeof(p) <> 'object' or coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Solicitação inválida.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_ip_hash, 230201));
  if (select count(*) from public.quote_requests where ip_hash = p_ip_hash and created_at > app.now() - interval '1 hour') >= 3 then
    raise exception 'Recebemos suas solicitações. Aguarde nosso retorno.' using errcode = 'P0001';
  end if;
  s := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  begin
    insert into public.quote_requests (protocol, contact_name, email, phone, org_kind, org_name, units, concierges, condos_count,
      current_vendor, budget_cents, budget_cycle, budget_valid_until, scope, ip_hash, created_at, updated_at)
    values ('PP-ORC-' || t || '-' || s, btrim(p ->> 'contact_name'), lower(btrim(p ->> 'email')), nullif(btrim(p ->> 'phone'), ''),
      p ->> 'org_kind', btrim(p ->> 'org_name'), (p ->> 'units')::int, coalesce((p ->> 'concierges')::int, 1),
      coalesce((p ->> 'condos_count')::int, 1), nullif(btrim(p ->> 'current_vendor'), ''), (p ->> 'budget_cents')::int,
      nullif(p ->> 'budget_cycle', ''), nullif(p ->> 'budget_valid_until', '')::date, nullif(btrim(p ->> 'scope'), ''),
      p_ip_hash, app.now(), app.now())
    returning * into q;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range
    or not_null_violation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'Confira os campos do orçamento.' using errcode = '22023';
  end;
  insert into public.quote_events (quote_id, kind, data) values (q.id, 'received', jsonb_build_object('source', 'landing'));
  return jsonb_build_object('id', q.id, 'protocol', q.protocol);
end $$;

-- Anexo validado no backend (assinatura de bytes, tamanho). Só uma vez, logo após o envio.
create function public.quote_attach(p_quote uuid, p_path text, p_mime text, p_bytes int, p_sha256 text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_path is null or p_path !~ ('^' || p_quote::text || '/[0-9a-f-]{36}\.(pdf|jpg|png)$') or coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Anexo inválido.' using errcode = '22023';
  end if;
  update public.quote_requests set attachment_path = p_path, attachment_mime = p_mime, attachment_bytes = p_bytes,
    attachment_sha256 = p_sha256, attachment_delete_after = app.now() + interval '180 days', updated_at = app.now()
   where id = p_quote and attachment_path is null and created_at > app.now() - interval '10 minutes';
  if not found then raise exception 'Anexo não aceito para esta solicitação.' using errcode = 'P0001'; end if;
  insert into public.quote_events (quote_id, kind, data) values (p_quote, 'attachment_added', jsonb_build_object('mime', p_mime, 'bytes', p_bytes));
end $$;

-- Retenção: anexos vencidos (180 dias). O worker remove do Storage e confirma com quote_attachment_purged.
create function public.quote_attachments_due(p_limit int default 50) returns table (id uuid, path text)
language sql stable security definer set search_path = '' as $$
  select q.id, q.attachment_path from public.quote_requests q
   where q.attachment_path is not null and q.attachment_delete_after <= app.now()
   order by q.attachment_delete_after limit least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
create function public.quote_attachment_purged(p_quote uuid, p_path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.quote_requests set attachment_path = null, attachment_mime = null, attachment_bytes = null, updated_at = app.now()
   where id = p_quote and attachment_path = p_path and attachment_delete_after <= app.now();
  if found then insert into public.quote_events (quote_id, kind, data) values (p_quote, 'attachment_purged', jsonb_build_object('retention_days', 180)); end if;
end $$;

-- -----------------------------------------------------------------------------
-- Sugestão de preço (interna; nunca promessa automática)
-- -----------------------------------------------------------------------------
create function app.quote_suggestion(q public.quote_requests) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pol public.quote_policy; pl public.plans; e public.plan_entitlements; months int; cat int;
  budget_m numeric; target_m numeric; sim jsonb; base jsonb;
begin
  select * into pol from public.quote_policy;
  if q.org_kind = 'administradora' or q.condos_count > 1 then
    return jsonb_build_object('status', 'needs_review', 'reason', 'Administradora ou vários condomínios: plano sob medida, por proposta.',
      'plan', 'sob-medida', 'discount_pct', pol.discount_pct);
  end if;
  select p.* into pl from public.plans p join public.plan_entitlements pe on pe.plan_id = p.id
   where not p.is_custom and p.published and pe.max_units >= q.units and pe.max_concierges >= q.concierges
   order by p.sort_order limit 1;
  if not found then
    return jsonb_build_object('status', 'needs_review', 'reason', 'Porte acima dos planos de catálogo: plano sob medida.',
      'plan', 'sob-medida', 'discount_pct', pol.discount_pct);
  end if;
  select * into e from public.plan_entitlements where plan_id = pl.id;
  months := app.cycle_months(coalesce(q.budget_cycle, 'monthly'));
  select amount_cents into cat from public.plan_prices where plan_id = pl.id and cycle = coalesce(q.budget_cycle, 'monthly') and active;
  base := jsonb_build_object('plan', pl.code, 'plan_name', pl.name, 'cycle', coalesce(q.budget_cycle, 'monthly'),
    'catalog_cents', cat, 'discount_pct', pol.discount_pct, 'budget_cents', q.budget_cents);
  if q.budget_cents is null then
    return base || jsonb_build_object('status', 'catalog', 'reason', 'Sem orçamento informado: preço de catálogo.', 'suggested_cents', cat);
  end if;
  if q.budget_valid_until is not null and q.budget_valid_until < (app.now() at time zone 'America/Sao_Paulo')::date then
    return base || jsonb_build_object('status', 'needs_review', 'reason', 'Orçamento informado está vencido; não é elegível.');
  end if;
  if q.attachment_path is null and q.budget_valid_until is null then
    return base || jsonb_build_object('status', 'needs_review', 'reason', 'Orçamento sem anexo nem validade: confirme com o solicitante.');
  end if;
  if cat is null then
    return base || jsonb_build_object('status', 'needs_review', 'reason', 'Plano sem preço ativo neste ciclo.');
  end if;
  budget_m := q.budget_cents::numeric / months;
  target_m := floor(budget_m * (1 - pol.discount_pct / 100));
  if cat::numeric / months <= target_m then
    return base || jsonb_build_object('status', 'catalog', 'suggested_cents', cat,
      'reason', format('Preço de catálogo já fica ao menos %s%% abaixo do orçamento.', pol.discount_pct));
  end if;
  sim := app.commercial_sim(e, 'high', q.units, target_m);
  if not (sim ->> 'validated')::boolean then
    return base || jsonb_build_object('status', 'needs_review', 'reason', 'Viabilidade não validada: há custos não informados.',
      'missing', sim -> 'missing');
  end if;
  if target_m < (sim ->> 'floor_month_cents')::numeric then
    return base || jsonb_build_object('status', 'needs_review', 'floor_month_cents', sim -> 'floor_month_cents',
      'reason', 'O piso (custo + margem mínima) impede cobrir o orçamento com desconto.');
  end if;
  return base || jsonb_build_object('status', 'ok', 'suggested_cents', (target_m * months)::int,
    'floor_month_cents', sim -> 'floor_month_cents',
    'reason', format('%s%% abaixo do orçamento, acima do piso. Requer envio pelo responsável.', pol.discount_pct));
end $$;

create function public.quote_suggest(p_quote uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q public.quote_requests;
begin
  perform app.platform_require('quotes');
  select * into q from public.quote_requests where id = p_quote;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  return app.quote_suggestion(q);
end $$;

-- -----------------------------------------------------------------------------
-- Admin Master: leitura ('quotes') e ações ('quote_manage')
-- -----------------------------------------------------------------------------
create function public.quote_list(p_status text default '', p_query text default '', p_page int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform app.platform_require('quotes');
  if coalesce(p_page, 0) < 0 or length(coalesce(p_query, '')) > 120 then raise exception 'Filtros inválidos.' using errcode = '22023'; end if;
  with f as materialized (
    select q.* from public.quote_requests q
     where (coalesce(p_status, '') = '' or q.status = p_status)
       and (coalesce(p_query, '') = '' or strpos(lower(q.org_name || ' ' || q.contact_name || ' ' || q.protocol), lower(p_query)) > 0))
  select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(x order by x ->> 'created_at' desc) from (
      select jsonb_build_object('id', id, 'protocol', protocol, 'org_name', org_name, 'org_kind', org_kind, 'contact_name', contact_name,
        'email', app.platform_mask(email), 'units', units, 'budget_cents', budget_cents, 'budget_cycle', budget_cycle,
        'status', status, 'assigned_to', assigned_to, 'has_attachment', attachment_path is not null, 'created_at', created_at) x
      from f order by created_at desc limit 25 offset coalesce(p_page, 0) * 25) s), '[]'::jsonb))
  into r;
  return r;
end $$;

create function app.proposal_json(p public.quote_proposals) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'version', p.version,
    'status', case when p.status = 'sent' and p.valid_until <= app.now() then 'expired' else p.status end,
    'plan_code', pl.code, 'plan_name', pl.name, 'cycle', p.cycle, 'amount_cents', p.amount_cents, 'limits', p.limits,
    'valid_days', p.valid_days, 'valid_until', p.valid_until, 'conditions', p.conditions, 'protocol', p.protocol,
    'content_sha256', p.content_sha256, 'created_at', p.created_at, 'sent_at', p.sent_at, 'accepted_at', p.accepted_at,
    'withdrawn_at', p.withdrawn_at)
  from public.plans pl where pl.id = p.plan_id
$$;

create function public.quote_detail(p_quote uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q public.quote_requests;
begin
  perform app.platform_require('quotes');
  select * into q from public.quote_requests where id = p_quote;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'quote', to_jsonb(q) - 'ip_hash' - 'attachment_path' || jsonb_build_object('has_attachment', q.attachment_path is not null),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'actor_id', actor_id, 'data', data, 'created_at', created_at) order by id), '[]')
      from public.quote_events where quote_id = q.id),
    'proposals', (select coalesce(jsonb_agg(app.proposal_json(p) order by p.version desc), '[]') from public.quote_proposals p where p.quote_id = q.id),
    'suggestion', app.quote_suggestion(q));
end $$;

-- Caminho do anexo para o backend gerar URL assinada curta (cada acesso fica no histórico).
create function public.quote_attachment_access(p_quote uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.quote_requests;
begin
  perform app.platform_require('quotes');
  select * into q from public.quote_requests where id = p_quote;
  if not found or q.attachment_path is null then raise exception 'Anexo indisponível.' using errcode = 'P0002'; end if;
  perform app.quote_event(q.id, 'attachment_viewed');
  return jsonb_build_object('path', q.attachment_path, 'mime', q.attachment_mime, 'protocol', q.protocol);
end $$;

/**
 * Ações sobre a solicitação ('quote_manage', justificativa obrigatória, histórico em quote_events):
 *   status            data {status: em_analise|encerrada}
 *   assign            data {user_id?}  (vazio = assumir para si)
 *   note              data {}          (a justificativa vira a nota)
 *   proposal_draft    data {plan, cycle, amount_cents, valid_days, conditions, limits? (só sob medida)}
 *   proposal_withdraw data {proposal_id}
 */
create function public.quote_action(p_action text, p_quote uuid, p_data jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.quote_requests; pl public.plans; e public.plan_entitlements; lim jsonb; v int; pid uuid; amt numeric;
begin
  perform app.platform_require('quote_manage');
  if p_reason is null or length(btrim(p_reason)) not between 10 and 1000 or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Dados e justificativa (mín. 10 caracteres) obrigatórios.' using errcode = '22023';
  end if;
  select * into q from public.quote_requests where id = p_quote for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  case p_action
  when 'status' then
    if coalesce(p_data ->> 'status', '') not in ('em_analise', 'encerrada') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
    update public.quote_requests set status = p_data ->> 'status', updated_at = app.now() where id = q.id;
  when 'assign' then
    pid := coalesce(nullif(p_data ->> 'user_id', '')::uuid, auth.uid());
    if not exists (select 1 from public.platform_admins where user_id = pid and active) then
      raise exception 'Responsável precisa ser da equipe da plataforma.' using errcode = '22023';
    end if;
    update public.quote_requests set assigned_to = pid, status = case when status = 'recebida' then 'em_analise' else status end,
      updated_at = app.now() where id = q.id;
  when 'note' then null;
  when 'proposal_draft' then
    select * into pl from public.plans where code = p_data ->> 'plan';
    select * into e from public.plan_entitlements where plan_id = pl.id;
    if pl.id is null or e.plan_id is null then raise exception 'Plano inválido.' using errcode = '22023'; end if;
    amt := (p_data ->> 'amount_cents')::numeric;
    if coalesce(p_data ->> 'cycle', '') not in ('monthly', 'quarterly', 'yearly') or amt is null or amt <= 0 or amt <> floor(amt) then
      raise exception 'Ciclo e preço em centavos inteiros obrigatórios.' using errcode = '22023';
    end if;
    lim := to_jsonb(e) - 'plan_id';
    if p_data ? 'limits' then
      if not pl.is_custom then raise exception 'Limites só podem ser ajustados no plano sob medida.' using errcode = '22023'; end if;
      lim := to_jsonb(jsonb_populate_record(e, p_data -> 'limits')) - 'plan_id';
      if (lim ->> 'max_units')::int <= 0 or (lim ->> 'max_concierges')::int <= 0 or (lim ->> 'ocr_monthly')::int < 0
         or (lim ->> 'whatsapp_monthly')::int < 0 or (lim ->> 'storage_mb')::int <= 0 then
        raise exception 'Limites inválidos.' using errcode = '22023';
      end if;
    end if;
    select coalesce(max(version), 0) + 1 into v from public.quote_proposals where quote_id = q.id;
    insert into public.quote_proposals (quote_id, version, plan_id, cycle, amount_cents, limits, valid_days, conditions, created_by)
    values (q.id, v, pl.id, p_data ->> 'cycle', amt::int, lim, coalesce((p_data ->> 'valid_days')::int, 15),
      btrim(coalesce(p_data ->> 'conditions', '')), auth.uid())
    returning id into pid;
    p_data := p_data || jsonb_build_object('proposal_id', pid, 'version', v);
  when 'proposal_withdraw' then
    update public.quote_proposals set status = 'withdrawn', withdrawn_at = app.now()
     where id = (p_data ->> 'proposal_id')::uuid and quote_id = q.id and status = 'sent' returning id into pid;
    if pid is null then
      delete from public.quote_proposals where id = (p_data ->> 'proposal_id')::uuid and quote_id = q.id and status = 'draft' returning id into pid;
    end if;
    if pid is null then raise exception 'Só proposta em rascunho ou enviada (não aceita) pode ser retirada.' using errcode = 'P0001'; end if;
  else raise exception 'Ação inválida.' using errcode = '22023';
  end case;
  perform app.quote_event(q.id, p_action, p_data || jsonb_build_object('reason', btrim(p_reason)));
  perform app.audit(null, 'quote.' || p_action, 'quote', q.id::text, p_data || jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('ok', true, 'action', p_action, 'quote_id', q.id, 'data', p_data);
end $$;

/**
 * Envio da proposta ('quote_manage'): congela conteúdo, gera protocolo, hash SHA-256 do conteúdo
 * canônico (jsonb normalizado em texto) e token opaco (hash armazenado). Exige viabilidade validada e
 * preço >= piso no cenário alto com as unidades da solicitação. Enfileira e-mail 'quote_sent' só para o
 * e-mail da solicitação (o token fica no payload do outbox até o envio ser aceito; depois é apagado).
 */
create function public.quote_proposal_send(p_proposal uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.quote_proposals; q public.quote_requests; pl public.plans; sim jsonb; v_tok text; v_content jsonb;
  v_proto text; v_until timestamptz; v_months int;
begin
  perform app.platform_require('quote_manage');
  if p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then
    raise exception 'Justificativa (mín. 10 caracteres) obrigatória.' using errcode = '22023';
  end if;
  select * into p from public.quote_proposals where id = p_proposal for update;
  if not found then raise exception 'Proposta não encontrada.' using errcode = 'P0002'; end if;
  if p.status <> 'draft' then raise exception 'Proposta já enviada é imutável. Crie uma nova versão.' using errcode = 'P0001'; end if;
  select * into q from public.quote_requests where id = p.quote_id for update;
  select * into pl from public.plans where id = p.plan_id;
  v_months := app.cycle_months(p.cycle);
  sim := app.commercial_sim(jsonb_populate_record(null::public.plan_entitlements, p.limits), 'high', q.units,
    p.amount_cents::numeric / v_months);
  if not (sim ->> 'validated')::boolean then
    raise exception 'Viabilidade não validada (faltam: %). Proposta não pode ser enviada.',
      (select string_agg(x, ', ') from jsonb_array_elements_text(sim -> 'missing') x) using errcode = 'P0001';
  end if;
  if not (sim ->> 'viable')::boolean then
    raise exception 'Preço abaixo do piso (custo + margem mínima): mínimo % centavos por mês.', sim ->> 'floor_month_cents'
      using errcode = 'P0001';
  end if;
  v_until := app.now() + make_interval(days => p.valid_days);
  v_proto := 'PP-PROP-' || to_char(app.now() at time zone 'America/Sao_Paulo', 'YYYYMMDD') || '-' || upper(substr(replace(p.id::text, '-', ''), 1, 6));
  v_content := jsonb_build_object('protocol', v_proto, 'quote_protocol', q.protocol, 'version', p.version,
    'org_name', q.org_name, 'org_kind', q.org_kind, 'contact_name', q.contact_name, 'units', q.units, 'condos_count', q.condos_count,
    'plan_code', pl.code, 'plan_name', pl.name, 'is_custom', pl.is_custom, 'cycle', p.cycle, 'amount_cents', p.amount_cents,
    'limits', p.limits, 'valid_until', v_until, 'conditions', p.conditions);
  v_tok := app.random_token();
  update public.quote_proposals set status = 'sent', protocol = v_proto, valid_until = v_until, content = v_content,
    content_sha256 = app.sha256_hex(v_content::text), token_hash = app.sha256_hex(v_tok), sent_by = auth.uid(), sent_at = app.now()
   where id = p.id;
  update public.quote_requests set status = 'proposta_enviada', updated_at = app.now() where id = q.id;
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  values (null, 'quote_sent', 'email', q.email, q.id::text || ':' || p.id::text,
    jsonb_build_object('proposal_id', p.id, 'token', v_tok, 'protocol', v_proto, 'valid_until', v_until,
      'amount_cents', p.amount_cents, 'cycle', p.cycle, 'plan_name', pl.name));
  perform app.quote_event(q.id, 'proposal_sent', jsonb_build_object('proposal_id', p.id, 'protocol', v_proto, 'reason', btrim(p_reason),
    'content_sha256', app.sha256_hex(v_content::text)));
  perform app.audit(null, 'quote.proposal_sent', 'quote_proposal', p.id::text,
    jsonb_build_object('reason', btrim(p_reason), 'protocol', v_proto, 'amount_cents', p.amount_cents, 'cycle', p.cycle));
  return jsonb_build_object('ok', true, 'proposal_id', p.id, 'protocol', v_proto, 'valid_until', v_until);
end $$;

-- Dados do PDF para a equipe (inclui rascunho, marcado como tal).
create function public.quote_proposal_pdf_data(p_proposal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.quote_proposals; q public.quote_requests;
begin
  perform app.platform_require('quotes');
  select * into p from public.quote_proposals where id = p_proposal;
  if not found then raise exception 'Proposta não encontrada.' using errcode = 'P0002'; end if;
  select * into q from public.quote_requests where id = p.quote_id;
  return app.proposal_json(p) || jsonb_build_object('org_name', q.org_name, 'contact_name', q.contact_name, 'units', q.units,
    'condos_count', q.condos_count, 'quote_protocol', q.protocol,
    'valid_until', coalesce(p.valid_until, app.now() + make_interval(days => p.valid_days)));
end $$;

-- -----------------------------------------------------------------------------
-- Link público da proposta (token)
-- -----------------------------------------------------------------------------
create function app.proposal_by_token(p_token text) returns public.quote_proposals
language plpgsql stable security definer set search_path = '' as $$
declare p public.quote_proposals;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then raise exception 'Proposta não encontrada.' using errcode = 'P0002'; end if;
  select * into p from public.quote_proposals where token_hash = app.sha256_hex(p_token);
  if not found then raise exception 'Proposta não encontrada.' using errcode = 'P0002'; end if;
  return p;
end $$;

/** Página pública /proposta#token: condições congeladas (sem e-mail/telefone). */
create function public.proposal_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.quote_proposals;
begin
  p := app.proposal_by_token(p_token);
  return (p.content - 'contact_name') || jsonb_build_object('status', case when p.status = 'sent' and p.valid_until <= app.now() then 'expired' else p.status end,
    'accepted_at', p.accepted_at, 'content_sha256', p.content_sha256, 'sent_at', p.sent_at);
end $$;

create function public.proposal_terms(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.quote_proposals; pl public.plans;
begin
  p := app.proposal_by_token(p_token);
  if p.status = 'withdrawn' then raise exception 'Proposta retirada pela Portaria Prime.' using errcode = 'P0001'; end if;
  if p.status = 'expired' or (p.status = 'sent' and p.valid_until <= app.now()) then
    raise exception 'Proposta vencida. Solicite uma nova proposta.' using errcode = 'P0001';
  end if;
  select * into pl from public.plans where id = p.plan_id;
  return jsonb_build_object('proposal_id', p.id, 'quote_id', p.quote_id, 'protocol', p.protocol, 'version', p.version,
    'status', p.status, 'accepted', p.status = 'accepted', 'accepted_at', p.accepted_at,
    'plan_id', p.plan_id, 'plan_code', pl.code, 'plan_name', pl.name, 'is_custom', pl.is_custom,
    'cycle', p.cycle, 'amount_cents', p.amount_cents, 'limits', p.limits, 'valid_until', p.valid_until,
    'conditions', p.conditions, 'org_name', p.content ->> 'org_name', 'org_kind', p.content ->> 'org_kind',
    'units', (p.content ->> 'units')::int, 'condos_count', (p.content ->> 'condos_count')::int, 'content_sha256', p.content_sha256);
end $$;

/** Aceite pelo link: verifica validade, não recalcula nada. Idempotente para proposta já aceita. */
create function public.proposal_accept(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.quote_proposals;
begin
  p := app.proposal_by_token(p_token);
  perform 1 from public.quote_proposals where id = p.id for update;
  select * into p from public.quote_proposals where id = p.id;
  if p.status = 'sent' and p.valid_until > app.now() then
    update public.quote_proposals set status = 'accepted', accepted_at = app.now() where id = p.id;
    update public.quote_requests set status = 'aceita', updated_at = app.now() where id = p.quote_id;
    insert into public.quote_events (quote_id, kind, data) values (p.quote_id, 'proposal_accepted',
      jsonb_build_object('proposal_id', p.id, 'protocol', p.protocol, 'content_sha256', p.content_sha256));
  end if;
  return public.proposal_terms(p_token);
end $$;

-- -----------------------------------------------------------------------------
-- Outbox 'quote_sent' (sem condomínio): regra de destinatário antes da checagem de tenant,
-- tentativa sem tenant, contexto da mensagem e remoção do token após envio aceito.
-- -----------------------------------------------------------------------------
alter table public.notification_attempts alter column tenant_id drop not null;

do $$
declare src text;
begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if src !~ 'quote_sent'' then return app.notification_allowed_ext' then
    src := regexp_replace(src, E'\nbegin\r?\n',E'\nbegin\n  if j.event = ''quote_sent'' then return app.notification_allowed_ext(j); end if;\n');
    if src !~ 'quote_sent'' then return app.notification_allowed_ext' then raise exception 'Não foi possível encadear quote_sent.'; end if;
    execute src;
  end if;
end $$;

-- notification_context original vira app.notification_context_base (grants e corpo preservados).
alter function public.notification_context(uuid) set schema app;
alter function app.notification_context(uuid) rename to notification_context_base;
create function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job;
  if j.event = 'quote_sent' then
    return (select jsonb_build_object('tenant_name', 'Portaria Prime', 'tenant_slug', '', 'timezone', 'America/Sao_Paulo',
      'color_primary', '#101F30', 'quote', jsonb_build_object('contact_name', q.contact_name, 'org_name', q.org_name, 'protocol', q.protocol))
      from public.quote_requests q where q.id::text = split_part(j.ref_id, ':', 1));
  end if;
  return app.notification_context_base(p_job);
end $$;
revoke all on function public.notification_context(uuid) from public, anon, authenticated;
grant execute on function public.notification_context(uuid) to service_role;

create function app.scrub_quote_token() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status in ('accepted', 'delivered', 'disabled') then new.payload := new.payload - 'token'; end if;
  return new;
end $$;
create trigger notification_jobs_scrub_quote_token before update of status on public.notification_jobs
  for each row when (new.event = 'quote_sent') execute function app.scrub_quote_token();

revoke all on function app.quote_event(uuid, text, jsonb), app.quote_suggestion(public.quote_requests),
  app.proposal_json(public.quote_proposals), app.proposal_by_token(text), app.quote_proposal_guard(), app.scrub_quote_token()
  from public, anon, authenticated;
revoke all on function public.quote_submit(jsonb, text), public.quote_attach(uuid, text, text, int, text),
  public.quote_attachments_due(int), public.quote_attachment_purged(uuid, text), public.quote_suggest(uuid),
  public.quote_list(text, text, int), public.quote_detail(uuid), public.quote_attachment_access(uuid),
  public.quote_action(text, uuid, jsonb, text), public.quote_proposal_send(uuid, text), public.quote_proposal_pdf_data(uuid),
  public.proposal_view(text), public.proposal_terms(text), public.proposal_accept(text) from public, anon, authenticated;
grant execute on function public.quote_submit(jsonb, text), public.quote_attach(uuid, text, text, int, text),
  public.quote_attachments_due(int), public.quote_attachment_purged(uuid, text) to service_role;
grant execute on function public.quote_suggest(uuid), public.quote_list(text, text, int), public.quote_detail(uuid),
  public.quote_attachment_access(uuid), public.quote_action(text, uuid, jsonb, text), public.quote_proposal_send(uuid, text),
  public.quote_proposal_pdf_data(uuid) to authenticated;
grant execute on function public.proposal_view(text), public.proposal_terms(text), public.proposal_accept(text)
  to anon, authenticated, service_role;
