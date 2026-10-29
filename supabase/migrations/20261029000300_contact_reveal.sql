-- Atendimento de contatos (inclui pedidos de ativação piloto 'quiosque:piloto'): a lista do Admin Master
-- continua com e-mail e telefone mascarados. Para retornar ao solicitante, quem pode atender
-- (capacidade 'contact_status': owner, support, finance) consulta o contato completo de UM registro,
-- com justificativa. Cada consulta grava audit_logs (motivo, sem o dado revelado).
-- MFA: app.platform_require exige aal2 quando o usuário tem MFA cadastrado (mesma regra das ações).
create or replace function public.platform_contact_reveal(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.contact_requests;
begin
  perform app.platform_require('contact_status');
  if p_id is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then
    raise exception 'Justificativa obrigatória (10 a 1000 caracteres).' using errcode = '22023';
  end if;
  select * into c from public.contact_requests where id = p_id;
  if not found then raise exception 'Contato não encontrado.' using errcode = 'P0002'; end if;
  perform app.audit(null, 'platform.contact_reveal', 'contact_request', c.id::text,
    jsonb_build_object('reason', btrim(p_reason), 'source', c.source, 'fields', jsonb_build_array('email', 'phone')));
  return jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone);
end $$;

revoke all on function public.platform_contact_reveal(uuid, text) from public, anon, authenticated;
grant execute on function public.platform_contact_reveal(uuid, text) to authenticated;
