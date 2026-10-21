-- Uma resposta externa atrasada não pode ressuscitar pedido cancelado/pago/em revisão.
create or replace function public.finish_checkout_link(p_order uuid, p_attempt uuid, p_url text, p_state text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_state not in ('ready', 'failed', 'ambiguous') then
    raise exception 'Estado inválido.' using errcode = '22023';
  end if;
  if p_state = 'ready' and (p_url is null or p_url !~ '^https://') then
    raise exception 'URL inválida.' using errcode = '22023';
  end if;
  update public.billing_orders set link_state = p_state,
    checkout_url = case when p_state = 'ready' then p_url else checkout_url end,
    status = case when p_state = 'failed' then 'link_failed' else 'pending' end,
    updated_at = now()
  where id = p_order and link_attempt_id = p_attempt and link_state = 'creating'
    and status in ('pending', 'link_failed');
  return found;
end $$;

revoke all on function public.finish_checkout_link(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.finish_checkout_link(uuid, uuid, text, text) to service_role;
