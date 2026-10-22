-- =============================================================================
-- Comprovante de entrega em PDF: layout por condomínio (versionado), geração
-- durável no backend e envio do PDF por e-mail e WhatsApp somente depois que
-- o arquivo existe. PDFs e versões de logo são imutáveis.
-- =============================================================================

-- Layout do comprovante: campos controlados (sem HTML/CSS livre).
create table public.receipt_layouts (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  version int not null default 1,
  template text not null default 'classico' check (template in ('classico', 'moderno', 'compacto')),
  color_primary text not null default '#101F30' check (color_primary ~ '^#[0-9A-Fa-f]{6}$'),
  color_accent text not null default '#C8AB78' check (color_accent ~ '^#[0-9A-Fa-f]{6}$'),
  logo_position text not null default 'left' check (logo_position in ('left', 'center', 'right')),
  logo_size text not null default 'medium' check (logo_size in ('small', 'medium', 'large')),
  title text not null default 'Comprovante de entrega de encomenda' check (length(btrim(title)) between 3 and 80),
  message text check (message is null or length(message) <= 300),
  footer text check (footer is null or length(footer) <= 200),
  address text check (address is null or length(address) <= 160),
  contact text check (contact is null or length(contact) <= 100),
  show_address boolean not null default false,
  show_contact boolean not null default false,
  show_document boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
-- Leitura via RPC; escrita só por save_receipt_layout (versiona e audita).
revoke all on public.receipt_layouts from public, anon, authenticated;

-- Comprovante: snapshot do layout/logo usado e estado do PDF.
alter table public.receipts
  add column layout jsonb,
  add column pdf_status text not null default 'pending' check (pdf_status in ('pending', 'processing', 'ready', 'failed')),
  add column pdf_path text,
  add column pdf_sha256 text,
  add column pdf_bytes int,
  add column pdf_template_version text,
  add column pdf_attempts int not null default 0,
  add column pdf_locked_until timestamptz,
  add column pdf_error text;
-- receipts é append-only; só as colunas do PDF podem mudar, uma vez pronto nunca mais.
create or replace function app.receipt_pdf_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Comprovante é imutável.'; end if;
  if (to_jsonb(new) - array['pdf_status','pdf_path','pdf_sha256','pdf_bytes','pdf_template_version','pdf_attempts','pdf_locked_until','pdf_error'])
     is distinct from (to_jsonb(old) - array['pdf_status','pdf_path','pdf_sha256','pdf_bytes','pdf_template_version','pdf_attempts','pdf_locked_until','pdf_error'])
     or (old.pdf_status = 'ready' and (new.pdf_path is distinct from old.pdf_path or new.pdf_sha256 is distinct from old.pdf_sha256)) then
    raise exception 'Comprovante é imutável.';
  end if;
  return new;
end $$;
drop trigger if exists receipts_append_only on public.receipts;
create trigger receipts_append_only before update or delete on public.receipts
  for each row execute function app.receipt_pdf_only();
create index receipts_pdf_due_idx on public.receipts (pdf_status) where pdf_status in ('pending', 'failed', 'processing');

-- Canais com anexo aguardam o PDF.
alter table public.notification_jobs drop constraint if exists notification_jobs_status_check;
alter table public.notification_jobs add constraint notification_jobs_status_check
  check (status in ('hold', 'queued', 'sending', 'accepted', 'delivered', 'failed', 'disabled'));

-- Logo versionado: arquivo novo a cada envio; o anterior não é apagado (histórico).
create function public.receipt_layout(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'settings') or app.is_staff(p_tenant) then
    coalesce((select to_jsonb(l) - 'tenant_id' - 'updated_by' from public.receipt_layouts l where l.tenant_id = p_tenant),
             jsonb_build_object('version', 0, 'template', 'classico', 'color_primary', '#101F30', 'color_accent', '#C8AB78',
               'logo_position', 'left', 'logo_size', 'medium', 'title', 'Comprovante de entrega de encomenda',
               'show_address', false, 'show_contact', false, 'show_document', false))
    || jsonb_build_object('document', (select document from public.tenants where id = p_tenant)) end
$$;

create function public.save_receipt_layout(p_tenant uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.receipt_layouts; v_before jsonb;
begin
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Somente o administrador com permissão de configurações altera o comprovante.');
  select to_jsonb(l) into v_before from public.receipt_layouts l where tenant_id = p_tenant;
  insert into public.receipt_layouts (tenant_id, template, color_primary, color_accent, logo_position, logo_size, title, message, footer,
    address, contact, show_address, show_contact, show_document, updated_by, updated_at)
  values (p_tenant, coalesce(p->>'template', 'classico'), coalesce(p->>'color_primary', '#101F30'), coalesce(p->>'color_accent', '#C8AB78'),
    coalesce(p->>'logo_position', 'left'), coalesce(p->>'logo_size', 'medium'),
    coalesce(nullif(btrim(p->>'title'), ''), 'Comprovante de entrega de encomenda'),
    nullif(btrim(p->>'message'), ''), nullif(btrim(p->>'footer'), ''), nullif(btrim(p->>'address'), ''), nullif(btrim(p->>'contact'), ''),
    coalesce((p->>'show_address')::boolean, false), coalesce((p->>'show_contact')::boolean, false), coalesce((p->>'show_document')::boolean, false),
    auth.uid(), now())
  on conflict (tenant_id) do update set version = public.receipt_layouts.version + 1,
    template = excluded.template, color_primary = excluded.color_primary, color_accent = excluded.color_accent,
    logo_position = excluded.logo_position, logo_size = excluded.logo_size, title = excluded.title, message = excluded.message,
    footer = excluded.footer, address = excluded.address, contact = excluded.contact, show_address = excluded.show_address,
    show_contact = excluded.show_contact, show_document = excluded.show_document, updated_by = auth.uid(), updated_at = now()
  returning * into v;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (p_tenant, auth.uid(), 'receipt_layout.saved', 'receipt_layout', p_tenant::text,
    jsonb_build_object('version', v.version, 'before', v_before - 'tenant_id' - 'updated_by', 'after', to_jsonb(v) - 'tenant_id' - 'updated_by'));
  return to_jsonb(v) - 'tenant_id' - 'updated_by';
end $$;

-- Snapshot do layout + logo vigentes no momento da entrega.
create function app.receipt_layout_snapshot(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select to_jsonb(l) - 'tenant_id' - 'updated_by' - 'updated_at' from public.receipt_layouts l where l.tenant_id = p_tenant),
           jsonb_build_object('version', 0, 'template', 'classico', 'color_primary', coalesce(b.color_primary, '#101F30'),
             'color_accent', coalesce(b.color_accent, '#C8AB78'), 'logo_position', 'left', 'logo_size', 'medium',
             'title', 'Comprovante de entrega de encomenda', 'show_address', false, 'show_contact', false, 'show_document', false))
    || jsonb_build_object('tenant_name', coalesce(b.display_name, t.name), 'logo_path', b.logo_path,
         'document', t.document, 'timezone', t.timezone)
  from public.tenants t left join public.tenant_branding b on b.tenant_id = t.id where t.id = p_tenant
$$;

-- Avisos de retirada: e-mail/WhatsApp ficam retidos até o PDF ficar pronto.
create or replace function app.enqueue_package_notifications(p_pkg public.packages, p_event text)
returns int language plpgsql security definer set search_path = '' as $$
declare s public.tenant_settings; n int := 0; c record; v_title text; v_body text; v_ref text := p_pkg.id::text;
  v_status text := case when p_event = 'package_picked_up' then 'hold' else 'queued' end;
begin
  select * into s from public.tenant_settings where tenant_id = p_pkg.tenant_id;
  if p_event = 'package_received' then
    v_title := 'Nova encomenda na portaria';
    v_body := 'Há uma encomenda (' || p_pkg.carrier || ') aguardando retirada. Abra o app para ver o QR Code.';
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
    insert into public.notifications (tenant_id, user_id, kind, title, body, package_id)
    select p_pkg.tenant_id, c.user_id, p_event, v_title, v_body, p_pkg.id
     where not exists(select 1 from public.notifications where tenant_id = p_pkg.tenant_id and user_id = c.user_id
                       and package_id = p_pkg.id and kind = p_event);
    if coalesce(s.notify_push, true) then
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'push', c.user_id::text, v_ref, jsonb_build_object('package_id', p_pkg.id)) on conflict do nothing;
      if found then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

-- Grava o snapshot de layout no comprovante criado pela retirada (mesma transação).
create function app.receipt_attach_layout() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.layout := coalesce(new.layout, app.receipt_layout_snapshot(new.tenant_id));
  return new;
end $$;
create trigger receipts_layout_snapshot before insert on public.receipts
  for each row execute function app.receipt_attach_layout();

-- Worker de PDF: reserva com lease, conclui e libera os canais retidos.
create function public.claim_receipt_pdfs(p_limit int default 5) returns setof public.receipts
language sql security definer set search_path = '' as $$
  update public.receipts r set pdf_status = 'processing', pdf_attempts = pdf_attempts + 1, pdf_locked_until = now() + interval '3 minutes'
   where r.id in (select id from public.receipts
                   where (pdf_status = 'pending')
                      or (pdf_status = 'failed' and pdf_attempts < 5)
                      or (pdf_status = 'processing' and pdf_locked_until < now())
                   order by issued_at limit least(greatest(p_limit, 1), 20) for update skip locked)
  returning r.*
$$;

create function public.receipt_pdf_data(p_receipt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'package_id', r.package_id, 'protocol', r.protocol,
    'issued_at', r.issued_at, 'snapshot', r.snapshot, 'layout', coalesce(r.layout, app.receipt_layout_snapshot(r.tenant_id)),
    'recipient_name', p.recipient_name, 'storage_code', sl.code, 'storage_rack', sl.rack, 'storage_shelf', sl.shelf)
  from public.receipts r join public.packages p on p.id = r.package_id
  left join public.storage_locations sl on sl.id = p.storage_location_id
  where r.id = p_receipt
$$;

create function public.complete_receipt_pdf(p_receipt uuid, p_path text, p_sha256 text, p_bytes int, p_version text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.receipts;
begin
  select * into r from public.receipts where id = p_receipt for update;
  if not found or r.pdf_status = 'ready' then return; end if;
  if p_error is not null then
    update public.receipts set pdf_status = 'failed', pdf_error = left(p_error, 300), pdf_locked_until = null where id = r.id;
    if r.pdf_attempts >= 5 then
      perform app.ops_alert(r.tenant_id, 'Comprovante não gerado', 'Um comprovante em PDF falhou. Abra Configurações › Avisos para reprocessar.');
    end if;
    return;
  end if;
  if p_path !~ ('^' || r.tenant_id || '/receipts/' || r.package_id || '/[A-Za-z0-9-]{8,80}\.pdf$') or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF inválido.';
  end if;
  update public.receipts set pdf_status = 'ready', pdf_path = p_path, pdf_sha256 = p_sha256, pdf_bytes = p_bytes,
    pdf_template_version = p_version, pdf_error = null, pdf_locked_until = null where id = r.id;
  -- Só agora os canais com anexo podem sair.
  update public.notification_jobs set status = 'queued', next_attempt_at = now(), updated_at = now()
   where tenant_id = r.tenant_id and ref_id = r.package_id::text and event = 'package_picked_up' and status = 'hold';
end $$;

-- Reprocessar PDF com falha final (mesmo comprovante, mesmo snapshot).
create function public.retry_receipt_pdf(p_tenant uuid, p_receipt uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.is_admin(p_tenant));
  update public.receipts set pdf_status = 'pending', pdf_attempts = 0, pdf_error = null
   where tenant_id = p_tenant and id = p_receipt and pdf_status = 'failed';
  if not found then raise exception 'Somente comprovante com falha pode ser reprocessado.' using errcode = 'P0001'; end if;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id)
  values (p_tenant, auth.uid(), 'receipt.pdf_retry', 'receipt', p_receipt::text);
end $$;

-- Acesso ao PDF: equipe ou morador ATUAL da unidade cuja ligação já existia na entrega
-- (ocupante que entrou depois não vê documentos antigos).
create function public.receipt_pdf_access(p_tenant uuid, p_package uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.receipts; v public.packages;
begin
  select * into v from public.packages where tenant_id = p_tenant and id = p_package;
  select * into r from public.receipts where tenant_id = p_tenant and package_id = p_package;
  if not found or not (app.is_staff(p_tenant) or exists(
      select 1 from public.unit_memberships um where um.tenant_id = p_tenant and um.unit_id = v.unit_id
        and um.user_id = auth.uid() and um.status = 'active' and um.created_at <= r.issued_at)
      and app.is_unit_member(p_tenant, v.unit_id)) then
    raise exception 'Comprovante não encontrado ou sem permissão.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('status', r.pdf_status, 'path', case when r.pdf_status = 'ready' then r.pdf_path end, 'protocol', r.protocol);
end $$;

-- PDFs: bucket privado separado; só o backend grava; leitura por URL assinada emitida pelo backend.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-receipts', 'tenant-receipts', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Logo até 5 MB (o navegador reduz antes; o limite real é aplicado pelo Storage).
update storage.buckets set file_size_limit = 5242880 where id = 'tenant-public';

-- Contexto das mensagens: protocolo, unidade e caminho do PDF pronto (só backend).
create or replace function public.notification_context(p_job uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tenant_id', t.id, 'tenant_name', coalesce(b.display_name, t.name), 'tenant_slug', t.slug, 'timezone', t.timezone,
    'color_primary', b.color_primary, 'logo_path', b.logo_path,
    'whatsapp', (select jsonb_build_object('enabled', i.enabled, 'instance', i.config ->> 'instance')
                   from public.tenant_integrations i where i.tenant_id = t.id and i.provider = 'whatsapp_evolution'),
    'package', (select jsonb_build_object('id', p.id, 'carrier', p.carrier, 'tracking_code', p.tracking_code, 'received_at', p.received_at,
                  'picked_up_at', p.picked_up_at, 'picked_up_by', p.picked_up_by_name, 'storage_code', sl.code,
                  'unit', concat_ws(' ', u.block, u.label), 'protocol', r.protocol,
                  'pdf_path', case when r.pdf_status = 'ready' then r.pdf_path end)
                from public.packages p
                left join public.units u on u.id = p.unit_id
                left join public.storage_locations sl on sl.id = p.storage_location_id
                left join public.receipts r on r.package_id = p.id
               where p.tenant_id = j.tenant_id and p.id = (j.payload ->> 'package_id')::uuid))
  from public.notification_jobs j
  join public.tenants t on t.id = j.tenant_id
  left join public.tenant_branding b on b.tenant_id = t.id
  where j.id = p_job
$$;

-- Diagnóstico inclui comprovantes com problema.
create or replace function public.receipt_pdf_health(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.is_admin(p_tenant) then jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(pdf_status, n), '{}'::jsonb) from (
       select pdf_status, count(*) n from public.receipts where tenant_id = p_tenant and issued_at > now() - interval '7 days' group by 1) x),
    'failed', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'protocol', protocol, 'error', pdf_error, 'attempts', pdf_attempts)), '[]'::jsonb)
       from public.receipts where tenant_id = p_tenant and pdf_status = 'failed')) end
$$;

revoke all on function public.receipt_layout(uuid), public.save_receipt_layout(uuid, jsonb), public.retry_receipt_pdf(uuid, uuid),
  public.receipt_pdf_access(uuid, uuid), public.receipt_pdf_health(uuid), public.claim_receipt_pdfs(int), public.receipt_pdf_data(uuid),
  public.complete_receipt_pdf(uuid, text, text, int, text, text), app.receipt_layout_snapshot(uuid), app.receipt_attach_layout(),
  app.receipt_pdf_only() from public, anon;
revoke all on function public.claim_receipt_pdfs(int), public.receipt_pdf_data(uuid), public.complete_receipt_pdf(uuid, text, text, int, text, text)
  from authenticated;
grant execute on function public.receipt_layout(uuid), public.save_receipt_layout(uuid, jsonb), public.retry_receipt_pdf(uuid, uuid),
  public.receipt_pdf_access(uuid, uuid), public.receipt_pdf_health(uuid) to authenticated, service_role;
grant execute on function public.claim_receipt_pdfs(int), public.receipt_pdf_data(uuid), public.complete_receipt_pdf(uuid, text, text, int, text, text)
  to service_role;
