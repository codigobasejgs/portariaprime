-- Fotos privadas: autorizar e auditar antes de assinar URL (60 segundos).
create function public.porter_audit(p_tenant uuid,p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform app.require(app.has_perm(p_tenant,'team'));
 return jsonb_build_object(
 'porters',coalesce((select jsonb_agg(jsonb_build_object('user_id',m.user_id,'membership_id',m.id,'name',coalesce(i.full_name,p.full_name),'document',i.document_masked,'status',m.status,'enrolled',f.user_id is not null))
 from public.tenant_memberships m left join public.profiles p on p.id=m.user_id left join public.porter_identities i on i.tenant_id=m.tenant_id and i.user_id=m.user_id left join public.porter_faces f on f.tenant_id=m.tenant_id and f.user_id=m.user_id
 where m.tenant_id=p_tenant and m.role='porteiro'),'[]'::jsonb),
 'attempts',coalesce((select jsonb_agg(x) from (select a.id,a.user_id,i.full_name,a.method,a.result,a.distance,a.created_at,a.photo_path is not null as has_photo from public.porter_attempts a left join public.porter_identities i on i.tenant_id=a.tenant_id and i.user_id=a.user_id where a.tenant_id=p_tenant order by a.created_at desc limit 100 offset greatest(0,coalesce(p_offset,0))) x),'[]'::jsonb),
 'shifts',coalesce((select jsonb_agg(x) from (select s.id,s.user_id,i.full_name,s.started_at,s.expires_at,s.ended_at,s.method,case when s.ended_at is not null then 'encerrado' when s.expires_at<=app.now() then 'expirado' else 'ativo' end status from public.porter_shifts s left join public.porter_identities i on i.tenant_id=s.tenant_id and i.user_id=s.user_id where s.tenant_id=p_tenant order by s.started_at desc limit 100 offset greatest(0,coalesce(p_offset,0))) x),'[]'::jsonb),
 'links',coalesce((select jsonb_agg(jsonb_build_object('id',id,'expires_at',expires_at,'uses',uses,'max_uses',max_uses,'revoked_at',revoked_at)) from public.porter_links where tenant_id=p_tenant),'[]'::jsonb));
end $$;
create function public.porter_photo_authorize(p_tenant uuid,p_user uuid,p_attempt uuid default null) returns text
language plpgsql security definer set search_path='' as $$
declare path text;
begin
 perform app.require(app.has_perm(p_tenant,'team'));
 if p_attempt is null then select photo_path into path from public.porter_faces where tenant_id=p_tenant and user_id=p_user;
 else select photo_path into path from public.porter_attempts where id=p_attempt and tenant_id=p_tenant and user_id=p_user and created_at>app.now()-interval '90 days'; end if;
 perform app.require(path is not null,'Foto indisponível ou prazo de retenção encerrado.');
 perform app.audit(p_tenant,'porter.photo_view','user',p_user::text,jsonb_build_object('attempt',p_attempt));
 return path;
end $$;
create function public.porter_retention() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 insert into public.porter_photo_deletions(path) select photo_path from public.porter_attempts where photo_path is not null and created_at<=app.now()-interval '90 days' on conflict do nothing;
 update public.porter_attempts set photo_path=null where photo_path is not null and created_at<=app.now()-interval '90 days';
 insert into public.porter_photo_deletions(path) select f.photo_path from public.porter_faces f where not exists(select 1 from public.tenant_memberships m where m.tenant_id=f.tenant_id and m.user_id=f.user_id and m.role='porteiro' and m.status in ('active','pending')) on conflict do nothing;
 delete from public.porter_faces f where not exists(select 1 from public.tenant_memberships m where m.tenant_id=f.tenant_id and m.user_id=f.user_id and m.role='porteiro' and m.status in ('active','pending'));
 return coalesce((select jsonb_agg(path) from (select path from public.porter_photo_deletions order by queued_at limit 100) x),'[]'::jsonb);
end $$;
-- Troca da referência: só síndico com 'team', login recente, motivo obrigatório; referência antiga eliminada.
create function public.porter_reference_reset(p_tenant uuid,p_user uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform app.require(app.has_perm(p_tenant,'team'));
 perform app.mdm_require_recent_auth();
 perform app.require(length(btrim(coalesce(p_reason,''))) between 5 and 300,'Informe o motivo (5 a 300 caracteres).');
 perform app.require(exists(select 1 from public.porter_identities where tenant_id=p_tenant and user_id=p_user),'Porteiro sem cadastro biométrico.');
 insert into public.porter_photo_deletions(path) select photo_path from public.porter_faces where tenant_id=p_tenant and user_id=p_user on conflict do nothing;
 delete from public.porter_faces where tenant_id=p_tenant and user_id=p_user;
 update public.porter_identities set reenroll_until=app.now()+interval '24 hours' where tenant_id=p_tenant and user_id=p_user;
 perform app.audit(p_tenant,'porter.reference_reset','user',p_user::text,jsonb_build_object('reason',btrim(p_reason)));
end $$;
-- Worker confirma exclusão física no Storage.
create function public.porter_photo_deleted(p_paths text[]) returns void language sql security definer set search_path='' as $$
 delete from public.porter_photo_deletions where path = any(p_paths)
$$;
revoke all on function public.porter_audit(uuid,int),public.porter_photo_authorize(uuid,uuid,uuid),public.porter_retention(),
 public.porter_reference_reset(uuid,uuid,text),public.porter_photo_deleted(text[]) from public,anon,authenticated;
grant execute on function public.porter_audit(uuid,int),public.porter_photo_authorize(uuid,uuid,uuid),public.porter_reference_reset(uuid,uuid,text) to authenticated;
grant execute on function public.porter_photo_deleted(text[]) to service_role;
grant execute on function public.porter_retention() to service_role;
