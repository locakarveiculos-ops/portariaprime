-- =============================================================================
-- PORTARIA PRIME — landing: funil de conversão sem dados pessoais e suporte consultável.
-- 1. contact_requests ganha origem (landing/ajuda), estado de atendimento e quem tratou.
-- 2. funnel_events: só nome do evento, visitante anônimo aleatório, plano e origem de campanha.
--    Sem nome, e-mail, IP, QR ou user id. Deduplicado por (visitante, evento, dia).
-- 3. funnel_summary(): contagem diária por evento, só para superadmin.
-- =============================================================================

alter table public.contact_requests
  add column if not exists source text not null default 'landing' check (source ~ '^[a-z0-9:_-]{2,80}$'),
  add column if not exists status text not null default 'novo' check (status in ('novo', 'em_atendimento', 'resolvido')),
  add column if not exists handled_by uuid references auth.users(id) on delete set null,
  add column if not exists handled_at timestamptz;

grant update (status) on public.contact_requests to authenticated;
drop policy if exists contact_update on public.contact_requests;
create policy contact_update on public.contact_requests for update to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

create or replace function app.contact_handled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.handled_by := auth.uid();
  new.handled_at := now();
  return new;
end $$;
drop trigger if exists contact_requests_handled on public.contact_requests;
create trigger contact_requests_handled before update of status on public.contact_requests
  for each row execute function app.contact_handled();

create table if not exists public.funnel_events (
  id bigint generated always as identity primary key,
  event text not null check (event in ('landing_view', 'pricing_view', 'cta_trial_click', 'signup_started', 'signup_completed', 'trial_started')),
  visitor text not null check (visitor ~ '^[a-f0-9-]{36}$'),
  day date not null default (now() at time zone 'America/Sao_Paulo')::date,
  plan text check (plan is null or plan ~ '^[a-z-]{2,30}$'),
  utm_source text check (utm_source is null or utm_source ~ '^[A-Za-z0-9._-]{1,60}$'),
  utm_campaign text check (utm_campaign is null or utm_campaign ~ '^[A-Za-z0-9._-]{1,60}$'),
  created_at timestamptz not null default now(),
  unique (visitor, event, day)
);
alter table public.funnel_events enable row level security;
revoke all on public.funnel_events from anon, authenticated;
-- Gravação só pelo backend (/api/funnel); leitura agregada via função abaixo.

create or replace function public.funnel_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_platform_admin(), 'Acesso restrito à administração da plataforma.');
  return coalesce((select jsonb_agg(jsonb_build_object('event', event, 'visitors', n) order by ord)
    from (select event, count(distinct visitor) n,
            array_position(array['landing_view','pricing_view','cta_trial_click','signup_started','signup_completed','trial_started'], event) ord
          from public.funnel_events where day between p_from and p_to group by event) x), '[]'::jsonb);
end $$;

revoke all on function public.funnel_summary(date, date), app.contact_handled() from public, anon, authenticated;
grant execute on function public.funnel_summary(date, date) to authenticated, service_role;
grant all on public.funnel_events to service_role;
