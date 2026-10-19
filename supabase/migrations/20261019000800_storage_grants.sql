-- =============================================================================
-- PORTARIA PRIME — 0800: Storage (privado por condomínio), Realtime e grants
-- =============================================================================

-- Mídia privada (fotos, assinaturas): caminho obrigatório "<tenant_id>/packages/<package_id>/...".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-private', 'tenant-private', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Logos de condomínio: leitura pública, escrita só por quem tem permissão "settings". Sem SVG.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-public', 'tenant-public', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.path_tenant(p_name text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then return null;
end $$;

create or replace function app.path_package(p_name text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if split_part(p_name, '/', 2) <> 'packages' then return null; end if;
  return split_part(p_name, '/', 3)::uuid;
exception when others then return null;
end $$;

create or replace function app.can_read_package_file(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_staff(app.path_tenant(p_name)) or exists (
    select 1 from public.packages p
    where p.tenant_id = app.path_tenant(p_name) and p.id = app.path_package(p_name)
      and p.status <> 'PRE_REGISTRADA' and app.is_unit_member(p.tenant_id, p.unit_id))
$$;

drop policy if exists pp_private_select on storage.objects;
drop policy if exists pp_private_insert on storage.objects;
drop policy if exists pp_public_insert on storage.objects;
drop policy if exists pp_public_update on storage.objects;
drop policy if exists pp_public_delete on storage.objects;

create policy pp_private_select on storage.objects for select to authenticated
  using (bucket_id = 'tenant-private' and app.can_read_package_file(name));
-- Upload só para encomenda existente do próprio condomínio; sem update/delete (prova imutável).
create policy pp_private_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-private' and app.is_staff(app.path_tenant(name))
    and exists (select 1 from public.packages p where p.tenant_id = app.path_tenant(name) and p.id = app.path_package(name)));
create policy pp_public_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-public' and app.has_perm(app.path_tenant(name), 'settings') and split_part(name, '/', 2) like 'logo-%');
create policy pp_public_update on storage.objects for update to authenticated
  using (bucket_id = 'tenant-public' and app.has_perm(app.path_tenant(name), 'settings'))
  with check (bucket_id = 'tenant-public' and app.has_perm(app.path_tenant(name), 'settings'));
create policy pp_public_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tenant-public' and app.has_perm(app.path_tenant(name), 'settings'));

-- Realtime: postgres_changes respeita RLS; o cliente filtra por tenant_id.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.packages, public.notifications;
  end if;
exception when duplicate_object then null;
end $$;

-- -----------------------------------------------------------------------------
-- EXECUTE: nada por padrão; libera explicitamente por público.
-- -----------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;

grant execute on function
  app.now(), app.is_platform_admin(), app.has_role(uuid, text[]), app.is_staff(uuid), app.is_admin(uuid),
  app.is_member(uuid), app.has_perm(uuid, text), app.is_unit_member(uuid, uuid), app.commercial_state(uuid),
  app.can_operate(uuid), app.occupies_space(text), app.is_pending(text), app.access_until(uuid),
  app.entitlements(uuid), app.has_feature(uuid, text), app.path_tenant(text), app.path_package(text),
  app.can_read_package_file(text)
  to authenticated;

grant execute on function
  public.provision_tenant(uuid, text, text, text, text, text, text, text), public.my_context(),
  public.create_invitation(uuid, text, text, uuid, text[]), public.revoke_invitation(uuid),
  public.accept_invitation(text), public.set_membership_status(uuid, text), public.revoke_unit_member(uuid),
  public.list_members(uuid), public.import_units(uuid, jsonb, boolean),
  public.receive_package(uuid, text, uuid, text, text, text, text, uuid, uuid),
  public.confirm_preregistered(uuid, uuid, uuid, text, text, uuid),
  public.attach_package_file(uuid, uuid, text, text), public.issue_pickup_token(uuid, uuid),
  public.lookup_pickup_token(uuid, text), public.confirm_pickup(uuid, uuid, text, text, text, text, text, text),
  public.resolve_package(uuid, uuid, text, text), public.move_package(uuid, uuid, uuid, text),
  public.list_packages(uuid, text, date, date, text, int, timestamptz, uuid), public.report_summary(uuid, date, date),
  public.create_device(uuid, text, uuid), public.revoke_device(uuid), public.consume_ocr(uuid),
  public.subscription_overview(uuid), public.change_plan(uuid, text, text), public.cancel_subscription(uuid),
  public.reactivate_subscription(uuid), public.prepare_checkout(uuid), public.get_order(uuid),
  public.admin_extend_trial(uuid, timestamptz, text), public.admin_set_tenant_status(uuid, text, text),
  public.admin_set_price(text, text, int), public.admin_overview()
  to authenticated;

grant execute on function public.invitation_preview(text) to anon, authenticated;
-- Políticas do catálogo (legíveis por anon) chamam este helper; sem login retorna false.
grant execute on function app.is_platform_admin() to anon;

-- Somente backend (service_role): totem, cobrança verificada, jobs.
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema app to service_role;
