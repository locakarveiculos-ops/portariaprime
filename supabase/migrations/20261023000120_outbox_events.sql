-- Eventos do outbox para os novos fluxos (comercial, contratos, suporte, lembretes de encomenda).
-- Destinatário sempre resolvido pelo servidor. Regras de cada evento abaixo; tabelas das
-- frentes ainda não criadas são consultadas por SQL dinâmico (to_regclass) para manter a ordem
-- das migrations independente.
alter table public.notification_jobs drop constraint if exists notification_jobs_event_check;
alter table public.notification_jobs add constraint notification_jobs_event_check check (event in
  ('package_received', 'package_picked_up', 'invitation', 'trial_reminder', 'billing_order', 'billing_paid', 'ops_alert',
   'access_request', 'access_decision', 'portal_welcome',
   'package_reminder',      -- lembrete de encomenda parada (unidade)
   'quote_sent',            -- proposta comercial enviada pelo responsável (e-mail do solicitante)
   'contract_copy',         -- cópia do contrato aceito (e-mail/WhatsApp do representante)
   'support_reply'));       -- resposta a chamado (quem abriu)

-- Notificações sem condomínio (proposta para prospect) usam tenant_id nulo.
alter table public.notification_jobs alter column tenant_id drop not null;

create or replace function app.notification_allowed_ext(j public.notification_jobs) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare ok boolean := false;
begin
  if j.event = 'package_reminder' then
    -- Mesma regra da chegada: só enquanto a encomenda aguarda retirada.
    return exists(select 1 from public.packages p where p.tenant_id = j.tenant_id and p.id::text = split_part(j.ref_id, ':', 1)
      and app.occupies_space(p.status));
  end if;
  if j.event = 'quote_sent' and to_regclass('public.quote_requests') is not null then
    execute 'select exists(select 1 from public.quote_requests q where q.id::text = split_part($1, '':'', 1) and lower(q.email) = $2)'
      into ok using j.ref_id, j.recipient;
    return j.channel = 'email' and ok;
  end if;
  if j.event = 'contract_copy' and to_regclass('public.contract_acceptances') is not null then
    execute 'select exists(select 1 from public.contract_acceptances a where a.id::text = $1 and a.tenant_id = $2
      and ((lower(a.representative_email) = $3 and $4 = ''email'') or (a.representative_phone = $3 and $4 = ''whatsapp'')))'
      into ok using j.ref_id, j.tenant_id, j.recipient, j.channel;
    return ok;
  end if;
  if j.event = 'support_reply' and to_regclass('public.support_tickets') is not null then
    execute 'select exists(select 1 from public.support_tickets t join auth.users u on u.id = t.opened_by
      where t.id::text = split_part($1, '':'', 1) and (($2 = ''email'' and lower(u.email) = $3) or ($2 = ''push'' and t.opened_by::text = $3)))'
      into ok using j.ref_id, j.channel, j.recipient;
    return ok;
  end if;
  return false;
end $$;
revoke all on function app.notification_allowed_ext(public.notification_jobs) from public, anon, authenticated;

-- Encadeia a regra existente com a extensão (sem reescrever a regra anterior).
do $$
declare src text;
begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if src !~ 'notification_allowed_ext' then
    -- Tolerante a CRLF (checkout com autocrlf) e a variação de espaços.
    src := regexp_replace(src, '\r?\n\s*return false;\s*\r?\nend',E'\n  if j.event in (''package_reminder'',''quote_sent'',''contract_copy'',''support_reply'') then return app.notification_allowed_ext(j); end if;\n  return false;\nend');
    if src !~ 'notification_allowed_ext' then raise exception 'Não foi possível encadear notification_allowed.'; end if;
    execute src;
  end if;
end $$;
