-- =============================================================================
-- Visão geral: indicadores calculados no banco (fuso do condomínio), contrato
-- explícito por indicador. Somente equipe administrativa (admin) do condomínio.
--
--  Estoque agora      : status RECEBIDA/ARMAZENADA (app.occupies_space).
--  Acima do prazo     : estoque agora com received_at <= agora - limite (72 h padrão).
--  Entradas período   : received_at em [início, fim+1) no fuso; exclui PRE_REGISTRADA.
--  Retiradas período  : picked_up_at em [início, fim+1) no fuso.
--  Tempo até retirada : entregas no período; picked_up_at - received_at; descarta
--                       negativos/nulos (contados em "invalid").
--  Variação           : (atual - anterior) / anterior; anterior = 0 -> null ("sem base").
-- =============================================================================

create index if not exists packages_tenant_picked_idx on public.packages (tenant_id, picked_up_at) where picked_up_at is not null;
create index if not exists access_requests_pending_idx on public.access_requests (tenant_id) where status = 'pending';

create or replace function public.dashboard_operation(p_tenant uuid, p_stale_hours int default 72) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_now timestamptz := app.now(); v_day timestamptz; v_stale int := least(greatest(coalesce(p_stale_hours, 72), 1), 720);
begin
  perform app.require(app.is_admin(p_tenant));
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_day := date_trunc('day', v_now at time zone v_tz) at time zone v_tz;
  return jsonb_build_object(
    'timezone', v_tz, 'stale_hours', v_stale, 'as_of', v_now,
    'waiting_now', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status)),
    'stale_now', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status)
                   and received_at <= v_now - make_interval(hours => v_stale)),
    'received_today', (select count(*) from public.packages where tenant_id = p_tenant and status <> 'PRE_REGISTRADA'
                        and received_at >= v_day and received_at < v_day + interval '1 day'),
    'picked_today', (select count(*) from public.packages where tenant_id = p_tenant and picked_up_at >= v_day and picked_up_at < v_day + interval '1 day'),
    -- Ocupação: só locais com capacidade (sempre definida no schema); null se não houver locais.
    'occupancy', (select jsonb_build_object('used', coalesce(sum(o.used), 0), 'capacity', nullif(coalesce(sum(sl.capacity), 0), 0))
                    from public.storage_locations sl
                    cross join lateral (select count(*) used from public.packages p where p.tenant_id = p_tenant
                                         and p.storage_location_id = sl.id and app.occupies_space(p.status)) o
                   where sl.tenant_id = p_tenant and sl.active),
    'unstored_now', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status) and storage_location_id is null),
    'locations', (select coalesce(jsonb_agg(jsonb_build_object('id', sl.id, 'code', sl.code, 'rack', sl.rack, 'shelf', sl.shelf,
                    'capacity', sl.capacity, 'used', o.used, 'is_contingency', sl.is_contingency)
                    order by (o.used::numeric / sl.capacity) desc, sl.sort_order, sl.code), '[]'::jsonb)
                    from public.storage_locations sl
                    cross join lateral (select count(*) used from public.packages p where p.tenant_id = p_tenant
                                         and p.storage_location_id = sl.id and app.occupies_space(p.status)) o
                   where sl.tenant_id = p_tenant and sl.active),
    -- Pendências que exigem ação, por tipo (não somadas sem explicação).
    'attention', jsonb_build_object(
      'access_requests', (select count(*) from public.access_requests where tenant_id = p_tenant and status = 'pending'),
      'stale_packages', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status)
                          and received_at <= v_now - make_interval(hours => v_stale)),
      'near_capacity', (select count(*) from public.storage_locations sl where sl.tenant_id = p_tenant and sl.active
                         and (select count(*) from public.packages p where p.tenant_id = p_tenant and p.storage_location_id = sl.id
                              and app.occupies_space(p.status)) >= sl.capacity * 0.85),
      'notification_failures', (select count(*) from public.notification_jobs where tenant_id = p_tenant and status = 'failed' and attempts >= 5),
      'receipt_failures', (select count(*) from public.receipts where tenant_id = p_tenant and pdf_status = 'failed'),
      'preregistered', (select count(*) from public.packages where tenant_id = p_tenant and status = 'PRE_REGISTRADA')),
    'recent', (select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
      select jsonb_build_object('id', p.id, 'kind', case when p.picked_up_at is not null then 'picked' else 'received' end,
        'at', coalesce(p.picked_up_at, p.received_at), 'unit', concat_ws(' · ', u.block, u.label), 'carrier', p.carrier) x
        from public.packages p left join public.units u on u.id = p.unit_id
       where p.tenant_id = p_tenant and p.status <> 'PRE_REGISTRADA'
       order by coalesce(p.picked_up_at, p.received_at) desc limit 8) r));
end $$;

create or replace function public.dashboard_analysis(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; a timestamptz; b timestamptz; pa timestamptz; v_days int; v_now timestamptz := app.now();
  cur_in int; prev_in int; cur_out int; prev_out int;
begin
  perform app.require(app.is_admin(p_tenant));
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Período inválido (máximo de 1 ano).' using errcode = '22023';
  end if;
  select timezone into v_tz from public.tenants where id = p_tenant;
  a := p_from::timestamp at time zone v_tz;
  b := (p_to + 1)::timestamp at time zone v_tz;
  v_days := p_to - p_from + 1;
  pa := (p_from - v_days)::timestamp at time zone v_tz;   -- período anterior de mesma duração
  select count(*) into cur_in from public.packages where tenant_id = p_tenant and status <> 'PRE_REGISTRADA' and received_at >= a and received_at < b;
  select count(*) into prev_in from public.packages where tenant_id = p_tenant and status <> 'PRE_REGISTRADA' and received_at >= pa and received_at < a;
  select count(*) into cur_out from public.packages where tenant_id = p_tenant and picked_up_at >= a and picked_up_at < b;
  select count(*) into prev_out from public.packages where tenant_id = p_tenant and picked_up_at >= pa and picked_up_at < a;
  return jsonb_build_object(
    'timezone', v_tz, 'from', p_from, 'to', p_to, 'days', v_days,
    'entries', jsonb_build_object('value', cur_in, 'previous', prev_in, 'change', case when prev_in = 0 then null else round((cur_in - prev_in)::numeric / prev_in, 3) end),
    'pickups', jsonb_build_object('value', cur_out, 'previous', prev_out, 'change', case when prev_out = 0 then null else round((cur_out - prev_out)::numeric / prev_out, 3) end),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date,
        'in', (select count(*) from public.packages where tenant_id = p_tenant and status <> 'PRE_REGISTRADA'
                and received_at >= d::timestamp at time zone v_tz and received_at < (d + interval '1 day')::timestamp at time zone v_tz),
        'out', (select count(*) from public.packages where tenant_id = p_tenant
                and picked_up_at >= d::timestamp at time zone v_tz and picked_up_at < (d + interval '1 day')::timestamp at time zone v_tz))
        order by d), '[]'::jsonb) from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d),
    'dwell', (select jsonb_build_object('n', count(*) filter (where h >= 0), 'invalid', count(*) filter (where h is null or h < 0),
        'median_h', round((percentile_cont(0.5) within group (order by h) filter (where h >= 0))::numeric, 1),
        'avg_h', round((avg(h) filter (where h >= 0))::numeric, 1),
        'p90_h', case when count(*) filter (where h >= 0) >= 10 then round((percentile_cont(0.9) within group (order by h) filter (where h >= 0))::numeric, 1) end)
      from (select extract(epoch from picked_up_at - received_at) / 3600 h from public.packages
             where tenant_id = p_tenant and picked_up_at >= a and picked_up_at < b) x),
    'aging_now', (select jsonb_build_object(
        'lt24', count(*) filter (where received_at > v_now - interval '24 hours'),
        'h24_48', count(*) filter (where received_at <= v_now - interval '24 hours' and received_at > v_now - interval '48 hours'),
        'h48_72', count(*) filter (where received_at <= v_now - interval '48 hours' and received_at > v_now - interval '72 hours'),
        'gt72', count(*) filter (where received_at <= v_now - interval '72 hours'))
      from public.packages where tenant_id = p_tenant and app.occupies_space(status)),
    'heatmap', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'hour', hr, 'n', n)), '[]'::jsonb) from (
        select extract(isodow from received_at at time zone v_tz)::int dow, extract(hour from received_at at time zone v_tz)::int hr, count(*) n
          from public.packages where tenant_id = p_tenant and status <> 'PRE_REGISTRADA' and received_at >= a and received_at < b group by 1, 2) h),
    'carriers', (select coalesce(jsonb_agg(jsonb_build_object('carrier', carrier, 'n', n) order by n desc), '[]'::jsonb) from (
        select carrier, count(*) n from public.packages where tenant_id = p_tenant and status <> 'PRE_REGISTRADA' and received_at >= a and received_at < b group by 1) c),
    'exceptions', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'n', n) order by n desc), '[]'::jsonb) from (
        select status, count(*) n from public.packages where tenant_id = p_tenant and status in ('CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA')
           and resolved_at >= a and resolved_at < b group by 1) e),
    'channels', (select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'state', st, 'n', n)), '[]'::jsonb) from (
        select channel, case when status = 'failed' and attempts >= 5 then 'failed_final' when status = 'failed' then 'failed_retryable'
                             when status in ('queued', 'sending', 'hold') then 'pending' else status end st, count(*) n
          from public.notification_jobs where tenant_id = p_tenant and created_at >= a and created_at < b group by 1, 2) ch),
    'adoption', (select jsonb_build_object(
        'units_active', (select count(*) from public.units where tenant_id = p_tenant and active),
        'units_with_resident', (select count(distinct um.unit_id) from public.unit_memberships um join public.units u on u.id = um.unit_id and u.active
                                  join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
                                 where um.tenant_id = p_tenant and um.status = 'active'),
        'pending_requests', (select count(*) from public.access_requests where tenant_id = p_tenant and status = 'pending'))));
end $$;

-- Central de notificações do usuário: paginada, por condomínio, leitura individual.
create or replace function public.my_notifications(p_tenant uuid, p_unread boolean default false, p_before timestamptz default null, p_limit int default 20)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when app.is_member(p_tenant) then jsonb_build_object(
    'unread', (select count(*) from public.notifications where tenant_id = p_tenant and user_id = auth.uid() and read_at is null),
    'items', coalesce((select jsonb_agg(to_jsonb(n) - 'user_id' - 'tenant_id' order by n.created_at desc) from (
        select * from public.notifications where tenant_id = p_tenant and user_id = auth.uid()
          and (not p_unread or read_at is null) and (p_before is null or created_at < p_before)
        order by created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) n), '[]'::jsonb)) end
$$;

revoke all on function public.dashboard_operation(uuid, int), public.dashboard_analysis(uuid, date, date),
  public.my_notifications(uuid, boolean, timestamptz, int) from public, anon;
grant execute on function public.dashboard_operation(uuid, int), public.dashboard_analysis(uuid, date, date),
  public.my_notifications(uuid, boolean, timestamptz, int) to authenticated, service_role;

-- Lembretes do mês grátis também no sino (uma vez por marco D-7/D-3/fim, pois
-- tick_subscription já deduplica por reminders_sent). Substitui a faixa fixa no topo.
create or replace function app.enqueue_billing_email(p_tenant uuid, p_event text, p_ref text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  select p_tenant, p_event, 'email', e, p_ref, p_payload from app.billing_admin_emails(p_tenant) e
  on conflict do nothing;
  if p_event = 'trial_reminder' then
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    select p_tenant, m.user_id, 'trial_reminder',
      case p_payload->>'kind' when 'trial_end' then 'Mês grátis terminou' else 'Mês grátis termina em breve' end,
      'Fim do teste: ' || to_char(((p_payload->>'trial_ends_at')::timestamptz) at time zone t.timezone, 'DD/MM/YYYY')
        || '. Pague a assinatura em Configurações › Plano e assinatura para não bloquear novos recebimentos.'
    from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant and m.status = 'active' and m.role = 'admin' and 'billing' = any (m.permissions);
  end if;
end $$;
