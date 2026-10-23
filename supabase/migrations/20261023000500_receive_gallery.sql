-- =============================================================================
-- Galeria de recebimento: até 8 fotos (etiqueta/volume) por encomenda, em ordem.
-- Caminho: <tenant>/packages/<pacote>/label-<n>-<aleatório>.jpg no bucket privado.
-- O servidor valida contagem, posição, dono do objeto e prefixo do tenant/pacote.
-- Foto da entrega continua separada (handover_photo, via deliver_package).
-- Limite de tamanho/tipo: bucket tenant-private (5 MB; jpg/png/webp).
-- =============================================================================

alter table public.package_attachments
  add column if not exists position smallint check (position is null or position between 1 and 8);
create unique index if not exists package_attachments_label_pos_uq
  on public.package_attachments (tenant_id, package_id, position) where kind = 'label_photo' and position is not null;

-- Fotos já existentes ganham posição pela ordem de envio.
update public.package_attachments a set position = x.rn
  from (select id, row_number() over (partition by tenant_id, package_id order by created_at, id) rn
          from public.package_attachments where kind = 'label_photo') x
 where a.id = x.id and a.position is null and x.rn <= 8;

-- Vincula uma foto de recebimento. Idempotente: o mesmo arquivo ou a mesma
-- posição devolvem o vínculo existente (retry após timeout não duplica).
create or replace function public.attach_label_photo(p_tenant uuid, p_package uuid, p_path text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_m text[]; v_pos int; v_n int; a public.package_attachments;
begin
  perform app.require(app.is_staff(p_tenant));
  -- Serializa envios paralelos da mesma encomenda (contagem consistente).
  perform 1 from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda inválida.' using errcode = '22023'; end if;
  v_m := regexp_match(coalesce(p_path, ''), '^' || p_tenant::text || '/packages/' || p_package::text
    || '/(?:label-([1-8])|label_photo)-[A-Za-z0-9-]{8,64}\.(?:jpg|png|webp)$');
  if v_m is null then raise exception 'Arquivo inválido.' using errcode = '22023'; end if;

  perform app.require(exists (select 1 from storage.objects o where o.bucket_id = 'tenant-private' and o.name = p_path and o.owner = auth.uid()),
    'O arquivo não foi enviado. Tente novamente.');
  -- Caminhos novos são JPEG gerado no cliente; Storage registra tamanho e MIME.
  if v_m[1] is not null and not exists (
    select 1 from storage.objects o where o.bucket_id = 'tenant-private' and o.name = p_path
      and o.metadata->>'mimetype' = 'image/jpeg'
      and (o.metadata->>'size')::bigint between 1 and 5242880
      and right(p_path, 4) = '.jpg'
  ) then raise exception 'Foto inválida: use JPEG de até 5 MB.' using errcode = '22023'; end if;

  select * into a from public.package_attachments where object_path = p_path;
  if found then
    if a.tenant_id <> p_tenant or a.package_id <> p_package or a.kind <> 'label_photo' then
      raise exception 'Arquivo inválido.' using errcode = '22023';
    end if;
    return jsonb_build_object('id', a.id, 'position', a.position, 'replayed', true);
  end if;

  v_pos := v_m[1]::int;
  if v_pos is not null then
    select * into a from public.package_attachments
     where tenant_id = p_tenant and package_id = p_package and kind = 'label_photo' and position = v_pos;
    if found then return jsonb_build_object('id', a.id, 'position', a.position, 'replayed', true); end if;
  end if;

  select count(*) into v_n from public.package_attachments where tenant_id = p_tenant and package_id = p_package and kind = 'label_photo';
  if v_n >= 8 then raise exception 'Limite de 8 fotos por encomenda atingido.' using errcode = 'P0001'; end if;
  if v_pos is null then  -- caminho antigo (label_photo-…): primeira posição livre
    select min(g) into v_pos from generate_series(1, 8) g where not exists (select 1 from public.package_attachments
      where tenant_id = p_tenant and package_id = p_package and kind = 'label_photo' and position = g);
  end if;

  insert into public.package_attachments (tenant_id, package_id, kind, object_path, created_by, position)
  values (p_tenant, p_package, 'label_photo', p_path, auth.uid(), v_pos) returning * into a;
  return jsonb_build_object('id', a.id, 'position', a.position, 'replayed', false);
end $$;

-- Mesma função de 0600; foto de recebimento passa pela regra da galeria (limite e dono).
create or replace function public.attach_package_file(p_tenant uuid, p_package uuid, p_kind text, p_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_kind = 'label_photo' then return (public.attach_label_photo(p_tenant, p_package, p_path) ->> 'id')::uuid; end if;
  perform app.require(app.is_staff(p_tenant));
  perform app.require(exists (select 1 from public.packages where tenant_id = p_tenant and id = p_package), 'Encomenda inválida.');
  if p_kind not in ('label_photo', 'signature', 'handover_photo')
     or p_path !~ ('^' || p_tenant::text || '/packages/' || p_package::text || '/[a-z_]+-[A-Za-z0-9-]{8,64}\.(jpg|png|webp)$') then
    raise exception 'Arquivo inválido.' using errcode = '22023';
  end if;
  perform app.require(exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = p_path),
    'O arquivo não foi enviado. Tente novamente.');
  insert into public.package_attachments (tenant_id, package_id, kind, object_path, created_by)
  values (p_tenant, p_package, p_kind, p_path, auth.uid()) returning id into v_id;
  return v_id;
end $$;

revoke all on function public.attach_label_photo(uuid, uuid, text) from public, anon;
grant execute on function public.attach_label_photo(uuid, uuid, text) to authenticated, service_role;
