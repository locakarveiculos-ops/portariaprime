-- Rotina de teste não deve existir como endpoint executável em produção.
-- A implementação antiga desligava triggers/FKs por transação e não garantia
-- exclusão dos objetos físicos do Storage. Restaurar cascade exige auditoria
-- dos resíduos; não tentar apagá-los automaticamente nesta migration.
revoke all on function public.e2e_cleanup(uuid[]) from public, anon, authenticated, service_role;

create or replace function public.e2e_cleanup(p_tenants uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Limpeza E2E desabilitada. Use um ambiente isolado e a ferramenta de testes local.'
    using errcode = '42501';
end $$;
