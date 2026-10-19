-- =============================================================================
-- PORTARIA PRIME — 0400: estado comercial, franquias e RLS de todas as tabelas
-- Regra geral: leitura via RLS; escrita sensível somente via RPC SECURITY DEFINER
-- (0500), que valida vínculo ativo, tenant e estado comercial.
-- =============================================================================

-- Fim do acesso pago/trial vigente (exclusivo).
create or replace function app.access_until(p_tenant uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select greatest(s.current_period_end, s.trial_ends_at)  -- greatest ignora NULL
  from public.subscriptions s where s.tenant_id = p_tenant
$$;

-- 'full'  : trial ou período pago vigente
-- 'grace' : terminou há menos de grace_days (avisos, operação mantida)
-- 'restricted': sem novos recebimentos nem recursos pagos; consulta, exportação,
--               cobrança e retirada de encomendas já guardadas continuam.
create or replace function app.commercial_state(p_tenant uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_until timestamptz; v_grace int; v_status text; v_now timestamptz := app.now();
begin
  select s.status, app.access_until(p_tenant), coalesce(ts.grace_days, 7)
    into v_status, v_until, v_grace
    from public.subscriptions s left join public.tenant_settings ts on ts.tenant_id = s.tenant_id
   where s.tenant_id = p_tenant;
  if v_status is null or v_status = 'suspended' then return 'restricted'; end if;
  if v_until is not null and v_now < v_until then return 'full'; end if;
  -- Assinatura cancelada não tem carência: acaba no fim do período.
  if v_status = 'canceled' then return 'restricted'; end if;
  if v_until is not null and v_now < v_until + make_interval(days => v_grace) then return 'grace'; end if;
  return 'restricted';
end $$;

create or replace function app.can_operate(p_tenant uuid) returns boolean
language sql stable set search_path = '' as $$ select app.commercial_state(p_tenant) in ('full', 'grace') $$;

create or replace function app.entitlements(p_tenant uuid) returns public.plan_entitlements
language sql stable security definer set search_path = '' as $$
  select e.* from public.subscriptions s join public.plan_entitlements e on e.plan_id = s.plan_id
  where s.tenant_id = p_tenant
$$;

create or replace function app.has_feature(p_tenant uuid, p_feature text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare e public.plan_entitlements := app.entitlements(p_tenant);
begin
  if e.plan_id is null or not app.can_operate(p_tenant) then return false; end if;
  return case p_feature
    when 'ocr' then e.feature_ocr when 'whatsapp' then e.feature_whatsapp
    when 'totem' then e.feature_totem when 'reports_plus' then e.feature_reports_plus else false end;
end $$;

-- Franquias de unidades e portarias aplicadas no banco (também contra API direta).
create or replace function app.enforce_unit_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max int; v_count int;
begin
  if tg_op = 'UPDATE' and (old.active or not new.active) then return new; end if;
  perform 1 from public.tenants where id = new.tenant_id for update;
  v_max := (app.entitlements(new.tenant_id)).max_units;
  select count(*) into v_count from public.units where tenant_id = new.tenant_id and active and id <> new.id;
  if v_max is not null and v_count >= v_max then
    raise exception 'Limite de % unidades do plano atingido. Altere o plano para cadastrar mais.', v_max using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger units_limit before insert or update of active on public.units
  for each row execute function app.enforce_unit_limit();

create or replace function app.enforce_concierge_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max int; v_count int;
begin
  if tg_op = 'UPDATE' and (old.active or not new.active) then return new; end if;
  perform 1 from public.tenants where id = new.tenant_id for update;
  v_max := (app.entitlements(new.tenant_id)).max_concierges;
  select count(*) into v_count from public.concierge_locations where tenant_id = new.tenant_id and active and id <> new.id;
  if v_max is not null and v_count >= v_max then
    raise exception 'Limite de % portaria(s) do plano atingido.', v_max using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger concierge_limit before insert or update of active on public.concierge_locations
  for each row execute function app.enforce_concierge_limit();

-- Logo do condomínio só pode apontar para a pasta do próprio condomínio.
alter table public.tenant_branding add constraint tenant_branding_logo_path_ck
  check (logo_path is null or (split_part(logo_path, '/', 1) = tenant_id::text and logo_path ~ '^[0-9a-f-]{36}/logo-[A-Za-z0-9-]{8,64}\.(png|jpg|webp)$'));

-- -----------------------------------------------------------------------------
-- Privilégios base: nada para anon além do catálogo; RLS decide o resto.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;
grant execute on function app.now(), app.is_platform_admin(), app.has_role(uuid, text[]), app.is_staff(uuid),
  app.is_admin(uuid), app.is_member(uuid), app.has_perm(uuid, text), app.is_unit_member(uuid, uuid),
  app.commercial_state(uuid), app.can_operate(uuid), app.occupies_space(text), app.is_pending(text),
  app.access_until(uuid), app.entitlements(uuid), app.has_feature(uuid, text)
  to authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all functions in schema app to service_role;
grant usage on all sequences in schema public to service_role;

do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
-- service_role precisa ignorar RLS (backend com filtro explícito de tenant).
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'alter role service_role bypassrls';
  end if;
exception when others then null; -- no Supabase o papel já tem BYPASSRLS
end $$;

-- tenants
grant select on public.tenants to authenticated;
create policy tenants_select on public.tenants for select to authenticated
  using (app.is_member(id) or app.is_platform_admin()
    or exists (select 1 from public.tenant_memberships m where m.tenant_id = id and m.user_id = auth.uid() and m.status = 'active'));

-- profiles: o próprio; equipe vê nomes de membros do mesmo condomínio.
grant select on public.profiles to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.tenant_memberships m where m.user_id = profiles.id and app.is_staff(m.tenant_id)));
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

grant select on public.platform_admins to authenticated;
create policy platform_admins_self on public.platform_admins for select to authenticated using (user_id = auth.uid());

grant select on public.tenant_memberships to authenticated;
create policy memberships_select on public.tenant_memberships for select to authenticated using (
  user_id = auth.uid() or app.has_perm(tenant_id, 'team') or app.has_perm(tenant_id, 'approve'));

grant select on public.invitations to authenticated;
create policy invitations_select on public.invitations for select to authenticated using (
  app.has_perm(tenant_id, 'team') or app.has_perm(tenant_id, 'approve'));

grant select on public.tenant_branding to authenticated;
grant update (display_name, logo_path, color_primary, color_secondary, color_accent, theme) on public.tenant_branding to authenticated;
create policy branding_select on public.tenant_branding for select to authenticated using (app.is_member(tenant_id));
create policy branding_update on public.tenant_branding for update to authenticated
  using (app.has_perm(tenant_id, 'settings')) with check (app.has_perm(tenant_id, 'settings'));

grant select on public.tenant_settings to authenticated;
grant update (qr_ttl_hours, notify_whatsapp, notify_email, notify_push, max_residents_per_unit, onboarding) on public.tenant_settings to authenticated;
create policy settings_select on public.tenant_settings for select to authenticated using (app.is_member(tenant_id));
create policy settings_update on public.tenant_settings for update to authenticated
  using (app.has_perm(tenant_id, 'settings')) with check (app.has_perm(tenant_id, 'settings'));

grant select on public.tenant_integrations to authenticated;
grant insert, update (enabled, config) on public.tenant_integrations to authenticated;
create policy integrations_select on public.tenant_integrations for select to authenticated using (app.has_perm(tenant_id, 'settings'));
create policy integrations_insert on public.tenant_integrations for insert to authenticated with check (app.has_perm(tenant_id, 'settings'));
create policy integrations_update on public.tenant_integrations for update to authenticated
  using (app.has_perm(tenant_id, 'settings')) with check (app.has_perm(tenant_id, 'settings'));

grant select, insert on public.consent_records to authenticated;
create policy consent_select on public.consent_records for select to authenticated using (user_id = auth.uid());
create policy consent_insert on public.consent_records for insert to authenticated
  with check (user_id = auth.uid() and (tenant_id is null or app.is_member(tenant_id)));

grant select on public.audit_logs to authenticated;
create policy audit_select on public.audit_logs for select to authenticated using (
  (tenant_id is not null and app.is_admin(tenant_id)) or app.is_platform_admin());

-- unidades e moradores
grant select on public.units to authenticated;
grant insert (tenant_id, block, label, active), update (block, label, active) on public.units to authenticated;
create policy units_select on public.units for select to authenticated using (app.is_staff(tenant_id) or app.is_unit_member(tenant_id, id));
create policy units_insert on public.units for insert to authenticated with check (app.is_admin(tenant_id));
create policy units_update on public.units for update to authenticated using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

grant select on public.unit_memberships to authenticated;
create policy unit_memberships_select on public.unit_memberships for select to authenticated
  using (app.is_staff(tenant_id) or user_id = auth.uid());

grant select, delete on public.resident_contacts to authenticated;
grant insert (tenant_id, unit_id, user_id, name, phone, email, notify_whatsapp, notify_email, active),
  update (name, phone, email, notify_whatsapp, notify_email, active) on public.resident_contacts to authenticated;
create policy contacts_select on public.resident_contacts for select to authenticated
  using (app.is_staff(tenant_id) or app.is_unit_member(tenant_id, unit_id));
create policy contacts_insert on public.resident_contacts for insert to authenticated
  with check (app.is_admin(tenant_id) or (app.is_unit_member(tenant_id, unit_id) and (user_id is null or user_id = auth.uid())));
create policy contacts_update on public.resident_contacts for update to authenticated
  using (app.is_admin(tenant_id) or app.is_unit_member(tenant_id, unit_id))
  with check (app.is_admin(tenant_id) or app.is_unit_member(tenant_id, unit_id));
create policy contacts_delete on public.resident_contacts for delete to authenticated
  using (app.is_admin(tenant_id) or app.is_unit_member(tenant_id, unit_id));

-- locais
grant select on public.concierge_locations, public.storage_locations to authenticated;
grant insert (tenant_id, name, active), update (name, active) on public.concierge_locations to authenticated;
grant insert (tenant_id, concierge_location_id, code, capacity, sort_order, is_contingency, active),
  update (code, capacity, sort_order, is_contingency, active) on public.storage_locations to authenticated;
create policy concierge_select on public.concierge_locations for select to authenticated using (app.is_staff(tenant_id));
create policy concierge_insert on public.concierge_locations for insert to authenticated with check (app.is_admin(tenant_id));
create policy concierge_update on public.concierge_locations for update to authenticated using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));
create policy storage_loc_select on public.storage_locations for select to authenticated using (app.is_staff(tenant_id));
create policy storage_loc_insert on public.storage_locations for insert to authenticated with check (app.is_admin(tenant_id));
create policy storage_loc_update on public.storage_locations for update to authenticated using (app.is_admin(tenant_id)) with check (app.is_admin(tenant_id));

-- encomendas: somente leitura direta; escrita via RPC.
grant select on public.packages, public.package_events, public.package_attachments, public.receipts to authenticated;
create policy packages_select on public.packages for select to authenticated
  using (app.is_staff(tenant_id) or (unit_id is not null and status <> 'PRE_REGISTRADA' and app.is_unit_member(tenant_id, unit_id)));
create policy package_events_select on public.package_events for select to authenticated using (
  app.is_staff(tenant_id) or exists (select 1 from public.packages p where p.id = package_id and p.tenant_id = package_events.tenant_id
    and p.status <> 'PRE_REGISTRADA' and app.is_unit_member(p.tenant_id, p.unit_id)));
create policy attachments_select on public.package_attachments for select to authenticated using (
  app.is_staff(tenant_id) or exists (select 1 from public.packages p where p.id = package_id and p.tenant_id = package_attachments.tenant_id
    and p.status <> 'PRE_REGISTRADA' and app.is_unit_member(p.tenant_id, p.unit_id)));
create policy receipts_select on public.receipts for select to authenticated using (
  app.is_staff(tenant_id) or exists (select 1 from public.packages p where p.id = package_id and p.tenant_id = receipts.tenant_id
    and app.is_unit_member(p.tenant_id, p.unit_id)));
-- pickup_tokens: sem acesso direto (só hashes).

grant select on public.device_enrollments to authenticated;
create policy devices_select on public.device_enrollments for select to authenticated using (app.is_admin(tenant_id));

-- catálogo: público somente o publicado.
grant select on public.plans, public.plan_prices, public.plan_entitlements to anon, authenticated;
grant insert, update on public.plans, public.plan_prices, public.plan_entitlements to authenticated;
create policy plans_select on public.plans for select to anon, authenticated using (published or app.is_platform_admin());
create policy plans_admin_ins on public.plans for insert to authenticated with check (app.is_platform_admin());
create policy plans_admin_upd on public.plans for update to authenticated using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy prices_select on public.plan_prices for select to anon, authenticated using (
  app.is_platform_admin() or (active and exists (select 1 from public.plans p where p.id = plan_id and p.published)));
create policy prices_admin_ins on public.plan_prices for insert to authenticated with check (app.is_platform_admin());
create policy prices_admin_upd on public.plan_prices for update to authenticated using (app.is_platform_admin()) with check (app.is_platform_admin());
create policy ent_select on public.plan_entitlements for select to anon, authenticated using (
  app.is_platform_admin() or exists (select 1 from public.plans p where p.id = plan_id and p.published));
create policy ent_admin_ins on public.plan_entitlements for insert to authenticated with check (app.is_platform_admin());
create policy ent_admin_upd on public.plan_entitlements for update to authenticated using (app.is_platform_admin()) with check (app.is_platform_admin());

-- cobrança: leitura para gestor com permissão de faturamento e superadmin.
grant select on public.subscriptions, public.billing_orders, public.payments, public.usage_counters to authenticated;
create policy subs_select on public.subscriptions for select to authenticated using (app.has_perm(tenant_id, 'billing') or app.is_platform_admin());
create policy orders_select on public.billing_orders for select to authenticated using (app.has_perm(tenant_id, 'billing') or app.is_platform_admin());
create policy payments_select on public.payments for select to authenticated using (app.has_perm(tenant_id, 'billing') or app.is_platform_admin());
create policy usage_select on public.usage_counters for select to authenticated using (app.is_admin(tenant_id) or app.is_platform_admin());
grant select on public.payment_events, public.billing_incidents, public.contact_requests to authenticated;
create policy pay_events_select on public.payment_events for select to authenticated using (app.is_platform_admin());
create policy incidents_select on public.billing_incidents for select to authenticated using (app.is_platform_admin());
create policy contact_select on public.contact_requests for select to authenticated using (app.is_platform_admin());

-- notificações
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy notif_select on public.notifications for select to authenticated using (user_id = auth.uid() and app.is_member(tenant_id));
create policy notif_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, delete on public.push_subscriptions to authenticated;
grant insert (tenant_id, user_id, endpoint, p256dh, auth, user_agent) on public.push_subscriptions to authenticated;
create policy push_select on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy push_insert on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid() and app.is_member(tenant_id));
create policy push_delete on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

grant select on public.notification_jobs, public.notification_attempts to authenticated;
create policy jobs_select on public.notification_jobs for select to authenticated using (app.is_staff(tenant_id));
create policy attempts_select on public.notification_attempts for select to authenticated using (app.is_admin(tenant_id));

grant usage on all sequences in schema public to authenticated;
