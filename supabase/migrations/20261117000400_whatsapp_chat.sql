-- =============================================================================
-- Conversas do WhatsApp dos avisos (Evolution) no painel do síndico: ver, responder, mandar foto, vídeo e PDF.
-- As mensagens continuam só na Evolution (não copiamos para o banco). Aqui ficam:
--  * bucket privado tenant-chat: anexos que o síndico envia (<tenant>/out/...) e mídias recebidas abertas no painel
--    (<tenant>/in/..., gravadas pelo servidor);
--  * whatsapp_chat_gate: quem pode (configurações + plano com WhatsApp); enviar conta na franquia e vai para a auditoria
--    (só o tipo, nunca o conteúdo);
--  * whatsapp_chat_who: identifica a conversa pelo aviso que saiu para ela (unidade, nome e celular).
-- Os avisos automáticos não mudam. Aditiva.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-chat', 'tenant-chat', false, 16777216, array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/3gpp',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.can_whatsapp_chat(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_perm(p_tenant, 'settings') and app.has_feature(p_tenant, 'whatsapp')
$$;

-- Anexo do síndico: só na pasta out/ do próprio condomínio. Leitura é sempre por URL assinada do servidor.
drop policy if exists pp_chat_insert on storage.objects;
create policy pp_chat_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-chat' and split_part(name, '/', 2) = 'out' and app.can_whatsapp_chat(app.path_tenant(name)));

create function public.whatsapp_chat_gate(p_tenant uuid, p_action text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.can_whatsapp_chat(p_tenant), 'Requer permissão de configurações e plano com WhatsApp.');
  if coalesce(p_action, '') not in ('read', 'text', 'image', 'video', 'document') then
    raise exception 'Ação inválida.' using errcode = '22023';
  end if;
  if p_action <> 'read' then
    perform app.require(app.consume_usage(p_tenant, 'whatsapp', (app.entitlements(p_tenant)).whatsapp_monthly), 'Franquia de WhatsApp do mês esgotada.');
    insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
    values (p_tenant, auth.uid(), 'whatsapp.chat_send', 'tenant', p_tenant::text, jsonb_build_object('kind', p_action));
  end if;
  return true;
end $$;

-- Quem é a conversa: o id da mensagem que a Evolution devolveu ao enviar um aviso (notification_attempts.provider_ref)
-- leva ao celular do aviso e daí ao morador/pré-cadastro. Só refs deste condomínio.
create function public.whatsapp_chat_who(p_tenant uuid, p_refs text[]) returns table (ref text, phone text, full_name text, unit text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.can_whatsapp_chat(p_tenant), 'Requer permissão de configurações e plano com WhatsApp.');
  return query
  select distinct on (a.provider_ref) a.provider_ref, j.recipient,
         coalesce(rc.name, e.full_name), app.unit_display(p_tenant, u.block, u.label)
    from public.notification_attempts a
    join public.notification_jobs j on j.id = a.job_id and j.tenant_id = p_tenant and j.channel = 'whatsapp'
    left join lateral (select c.name, c.unit_id from public.resident_contacts c
                        where c.tenant_id = p_tenant and c.active and right(app.digits(c.phone), 11) = right(app.digits(j.recipient), 11)
                        order by c.created_at desc limit 1) rc on true
    left join lateral (select x.full_name, x.unit_id from public.resident_import_entries x
                        where x.tenant_id = p_tenant and x.id::text = split_part(j.ref_id, ':', 1) and j.event = 'resident_invite') e on true
    left join public.units u on u.tenant_id = p_tenant and u.id = coalesce(rc.unit_id, e.unit_id)
   where a.tenant_id = p_tenant and a.ok and a.provider_ref = any (p_refs[1:2000])
   order by a.provider_ref, a.created_at desc;
end $$;

-- Retenção: mídias abertas no painel ficam 7 dias no bucket; anexo enviado sai na hora e o que nunca foi enviado
-- (pasta out/) sai em 1 dia. A conversa em si continua na Evolution.
create function public.whatsapp_chat_expired(p_limit int default 200) returns text[]
language plpgsql stable security definer set search_path = '' as $$
begin
  return array(select name from storage.objects where bucket_id = 'tenant-chat'
                  and created_at < now() - case when split_part(name, '/', 2) = 'out' then interval '1 day' else interval '7 days' end
                order by created_at limit least(greatest(coalesce(p_limit, 200), 1), 1000));
end $$;
revoke all on function public.whatsapp_chat_expired(int) from public, anon, authenticated;
grant execute on function public.whatsapp_chat_expired(int) to service_role;

create index if not exists notification_attempts_ref_idx on public.notification_attempts (tenant_id, provider_ref) where provider_ref is not null;

revoke all on function app.can_whatsapp_chat(uuid), public.whatsapp_chat_gate(uuid, text), public.whatsapp_chat_who(uuid, text[]) from public, anon;
grant execute on function app.can_whatsapp_chat(uuid), public.whatsapp_chat_gate(uuid, text), public.whatsapp_chat_who(uuid, text[]) to authenticated, service_role;
