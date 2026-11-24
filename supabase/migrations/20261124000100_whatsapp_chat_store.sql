-- =============================================================================
-- Conversas do WhatsApp do condomínio guardadas no Portaria Prime (a Evolution não grava mensagens novas:
-- DATABASE_SAVE_DATA_NEW_MESSAGE=false é configuração do servidor compartilhado e não muda aqui).
--  * whatsapp_chat_messages: só as mensagens da instância de cada condomínio, recebidas pelo webhook da Evolution
--    (MESSAGES_UPSERT / SEND_MESSAGE) e pelos envios do próprio painel. Sem acesso direto de usuários.
--  * whatsapp_chat_hooks: segredo do webhook por condomínio (header x-pp-secret), gravado pelo servidor.
--  * Retenção: 90 dias (worker). Mídia não é copiada: abre sob demanda pela Evolution, como antes.
-- Aditiva.
-- =============================================================================

create table public.whatsapp_chat_messages (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9]{8,64}$'),
  jid text not null check (jid ~ '^[\w.-]{5,40}@(s\.whatsapp\.net|lid)$'),
  alt_jid text check (alt_jid is null or alt_jid ~ '^[\w.-]{5,40}@(s\.whatsapp\.net|lid)$'),
  from_me boolean not null,
  at timestamptz not null,
  text text not null default '' check (length(text) <= 4000),
  media text check (media is null or media in ('image', 'video', 'audio', 'document')),
  file_name text check (file_name is null or length(file_name) <= 120),
  push_name text check (push_name is null or length(push_name) <= 120),
  created_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index whatsapp_chat_messages_jid_idx on public.whatsapp_chat_messages (tenant_id, jid, at desc);
create index whatsapp_chat_messages_at_idx on public.whatsapp_chat_messages (tenant_id, at desc);
create index whatsapp_chat_messages_created_idx on public.whatsapp_chat_messages (created_at);

create table public.whatsapp_chat_hooks (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  instance text not null unique check (instance ~ '^pp-[0-9a-f]{8}-[0-9a-f]{4}$'),
  secret text not null check (secret ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_chat_messages enable row level security;
alter table public.whatsapp_chat_hooks enable row level security;
revoke all on public.whatsapp_chat_messages, public.whatsapp_chat_hooks from public, anon, authenticated;
grant select, insert, update, delete on public.whatsapp_chat_messages, public.whatsapp_chat_hooks to service_role;

/** Retenção: mensagens com mais de 90 dias (lote). */
create function public.whatsapp_chat_messages_retention(p_limit int default 5000) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.whatsapp_chat_messages where ctid in (
    select ctid from public.whatsapp_chat_messages where at < now() - interval '90 days'
     limit least(greatest(coalesce(p_limit, 5000), 1), 20000));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.whatsapp_chat_messages_retention(int) from public, anon, authenticated;
grant execute on function public.whatsapp_chat_messages_retention(int) to service_role;
