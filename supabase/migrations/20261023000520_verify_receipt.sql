-- =============================================================================
-- Validação pública de comprovante de entrega por código opaco.
--  - Cada comprovante NOVO recebe um código aleatório de 80 bits (20 hex, em
--    grupos de 4), impresso no PDF junto da URL /validar. Comprovantes antigos
--    ficam sem código (os PDFs já emitidos não são regenerados).
--  - Não enumerável: não deriva de protocolo, data ou id.
--  - public.verify_receipt(p_code) é liberada para anon e devolve só: válido,
--    data/hora da entrega e nome de exibição do condomínio. Nada de nome de
--    quem retirou, unidade, foto, assinatura ou protocolo.
--  - Abuso: resposta uniforme ({valid:false}) para formato inválido ou código
--    inexistente, custo constante (uma busca por índice único) e espaço de 2^80
--    códigos — força bruta é inviável sem precisar de contador por IP.
-- =============================================================================

alter table public.receipts add column if not exists verify_code text;
create unique index if not exists receipts_verify_code_uq on public.receipts (verify_code) where verify_code is not null;

create or replace function app.receipt_verify_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- md5 de 244 bits aleatórios: 20 hex uniformes (os uuid v4 têm nibbles fixos).
  new.verify_code := upper(regexp_replace(left(md5(app.random_token()), 20), '(.{4})(?!$)', '\1-', 'g'));
  return new;
end $$;
drop trigger if exists receipts_verify_code on public.receipts;
create trigger receipts_verify_code before insert on public.receipts
  for each row execute function app.receipt_verify_code();

create or replace function public.verify_receipt(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_code text := upper(regexp_replace(coalesce(left(p_code, 64), ''), '[^0-9A-Fa-f]', '', 'g')); r record;
begin
  if length(v_code) <> 20 then return jsonb_build_object('valid', false); end if;
  select rc.picked_up_at, coalesce(b.display_name, t.name) tenant_name into r
    from public.receipts x
    join public.packages rc on rc.id = x.package_id and rc.tenant_id = x.tenant_id
    join public.tenants t on t.id = x.tenant_id
    left join public.tenant_branding b on b.tenant_id = x.tenant_id
   where x.verify_code = regexp_replace(v_code, '(.{4})(?!$)', '\1-', 'g');
  if not found then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object('valid', true, 'delivered_at', r.picked_up_at, 'tenant_name', r.tenant_name);
end $$;

-- Dados do PDF (cópia da versão de 20261022000500) + código de verificação.
create or replace function public.receipt_pdf_data(p_receipt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'package_id', r.package_id, 'protocol', r.protocol,
    'issued_at', r.issued_at, 'snapshot', r.snapshot, 'layout', coalesce(r.layout, app.receipt_layout_snapshot(r.tenant_id)),
    'recipient_name', p.recipient_name, 'storage_code', sl.code, 'storage_rack', sl.rack, 'storage_shelf', sl.shelf,
    'verify_code', r.verify_code)
  from public.receipts r join public.packages p on p.id = r.package_id
  left join public.storage_locations sl on sl.id = p.storage_location_id
  where r.id = p_receipt
$$;

revoke all on function app.receipt_verify_code(), public.verify_receipt(text) from public;
grant execute on function public.verify_receipt(text) to anon, authenticated, service_role;
