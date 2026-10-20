-- =============================================================================
-- PORTARIA PRIME — 1300: limpeza de condomínios de teste E2E (somente service_role)
-- Só apaga condomínios cujo slug começa com "e2e" (criados pelo teste ponta a ponta).
-- Desliga temporariamente as travas append-only apenas nesta transação.
-- =============================================================================
create or replace function public.e2e_cleanup(p_tenants uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  select array_agg(id) into v_ids from public.tenants where id = any (p_tenants) and slug like 'e2e%';
  if v_ids is null then return 0; end if;
  set local session_replication_role = replica; -- ignora triggers append-only nesta transação
  delete from storage.objects where bucket_id in ('tenant-private', 'tenant-public') and split_part(name, '/', 1) = any (select unnest(v_ids)::text);
  delete from public.notification_attempts where tenant_id = any (v_ids);
  delete from public.notification_jobs where tenant_id = any (v_ids);
  delete from public.notifications where tenant_id = any (v_ids);
  delete from public.push_subscriptions where tenant_id = any (v_ids);
  delete from public.receipts where tenant_id = any (v_ids);
  delete from public.pickup_tokens where tenant_id = any (v_ids);
  delete from public.package_attachments where tenant_id = any (v_ids);
  delete from public.package_events where tenant_id = any (v_ids);
  delete from public.packages where tenant_id = any (v_ids);
  delete from public.payments where tenant_id = any (v_ids);
  delete from public.billing_incidents where tenant_id = any (v_ids);
  delete from public.billing_orders where tenant_id = any (v_ids);
  delete from public.subscriptions where tenant_id = any (v_ids);
  delete from public.audit_logs where tenant_id = any (v_ids);
  delete from public.trial_eligibility where tenant_id = any (v_ids);
  delete from public.tenants where id = any (v_ids); -- cascata: unidades, vínculos, convites, marca etc.
  return array_length(v_ids, 1);
end $$;
revoke all on function public.e2e_cleanup(uuid[]) from public, anon, authenticated;
grant execute on function public.e2e_cleanup(uuid[]) to service_role;
