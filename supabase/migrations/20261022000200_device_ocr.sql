-- OCR autorizado pelo dispositivo pareado, sem sessão de funcionário.
-- Limite persistente por dispositivo + franquia mensal compartilhada do condomínio.
alter table public.device_enrollments add column ocr_last_requested_at timestamptz;

create function public.device_consume_ocr(p_secret_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare d public.device_enrollments;
begin
  select * into d from public.device_enrollments where secret_hash = p_secret_hash and status = 'active' for update;
  if not found then raise exception 'Totem não pareado ou revogado.' using errcode = '42501'; end if;
  perform app.require(app.can_operate(d.tenant_id) and app.has_feature(d.tenant_id, 'totem'), 'Totem indisponível. Procure a portaria.');
  if not app.has_feature(d.tenant_id, 'ocr') then return false; end if;
  if d.ocr_last_requested_at > clock_timestamp() - interval '10 seconds' then
    raise exception 'Aguarde dez segundos antes de ler outra etiqueta.' using errcode = 'P0001';
  end if;
  update public.device_enrollments set ocr_last_requested_at = clock_timestamp() where id = d.id;
  return app.consume_usage(d.tenant_id, 'ocr', (app.entitlements(d.tenant_id)).ocr_monthly);
end $$;
revoke all on function public.device_consume_ocr(text) from public, anon, authenticated;
grant execute on function public.device_consume_ocr(text) to service_role;
