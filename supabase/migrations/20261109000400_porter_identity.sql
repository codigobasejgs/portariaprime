-- Cadastro biométrico opt-in: referência ORIGINAL imutável, sem acesso pelo cliente.
-- ponytail: vínculos anteriores sem identidade mantêm autorização legada; migração gradual
-- evita parar portarias. Identidades cadastradas exigem turno válido em TODA operação is_staff.
create table public.porter_links (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants on delete cascade,
 token_hash text not null unique, approval boolean not null default true,
 expires_at timestamptz not null, max_uses int not null check(max_uses between 1 and 100), uses int not null default 0,
 revoked_at timestamptz, created_by uuid not null references auth.users, created_at timestamptz not null default app.now()
);
create table public.porter_terms (
 version text primary key, content text not null, hash text not null
);
insert into public.porter_terms values ('2026-11-09.1',
 'Autorizo especificamente o tratamento da minha fotografia e do meu descritor facial (dados pessoais sensíveis) para controle de acesso da portaria e auditoria dos turnos pelo condomínio, controlador dos dados, na plataforma Portaria Prime. A primeira captura será a referência fixa: não será substituída por fotos de login. Fotos de login serão eliminadas após 90 dias; referência e descritor serão eliminados ao encerrar meu vínculo. Somente administradores autorizados a gerir a equipe poderão consultar as fotos, com registro de acesso. O reconhecimento pode errar e não garante prova de vida contra vídeos ou adulteração do navegador. Posso solicitar ao síndico informação, acesso, correção dos dados cadastrais, revogação deste consentimento e alternativa de acesso sem biometria. A revogação encerra este cadastro biométrico. A base legal e a liberdade deste consentimento em contexto de trabalho devem ser avaliadas pelo controlador nos termos do art. 11 da LGPD.', '');
update public.porter_terms set hash = app.sha256_hex(version || E'\n' || content);
create trigger porter_terms_immutable before update or delete on public.porter_terms for each row execute function app.block_mutation();
create table public.porter_consents (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null, user_id uuid not null,
 version text not null references public.porter_terms, hash text not null, accepted_at timestamptz not null default app.now(),
 ip text not null, user_agent text not null
);
create trigger porter_consents_immutable before update or delete on public.porter_consents for each row execute function app.block_mutation();
create table public.porter_identities (
 tenant_id uuid not null references public.tenants on delete cascade, user_id uuid not null references auth.users on delete cascade,
 full_name text not null, document_type text not null check(document_type in ('CPF','RG','CNH')),
 document_hash text not null, document_masked text not null, phone text not null,
 enrolled_at timestamptz not null default app.now(),
 -- Janela aberta SOMENTE por porter_reference_reset (síndico, auditado): próxima captura vira a nova referência.
 reenroll_until timestamptz,
 primary key(tenant_id,user_id), unique(tenant_id,document_hash)
);
create table public.porter_faces (
 tenant_id uuid not null, user_id uuid not null, descriptor double precision[] not null,
 photo_path text not null, primary key(tenant_id,user_id),
 foreign key(tenant_id,user_id) references public.porter_identities on delete cascade
);
create trigger porter_faces_immutable before update on public.porter_faces for each row execute function app.block_mutation();
create table public.porter_attempts (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants on delete cascade,
 user_id uuid references auth.users on delete set null, document_hash text not null,
 method text not null check(method in ('face','password','legacy')), result text not null,
 distance double precision, photo_path text, created_at timestamptz not null default app.now()
);
create index porter_attempts_lock on public.porter_attempts(tenant_id,document_hash,created_at desc);
create table public.porter_shifts (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants on delete cascade,
 user_id uuid not null references auth.users on delete cascade, session_id text not null,
 started_at timestamptz not null default app.now(), expires_at timestamptz not null default app.now()+interval '12 hours',
 ended_at timestamptz, method text not null, check(expires_at = started_at+interval '12 hours')
);
create index porter_shifts_active on public.porter_shifts(tenant_id,user_id,session_id,expires_at) where ended_at is null;
-- Deleção de objetos é confirmada pelo worker; falhas mantêm a fila para retry.
create table public.porter_photo_deletions(path text primary key, queued_at timestamptz not null default app.now());

create function app.porter_descriptor_valid(v double precision[]) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(array_ndims(v)=1 and array_lower(v,1)=1 and cardinality(v)=128
   and not exists(select 1 from unnest(v) x where x is null or not (x between -2 and 2))
   and (select sum(x*x) from unnest(v) x) between 0.01 and 25,false)
$$;
-- face-api 1.7.15 / face_recognition_model: Euclidean, NOT cosine. 0.45 is conservative,
-- NOT a measured FAR claim. LFW accuracy at 0.6 is not deployment FAR/FRR calibration.
create function app.porter_distance(a double precision[], b double precision[]) returns double precision
language sql immutable set search_path='' as $$
 select case when app.porter_descriptor_valid(a) and app.porter_descriptor_valid(b)
 then (select sqrt(sum((a[i]-b[i])^2)) from generate_series(1,128) i) else null end
$$;
create function app.porter_session() returns text language sql stable set search_path='' as $$
 select nullif(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id','')
$$;
create or replace function app.is_staff(p_tenant uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select app.is_admin(p_tenant) or (app.has_role(p_tenant,array['porteiro']) and (
   not exists(select 1 from public.porter_identities where tenant_id=p_tenant and user_id=auth.uid())
   or exists(select 1 from public.porter_shifts where tenant_id=p_tenant and user_id=auth.uid()
     and session_id=app.porter_session() and ended_at is null and expires_at>app.now())))
$$;
create or replace function app.can_read_package_file(p_name text) returns boolean
language sql stable security definer set search_path='' as $$
 select split_part(p_name,'/',2) not in ('staff-face','couriers') and (app.is_staff(app.path_tenant(p_name)) or exists (
 select 1 from public.packages p where p.tenant_id=app.path_tenant(p_name) and p.id=app.path_package(p_name)
 and p.status<>'PRE_REGISTRADA' and app.is_unit_member(p.tenant_id,p.unit_id)))
$$;
create function public.porter_link_create(p_tenant uuid,p_approval boolean default true,p_hours int default 24,p_uses int default 1) returns jsonb
language plpgsql security definer set search_path='' as $$
declare token text:=app.random_token(); v public.porter_links;
begin
 perform app.require(app.has_perm(p_tenant,'team')); perform app.mdm_require_recent_auth();
 perform app.require(p_hours between 1 and 168 and p_uses between 1 and 100,'Prazo ou quantidade inválidos.');
 insert into public.porter_links(tenant_id,token_hash,approval,expires_at,max_uses,created_by)
 values(p_tenant,app.sha256_hex(token),p_approval,app.now()+make_interval(hours=>p_hours),p_uses,auth.uid()) returning * into v;
 perform app.audit(p_tenant,'porter.link_created','porter_link',v.id::text);
 return jsonb_build_object('id',v.id,'token',token,'expires_at',v.expires_at,'slug',(select slug from public.tenants where id=p_tenant));
end $$;
create function public.porter_link_revoke(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare t uuid;
begin
 select tenant_id into t from public.porter_links where id=p_id;
 perform app.require(app.has_perm(t,'team'));
 update public.porter_links set revoked_at=app.now() where id=p_id;
 perform app.audit(t,'porter.link_revoked','porter_link',p_id::text);
end $$;
create function public.porter_signup_preview(p_slug text,p_token text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare l public.porter_links; t public.tenants;
begin
 select * into t from public.tenants where slug=p_slug and status='active';
 select * into l from public.porter_links where tenant_id=t.id and token_hash=app.sha256_hex(p_token)
 and revoked_at is null and expires_at>app.now() and uses<max_uses;
 perform app.require(l.id is not null,'Link inválido, expirado ou utilizado.');
 return jsonb_build_object('tenant_id',t.id,'name',t.name,'approval',l.approval,'term',(select to_jsonb(x) from public.porter_terms x where version='2026-11-09.1'));
end $$;
-- Somente API: todas as entradas foram validadas antes da criação Auth; consumo atômico do link.
create function public.porter_signup_finish(p_slug text,p_token text,p_user uuid,p_data jsonb,p_descriptor double precision[],p_photo text,p_hash text,p_ip text,p_ua text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare l public.porter_links; t uuid; term public.porter_terms; v_status text;
begin
 select id into t from public.tenants where slug=p_slug and status='active';
 select * into l from public.porter_links where tenant_id=t and token_hash=app.sha256_hex(p_token) for update;
 perform app.require(l.id is not null and l.revoked_at is null and l.expires_at>app.now() and l.uses<l.max_uses,'Link inválido, expirado ou utilizado.');
 perform app.require(exists(select 1 from public.tenant_memberships where tenant_id=t and user_id=l.created_by and role='admin' and status='active' and 'team'=any(permissions)),'Link não autorizado.');
 select * into term from public.porter_terms where version='2026-11-09.1';
 perform app.require(p_hash is not null and p_hash=term.hash,'Leia e aceite o termo biométrico vigente.');
 perform app.require(app.porter_descriptor_valid(p_descriptor),'Referência facial inválida.');
 perform app.require(p_photo like t::text||'/staff-face/%' and length(p_data->>'fullName') between 2 and 120
 and p_data->>'documentHash' ~ '^[a-f0-9]{64}$','Cadastro inválido.');
 v_status:=case when l.approval then 'pending' else 'active' end;
 insert into public.tenant_memberships(tenant_id,user_id,role,status) values(t,p_user,'porteiro',v_status);
 insert into public.porter_identities(tenant_id,user_id,full_name,document_type,document_hash,document_masked,phone)
 values(t,p_user,p_data->>'fullName',p_data->>'documentType',p_data->>'documentHash',p_data->>'documentMasked',p_data->>'phone');
 insert into public.porter_faces values(t,p_user,p_descriptor,p_photo);
 insert into public.porter_consents(tenant_id,user_id,version,hash,ip,user_agent) values(t,p_user,term.version,term.hash,left(p_ip,128),left(p_ua,512));
 update public.porter_links set uses=uses+1 where id=l.id;
 perform app.audit(t,'porter.enrolled','user',p_user::text,jsonb_build_object('status',v_status,'term',term.version));
 return jsonb_build_object('status',v_status,'tenant_id',t);
end $$;
-- Não devolve referência em nenhum caminho. Bloqueio é calculado no banco e persiste em falhas.
create function public.porter_login_check(p_tenant uuid,p_user uuid,p_document_hash text,p_descriptor double precision[],p_photo text,p_method text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ident public.porter_identities; ref public.porter_faces; d double precision; v_result text; attempt uuid;
begin
 perform pg_advisory_xact_lock(hashtext(p_tenant::text||p_document_hash));
 perform app.require(p_photo is null or p_photo like p_tenant::text||'/staff-face/%','Foto inválida.');
 select * into ident from public.porter_identities where tenant_id=p_tenant and user_id=p_user and document_hash=p_document_hash;
 if (select count(*) from public.porter_attempts where tenant_id=p_tenant and document_hash=p_document_hash and result in ('mismatch','invalid','password_failed') and created_at>app.now()-interval '15 minutes')>=5 then v_result:='blocked';
 elsif ident.user_id is null or not exists(select 1 from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id where m.tenant_id=p_tenant and m.user_id=p_user and m.role='porteiro' and m.status='active' and t.status='active') then v_result:='invalid';
 elsif p_method='password' then v_result:='ok';
 elsif p_method='password_failed' then v_result:='password_failed';
 else
   select * into ref from public.porter_faces where tenant_id=p_tenant and user_id=p_user;
   if ref.user_id is null and ident.reenroll_until > app.now() and app.porter_descriptor_valid(p_descriptor) and p_photo is not null then
     -- Recadastro autorizado pelo síndico: foto vira referência (não entra na retenção de 90 dias das tentativas).
     insert into public.porter_faces(tenant_id,user_id,descriptor,photo_path) values(p_tenant,p_user,p_descriptor,p_photo);
     update public.porter_identities set reenroll_until=null where tenant_id=p_tenant and user_id=p_user;
     perform app.audit(p_tenant,'porter.reenrolled','user',p_user::text);
     p_photo:=null; v_result:='ok';
   else
     -- Sem referência (e sem recadastro autorizado): recusa.
     d:=app.porter_distance(ref.descriptor,p_descriptor);
     v_result:=case when d is not null and d<=0.45 then 'ok' else 'mismatch' end;
   end if;
 end if;
 insert into public.porter_attempts(tenant_id,user_id,document_hash,method,result,distance,photo_path)
 values(p_tenant,ident.user_id,p_document_hash,case when p_method='face' then 'face' else 'password' end,v_result,d,p_photo) returning id into attempt;
 perform app.audit(p_tenant,'porter.login.'||v_result,'user',ident.user_id::text,jsonb_build_object('method',p_method,'attempt',attempt,'distance',d));
 return jsonb_build_object('ok',v_result='ok','result',v_result,'attempt_id',attempt,'distance',d);
end $$;
-- Apenas serviço pode abrir turno: vinculado ao session_id real do JWT validado no Auth.
create function public.porter_shift_open(p_attempt uuid,p_session text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.porter_attempts; s public.porter_shifts;
begin
 select * into a from public.porter_attempts where id=p_attempt for update;
 perform app.require(a.result='ok' and a.created_at>app.now()-interval '2 minutes' and length(p_session) between 10 and 100,'Verificação expirada.');
 perform app.require(exists(select 1 from public.tenant_memberships where tenant_id=a.tenant_id and user_id=a.user_id and role='porteiro' and status='active'),'Vínculo inativo.');
 -- Consumo único da autorização evita prolongar turno por replay.
 update public.porter_attempts set result='accepted' where id=a.id;
 update public.porter_shifts set ended_at=app.now() where tenant_id=a.tenant_id and user_id=a.user_id and ended_at is null;
 insert into public.porter_shifts(tenant_id,user_id,session_id,method) values(a.tenant_id,a.user_id,p_session,a.method) returning * into s;
 perform app.audit(a.tenant_id,'porter.shift_started','porter_shift',s.id::text);
 return jsonb_build_object('started_at',s.started_at,'expires_at',s.expires_at);
end $$;
create function public.porter_my_shift(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform app.require(app.has_role(p_tenant,array['admin','porteiro']));
 return jsonb_build_object('enrolled',exists(select 1 from public.porter_identities where tenant_id=p_tenant and user_id=auth.uid()),
 'server_now',app.now(),'shift',(select jsonb_build_object('started_at',started_at,'expires_at',expires_at,'ended_at',ended_at) from public.porter_shifts where tenant_id=p_tenant and user_id=auth.uid() and session_id=app.porter_session() order by started_at desc limit 1));
end $$;
create function public.porter_shift_end() returns void language plpgsql security definer set search_path='' as $$
begin
 update public.porter_shifts set ended_at=app.now() where user_id=auth.uid() and session_id=app.porter_session() and ended_at is null;
end $$;
-- Instantâneo confiável do responsável, não o nome editável enviado pelo formulário.
alter table public.packages add column received_by_document text;
create function app.porter_package_identity() returns trigger language plpgsql security definer set search_path='' as $$
declare i public.porter_identities;
begin
 if new.received_by is not null then
 select * into i from public.porter_identities where tenant_id=new.tenant_id and user_id=new.received_by;
 if found then new.received_by_name:=i.full_name; new.received_by_document:=i.document_masked; end if;
 end if; return new;
end $$;
create trigger porter_package_identity before insert or update of received_by,received_by_name on public.packages for each row execute function app.porter_package_identity();
create function app.porter_remove_face() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.role='porteiro' and (tg_op='DELETE' or new.status='revoked') then
 insert into public.porter_photo_deletions(path) select photo_path from public.porter_faces where tenant_id=old.tenant_id and user_id=old.user_id on conflict do nothing;
 delete from public.porter_faces where tenant_id=old.tenant_id and user_id=old.user_id;
 update public.porter_shifts set ended_at=app.now() where tenant_id=old.tenant_id and user_id=old.user_id and ended_at is null;
 end if; return old;
end $$;
create trigger porter_remove_face after update of status or delete on public.tenant_memberships for each row execute function app.porter_remove_face();

-- Nenhum SELECT direto, nem para administradores: somente RPCs auditadas.
do $$ declare n text; begin
 foreach n in array array['porter_links','porter_terms','porter_consents','porter_identities','porter_faces','porter_attempts','porter_shifts','porter_photo_deletions'] loop
 execute format('alter table public.%I enable row level security',n);
 execute format('revoke all on public.%I from public,anon,authenticated',n);
 execute format('grant all on public.%I to service_role',n);
 end loop;
end $$;
revoke all on function app.porter_descriptor_valid(double precision[]),app.porter_distance(double precision[],double precision[]),app.porter_session(),app.porter_package_identity(),app.porter_remove_face() from public,anon,authenticated;
revoke all on function public.porter_link_create(uuid,boolean,int,int),public.porter_link_revoke(uuid),public.porter_signup_preview(text,text),public.porter_signup_finish(text,text,uuid,jsonb,double precision[],text,text,text,text),public.porter_login_check(uuid,uuid,text,double precision[],text,text),public.porter_shift_open(uuid,text),public.porter_my_shift(uuid),public.porter_shift_end() from public,anon,authenticated;
grant execute on function public.porter_link_create(uuid,boolean,int,int),public.porter_link_revoke(uuid),public.porter_my_shift(uuid),public.porter_shift_end() to authenticated;
grant execute on function public.porter_signup_preview(text,text),public.porter_signup_finish(text,text,uuid,jsonb,double precision[],text,text,text,text),public.porter_login_check(uuid,uuid,text,double precision[],text,text),public.porter_shift_open(uuid,text) to service_role;
