-- Vídeo único de treinamento, para todos os condomínios, após boas-vindas aceitas pelo WhatsApp.
-- Job separado: a falha do vídeo não repete o texto. Sem varredura retroativa de aprovações antigas.
do $$ declare def text; begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid='public.notification_jobs'::regclass and conname='notification_jobs_event_check';
  if def is null then raise exception 'CHECK de eventos não encontrado'; end if;
  if position('resident_training' in def)=0 then
    alter table public.notification_jobs drop constraint notification_jobs_event_check;
    execute 'alter table public.notification_jobs add constraint notification_jobs_event_check CHECK (event = ''resident_training'' OR (' || substr(def,7) || '))';
  end if;
end $$;

create function app.resident_training_allowed(j public.notification_jobs) returns boolean
language sql stable security definer set search_path='' as $$
  select j.channel='whatsapp' and j.payload->'approved'='true'::jsonb and exists (
    select 1 from public.access_requests r
    join public.tenants t on t.id=r.tenant_id and t.status='active'
    join public.tenant_memberships m on m.tenant_id=r.tenant_id and m.user_id=r.user_id and m.role='morador' and m.status='active'
    join public.unit_memberships um on um.tenant_id=r.tenant_id and um.unit_id=r.unit_id and um.user_id=r.user_id and um.status='active'
    where r.id::text=j.ref_id and r.tenant_id=j.tenant_id and r.status='approved' and r.phone=j.recipient
      and exists (select 1 from public.notification_jobs source where source.tenant_id=j.tenant_id
        and source.ref_id=j.ref_id and source.recipient=j.recipient and source.channel='whatsapp'
        and source.event='access_decision' and source.payload->'approved'='true'::jsonb
        and source.status in ('accepted','delivered')))
$$;
revoke all on function app.resident_training_allowed(public.notification_jobs) from public,anon,authenticated;

-- Preserva a cadeia atual (cadastros, contratos, convites e encomendas) e acrescenta apenas este evento.
do $$ declare src text; begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if position('resident_training_allowed' in src)=0 then
    src := regexp_replace(src, '(begin\s*\r?\n)', E'\\1  if j.event = ''resident_training'' then return app.resident_training_allowed(j); end if;\n');
    if position('resident_training_allowed' in src)=0 then raise exception 'Não foi possível encadear autorização do treinamento'; end if;
    execute src;
  end if;
end $$;

create function app.enqueue_resident_training() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.event='access_decision' and new.channel='whatsapp' and new.payload->'approved'='true'::jsonb
     and new.status='accepted' and old.status is distinct from 'accepted' then
    insert into public.notification_jobs(tenant_id,event,channel,recipient,ref_id,payload,next_attempt_at)
    values(new.tenant_id,'resident_training','whatsapp',new.recipient,new.ref_id,
      jsonb_build_object('approved',true),now()+interval '10 seconds')
    on conflict do nothing;
  end if;
  return null;
end $$;
revoke all on function app.enqueue_resident_training() from public,anon,authenticated;
create trigger notification_training_after_welcome after update of status on public.notification_jobs
  for each row execute function app.enqueue_resident_training();

-- Contexto base (condomínio e integração) já funciona para qualquer evento. Só acrescenta nome/unidade do morador.
alter function public.notification_context(uuid) rename to notification_context_before_training;
alter function public.notification_context_before_training(uuid) set schema app;
create function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v jsonb := app.notification_context_before_training(p_job); j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id=p_job;
  if j.event='resident_training' then
    v := coalesce(v,'{}'::jsonb) || jsonb_build_object('resident',(
      select jsonb_build_object('name',split_part(btrim(r.full_name),' ',1),'unit',concat_ws(' ',r.block_text,r.unit_text))
      from public.access_requests r where r.id::text=j.ref_id and r.tenant_id=j.tenant_id));
  end if;
  return v;
end $$;
revoke all on function public.notification_context(uuid),app.notification_context_before_training(uuid) from public,anon,authenticated;
grant execute on function public.notification_context(uuid),app.notification_context_before_training(uuid) to service_role;
