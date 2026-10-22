-- Recebimento automático do totem pareado: grava e avisa na mesma transação.
-- Não converte pré-registros antigos nem atribui o recebimento a um funcionário.
alter table public.device_enrollments add constraint device_enrollments_tenant_id_uq unique (tenant_id, id);
alter table public.packages add column received_device_id uuid,
  add constraint packages_received_device_fk foreign key (tenant_id, received_device_id)
    references public.device_enrollments (tenant_id, id);

create function public.device_receive(
  p_secret_hash text, p_idempotency_key text, p_unit uuid, p_carrier text, p_tracking text, p_courier text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.device_enrollments; v public.packages; v_conc uuid; v_loc uuid; v_replayed boolean := false;
  v_tracking text := nullif(upper(btrim(p_tracking)), '');
  v_carrier text := coalesce(nullif(btrim(p_carrier), ''), 'Outra');
  v_courier text := nullif(btrim(p_courier), '');
begin
  -- Serializa retries do mesmo dispositivo e impede revogação no meio da gravação.
  select * into d from public.device_enrollments where secret_hash = p_secret_hash and status = 'active' for update;
  if not found then raise exception 'Totem não pareado ou revogado.' using errcode = '42501'; end if;
  perform app.require(app.can_operate(d.tenant_id) and app.has_feature(d.tenant_id, 'totem'),
    'Totem indisponível. Procure a portaria.');
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9-]{8,80}$'
     or length(v_tracking) > 80 or length(v_carrier) > 40 or length(v_courier) > 80 then
    raise exception 'Dados de recebimento inválidos.' using errcode = '22023';
  end if;
  perform app.require(exists(select 1 from public.units where tenant_id = d.tenant_id and id = p_unit and active), 'Unidade inválida.');

  select * into v from public.packages where tenant_id = d.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v.received_device_id is distinct from d.id or v.unit_id is distinct from p_unit
       or v.tracking_code is distinct from v_tracking or v.carrier is distinct from v_carrier
       or v.courier_name is distinct from v_courier then
      raise exception 'Identificador de operação já utilizado. Inicie um novo recebimento.' using errcode = '22023';
    end if;
    v_replayed := true;
  else
    v_conc := coalesce(d.concierge_location_id, app.default_concierge(d.tenant_id));
    perform app.require(exists(select 1 from public.concierge_locations where tenant_id = d.tenant_id and id = v_conc and active), 'Portaria inválida.');
    -- Usa somente locais cadastrados; sem mapa de guarda o recebimento não é gravado.
    v_loc := app.pick_storage(d.tenant_id, v_conc, null);
    if v_loc is null then
      raise exception 'Cadastre um local de guarda ativo nesta portaria antes de receber encomendas.' using errcode = 'P0001';
    end if;
    begin
      insert into public.packages (tenant_id, unit_id, concierge_location_id, storage_location_id, status,
        tracking_code, carrier, registered_via, courier_name, idempotency_key, received_at, stored_at, received_device_id)
      values (d.tenant_id, p_unit, v_conc, v_loc, 'ARMAZENADA', v_tracking, v_carrier, 'totem', v_courier,
        p_idempotency_key, app.now(), app.now(), d.id)
      returning * into v;
    exception when unique_violation then
      -- Outro dispositivo/funcionário pode disputar a mesma chave ou rastreio.
      -- Não retorna o registro alheio nem transforma colisão em replay.
      raise exception 'Operação ou rastreio já registrado. Confira antes de receber novamente.' using errcode = 'P0001';
    end;
    insert into public.package_events (tenant_id, package_id, type, data)
    values (d.tenant_id, v.id, 'received', jsonb_build_object('device_id', d.id, 'storage_location_id', v_loc, 'automatic', true));
    insert into public.audit_logs (tenant_id, action, target_type, target_id, data)
    values (d.tenant_id, 'device.package_received', 'package', v.id::text, jsonb_build_object('device_id', d.id));
    perform app.enqueue_package_notifications(v, 'package_received');
  end if;
  return jsonb_build_object('ok', true, 'replayed', v_replayed,
    'storage_code', (select code from public.storage_locations where id = v.storage_location_id),
    'storage_rack', (select rack from public.storage_locations where id = v.storage_location_id),
    'storage_shelf', (select shelf from public.storage_locations where id = v.storage_location_id),
    'concierge_name', (select name from public.concierge_locations where id = v.concierge_location_id));
end $$;
revoke all on function public.device_receive(text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.device_receive(text, text, uuid, text, text, text) to service_role;
