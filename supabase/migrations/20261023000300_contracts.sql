-- =============================================================================
-- Contratação eletrônica (parte 1): dados legais da contratada e documentos
-- legais versionados (contrato SaaS, termos, privacidade, anexo, política comercial).
-- Nenhum dado legal é semeado: tudo nasce pendente até o Admin Master preencher.
-- Publicar exige dados legais completos, status "approved" e nenhum marcador
-- pendente no texto. Conteúdo publicado/arquivado é imutável.
-- =============================================================================

-- Linha única (id = true). Campos nulos = pendentes.
create table public.legal_entity (
  id boolean primary key default true check (id),
  razao_social text check (razao_social is null or length(btrim(razao_social)) between 3 and 200),
  cnpj text check (cnpj is null or cnpj ~ '^\d{14}$'),
  endereco text check (endereco is null or length(btrim(endereco)) between 10 and 300),
  email_contato text check (email_contato is null or (email_contato = lower(btrim(email_contato)) and email_contato ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  canal_privacidade text check (canal_privacidade is null or length(btrim(canal_privacidade)) between 5 and 200),
  encarregado text check (encarregado is null or length(btrim(encarregado)) between 3 and 200),
  foro text check (foro is null or length(btrim(foro)) between 3 and 120),
  representante text check (representante is null or length(btrim(representante)) between 3 and 200),
  horario_suporte text check (horario_suporte is null or length(btrim(horario_suporte)) between 3 and 200),
  disponibilidade text check (disponibilidade is null or length(btrim(disponibilidade)) between 3 and 500),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into public.legal_entity (id) values (true);

-- Campo -> marcador nos documentos ({{CAMPO}}).
create or replace function app.legal_fields() returns text[]
language sql immutable set search_path = '' as $$
  select array['razao_social','cnpj','endereco','email_contato','canal_privacidade','encarregado','foro','representante','horario_suporte','disponibilidade']
$$;

create or replace function app.legal_missing() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f order by f), '{}') from unnest(app.legal_fields()) f, public.legal_entity e
  where e.id and nullif(btrim(coalesce(to_jsonb(e) ->> f, '')), '') is null
$$;

-- Marcadores que impedem publicação: {{CAMPO}} e trechos ainda não decididos.
create or replace function app.legal_pending_marks(p text) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct m[1]), '{}') from regexp_matches(coalesce(p, ''),
    '(\{\{[A-Z0-9_]+\}\}|\[(?:PENDENTE|A DEFINIR|A VERIFICAR)[^\]]*\])', 'g') m
$$;

-- Preenche {{CAMPO}} com o dado legal (CNPJ formatado).
create or replace function app.legal_fill(p text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare e jsonb; f text; v text; out text := p;
begin
  select to_jsonb(x) into e from public.legal_entity x where x.id;
  foreach f in array app.legal_fields() loop
    v := e ->> f;
    if f = 'cnpj' and v is not null then v := regexp_replace(v, '^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$', '\1.\2.\3/\4-\5'); end if;
    if v is not null then out := replace(out, '{{' || upper(f) || '}}', v); end if;
  end loop;
  return out;
end $$;

create or replace function public.legal_entity_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.platform_require('legal');
  return jsonb_build_object('entity', (select to_jsonb(e) - 'id' from public.legal_entity e where e.id),
    'missing', to_jsonb(app.legal_missing()), 'complete', cardinality(app.legal_missing()) = 0);
end $$;

create or replace function public.platform_legal_entity_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f text; v text;
begin
  perform app.platform_require('legal_manage');
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Dados inválidos.' using errcode = '22023'; end if;
  foreach f in array app.legal_fields() loop
    if p ? f then
      v := nullif(btrim(coalesce(p ->> f, '')), '');
      if f = 'cnpj' then v := app.digits(v); end if;
      if f = 'email_contato' then v := lower(v); end if;
      execute format('update public.legal_entity set %I = $1 where id', f) using v;
    end if;
  end loop;
  update public.legal_entity set updated_by = auth.uid(), updated_at = now() where id;
  perform app.audit(null, 'legal.entity_updated', 'legal_entity', 'singleton',
    jsonb_build_object('fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(p) k where k = any (app.legal_fields()))));
  return public.legal_entity_status();
end $$;

-- -----------------------------------------------------------------------------
-- Documentos legais versionados
-- -----------------------------------------------------------------------------
create table public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('contrato_saas','termos','privacidade','anexo_dados','politica_comercial')),
  version text not null check (version ~ '^[0-9A-Za-z.\-]{1,40}$'),
  status text not null default 'draft' check (status in ('draft','review','approved','published','archived')),
  content_md text not null check (length(content_md) between 20 and 300000),
  content_sha256 text not null,
  summary text check (summary is null or length(summary) <= 2000),          -- resumo em linguagem simples
  change_note text check (change_note is null or length(change_note) <= 1000),
  material_change boolean not null default true,  -- exige novo aceite (aditivo) de quem já contratou
  effective_from timestamptz,
  effective_until timestamptz,
  approved_by uuid, approved_at timestamptz,
  published_by uuid, published_at timestamptz,
  created_by uuid, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, version)
);
create unique index legal_documents_one_published on public.legal_documents (kind) where status = 'published';

-- sha256 sempre do conteúdo armazenado; publicado/arquivado não muda; nada é apagado depois de publicado.
create or replace function app.legal_document_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('published','archived') then raise exception 'Documento publicado não pode ser apagado.' using errcode = '42501'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status in ('published','archived') then
    if new.content_md is distinct from old.content_md or new.kind <> old.kind or new.version <> old.version
       or new.summary is distinct from old.summary or new.published_at is distinct from old.published_at
       or new.effective_from is distinct from old.effective_from
       or not (new.status = old.status or (old.status = 'published' and new.status = 'archived')) then
      raise exception 'Documento publicado é imutável; crie uma nova versão.' using errcode = '42501';
    end if;
  end if;
  -- Única exceção: na publicação, os {{CAMPOS}} são substituídos pelos dados legais (só marcadores mudam).
  if tg_op = 'UPDATE' and old.status <> 'draft' and new.content_md is distinct from old.content_md
     and not (old.status = 'approved' and new.status = 'published') then
    raise exception 'Só rascunho pode ter o texto alterado.' using errcode = '42501';
  end if;
  new.content_sha256 := app.sha256_hex(new.content_md);
  new.updated_at := now();
  return new;
end $$;
create trigger legal_document_guard before insert or update or delete on public.legal_documents
  for each row execute function app.legal_document_guard();

-- Cria/edita rascunho. p_id nulo = nova versão.
create or replace function public.platform_legal_doc_save(p_id uuid, p_kind text, p_version text, p_content text,
  p_summary text default null, p_change_note text default null, p_material boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.legal_documents;
begin
  perform app.platform_require('legal_manage');
  if p_id is null then
    begin
      insert into public.legal_documents (kind, version, content_md, content_sha256, summary, change_note, material_change, created_by)
      values (p_kind, btrim(p_version), p_content, '', p_summary, p_change_note, coalesce(p_material, true), auth.uid()) returning * into d;
    exception when unique_violation then raise exception 'Já existe a versão % deste documento.', p_version using errcode = '23505';
    end;
  else
    update public.legal_documents set content_md = p_content, summary = p_summary, change_note = p_change_note,
      material_change = coalesce(p_material, true) where id = p_id and status = 'draft' returning * into d;
    if not found then raise exception 'Só rascunho pode ser editado.' using errcode = 'P0001'; end if;
  end if;
  perform app.audit(null, 'legal.document_saved', 'legal_document', d.id::text,
    jsonb_build_object('kind', d.kind, 'version', d.version, 'sha256', d.content_sha256));
  return jsonb_build_object('id', d.id, 'status', d.status, 'sha256', d.content_sha256);
end $$;

-- draft -> review -> approved -> published (e volta para draft antes de publicar).
-- Publicar: dados legais completos, status approved e nenhum marcador pendente
-- depois de preencher os {{CAMPOS}}. A versão anterior publicada vira archived.
create or replace function public.platform_legal_doc_transition(p_id uuid, p_to text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.legal_documents; v_now timestamptz := app.now(); v_filled text; v_marks text[];
begin
  perform app.platform_require('legal_manage');
  select * into d from public.legal_documents where id = p_id for update;
  if not found then raise exception 'Documento não encontrado.' using errcode = 'P0002'; end if;
  if not ((d.status = 'draft' and p_to = 'review') or (d.status = 'review' and p_to in ('approved','draft'))
       or (d.status = 'approved' and p_to in ('published','draft'))) then
    raise exception 'Transição % -> % não permitida.', d.status, p_to using errcode = 'P0001';
  end if;
  if p_to = 'published' then
    if cardinality(app.legal_missing()) > 0 then
      raise exception 'Dados legais da contratada incompletos: %.', array_to_string(app.legal_missing(), ', ') using errcode = 'P0001';
    end if;
    v_filled := app.legal_fill(d.content_md);
    v_marks := app.legal_pending_marks(v_filled);
    if cardinality(v_marks) > 0 then
      raise exception 'O texto ainda tem campos pendentes: %.', array_to_string(v_marks, ', ') using errcode = 'P0001';
    end if;
    lock table public.legal_documents in share row exclusive mode;
    update public.legal_documents set status = 'archived', effective_until = v_now where kind = d.kind and status = 'published';
    -- Texto final com os dados legais preenchidos; o sha passa a ser o do texto exibido ao cliente.
    update public.legal_documents set content_md = v_filled, status = 'published', effective_from = v_now, published_by = auth.uid(), published_at = v_now,
      approved_by = coalesce(d.approved_by, auth.uid()), approved_at = coalesce(d.approved_at, v_now) where id = d.id returning * into d;
  elsif p_to = 'approved' then
    update public.legal_documents set status = p_to, approved_by = auth.uid(), approved_at = v_now where id = d.id returning * into d;
  else
    update public.legal_documents set status = p_to, approved_by = null, approved_at = null where id = d.id returning * into d;
  end if;
  perform app.audit(null, 'legal.document_' || p_to, 'legal_document', d.id::text,
    jsonb_build_object('kind', d.kind, 'version', d.version, 'sha256', d.content_sha256, 'note', left(p_note, 500)));
  return jsonb_build_object('id', d.id, 'status', d.status, 'sha256', d.content_sha256);
end $$;

-- Versão publicada vigente (pública: páginas /termos, /privacidade, /contrato).
create or replace function public.legal_document_current(p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', id, 'kind', kind, 'version', version, 'content_md', content_md, 'sha256', content_sha256,
    'summary', summary, 'effective_from', effective_from, 'published_at', published_at)
  from public.legal_documents where kind = p_kind and status = 'published'
$$;

-- Lista para o Admin Master (todas as versões, com texto para prévia/diff).
create or replace function public.platform_legal_docs() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.platform_require('legal');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'version', version, 'status', status,
    'content_md', content_md, 'sha256', content_sha256, 'summary', summary, 'change_note', change_note,
    'material_change', material_change, 'pending_marks', to_jsonb(app.legal_pending_marks(app.legal_fill(content_md))),
    'effective_from', effective_from, 'effective_until', effective_until, 'approved_at', approved_at,
    'published_at', published_at, 'created_at', created_at) order by kind, created_at desc) from public.legal_documents), '[]');
end $$;

alter table public.legal_entity enable row level security;
alter table public.legal_documents enable row level security;
revoke all on public.legal_entity, public.legal_documents from public, anon, authenticated;
grant all on public.legal_entity, public.legal_documents to service_role;

revoke all on function app.legal_fields(), app.legal_missing(), app.legal_pending_marks(text), app.legal_fill(text),
  app.legal_document_guard() from public, anon, authenticated;
revoke all on function public.legal_entity_status(), public.platform_legal_entity_set(jsonb),
  public.platform_legal_doc_save(uuid, text, text, text, text, text, boolean), public.platform_legal_doc_transition(uuid, text, text),
  public.legal_document_current(text), public.platform_legal_docs() from public;
grant execute on function public.legal_entity_status(), public.platform_legal_entity_set(jsonb),
  public.platform_legal_doc_save(uuid, text, text, text, text, text, boolean), public.platform_legal_doc_transition(uuid, text, text),
  public.platform_legal_docs() to authenticated, service_role;
grant execute on function public.legal_document_current(text) to anon, authenticated, service_role;
