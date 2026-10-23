-- Novas áreas do Admin Master (comercial, contratos, suporte, carteiras). Leitura sem MFA;
-- ações (sufixo _manage) seguem a exigência de MFA de app.platform_require.
create or replace function public.platform_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r text; caps text[] := '{}';
begin
  select role into r from public.platform_admins where user_id = auth.uid() and active;
  caps := case r
    when 'owner' then array['tenants','users','team','notifications','orders','incidents','audit','contacts','plans','trial_extend','tenant_status','membership_status','team_role','incident_resolve','notification_retry','plan_limits','plan_publish','plan_price','contact_status','courtesy_grant','courtesy_revoke','password_reset',
      'quotes','quote_manage','costs','costs_manage','legal','legal_manage','support','support_manage','organizations','organizations_manage']
    when 'support' then array['tenants','users','notifications','contacts','membership_status','notification_retry','contact_status','password_reset',
      'support','support_manage','quotes']
    when 'finance' then array['tenants','orders','incidents','contacts','plans','trial_extend','incident_resolve','contact_status','courtesy_grant','courtesy_revoke',
      'quotes','quote_manage','costs','costs_manage','legal','organizations']
    when 'auditor' then array['tenants','users','team','notifications','orders','incidents','audit','contacts','plans',
      'quotes','costs','legal','support','organizations']
    else '{}'::text[] end;
  if r is not null then caps := caps || array['overview','trials']; end if;
  return jsonb_build_object('user_id', auth.uid(), 'role', r, 'capabilities', caps);
end $$;

create or replace function app.platform_require(p_capability text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare mfa boolean := false; aal text;
begin
  perform app.require((public.platform_context()->'capabilities') ? p_capability,
    'Acesso restrito à administração da plataforma.');
  if p_capability not in ('overview','tenants','trials','users','team','notifications','orders','incidents','audit','contacts','plans',
      'quotes','costs','legal','support','organizations')
    and to_regclass('auth.mfa_factors') is not null then
    execute 'select exists(select 1 from auth.mfa_factors where user_id=$1 and status=''verified'')' into mfa using auth.uid();
    aal := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'aal', current_setting('request.jwt.claim.aal', true));
    if mfa and aal is distinct from 'aal2' then raise exception 'Confirme o MFA antes desta ação.' using errcode = '42501'; end if;
  end if;
end $$;
revoke all on function app.platform_require(text) from public, anon, authenticated;
