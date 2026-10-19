-- =============================================================================
-- PORTARIA PRIME — 1000: filas processadas pelo backend (somente service_role)
-- =============================================================================

-- Reserva jobs vencidos com lock (vários workers em paralelo não pegam o mesmo).
create or replace function public.claim_notification_jobs(p_limit int default 50) returns setof public.notification_jobs
language sql security definer set search_path = '' as $$
  update public.notification_jobs j
     set status = 'sending', attempts = attempts + 1, locked_until = now() + interval '2 minutes', updated_at = now()
   where j.id in (
     select id from public.notification_jobs
      where (status = 'queued' and next_attempt_at <= app.now())
         or (status = 'failed' and attempts < 5 and next_attempt_at <= app.now())
         or (status = 'sending' and locked_until < now())
      order by next_attempt_at
      limit least(greatest(p_limit, 1), 200)
      for update skip locked)
  returning j.*
$$;

-- Resultado do envio. Falha agenda retry com backoff exponencial (1, 4, 16, 64 min).
create or replace function public.complete_notification_job(
  p_job uuid, p_status text, p_provider_ref text default null, p_error text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare j public.notification_jobs;
begin
  if p_status not in ('accepted', 'delivered', 'failed', 'disabled') then raise exception 'status inválido'; end if;
  update public.notification_jobs set status = p_status, last_error = left(p_error, 500), locked_until = null,
    next_attempt_at = case when p_status = 'failed' then now() + make_interval(mins => power(4, least(attempts, 4) - 1)::int) else next_attempt_at end,
    updated_at = now()
  where id = p_job returning * into j;
  if not found then return; end if;
  insert into public.notification_attempts (job_id, tenant_id, ok, provider_ref, error)
  values (j.id, j.tenant_id, p_status in ('accepted', 'delivered'), p_provider_ref, left(p_error, 500));
  if p_status in ('accepted', 'delivered') and j.event = 'package_received' then
    update public.packages set notified_at = coalesce(notified_at, now())
     where tenant_id = j.tenant_id and id = (j.payload ->> 'package_id')::uuid;
  end if;
end $$;

-- Contexto mínimo para montar a mensagem (sem dados além do necessário).
create or replace function public.notification_context(p_job uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tenant_id', t.id, 'tenant_name', coalesce(b.display_name, t.name), 'tenant_slug', t.slug, 'timezone', t.timezone,
    'color_primary', b.color_primary,
    'whatsapp', (select jsonb_build_object('enabled', i.enabled, 'instance', i.config ->> 'instance')
                   from public.tenant_integrations i where i.tenant_id = t.id and i.provider = 'whatsapp_evolution'),
    'package', (select jsonb_build_object('carrier', p.carrier, 'tracking_code', p.tracking_code, 'received_at', p.received_at,
                  'picked_up_at', p.picked_up_at, 'picked_up_by', p.picked_up_by_name, 'storage_code', sl.code,
                  'unit', concat_ws(' ', u.block, u.label), 'protocol', r.protocol)
                from public.packages p
                left join public.units u on u.id = p.unit_id
                left join public.storage_locations sl on sl.id = p.storage_location_id
                left join public.receipts r on r.package_id = p.id
               where p.tenant_id = j.tenant_id and p.id = (j.payload ->> 'package_id')::uuid))
  from public.notification_jobs j
  join public.tenants t on t.id = j.tenant_id
  left join public.tenant_branding b on b.tenant_id = t.id
  where j.id = p_job
$$;

create or replace function public.consume_whatsapp(p_tenant uuid) returns boolean
language sql security definer set search_path = '' as $$
  select app.has_feature(p_tenant, 'whatsapp') and app.consume_usage(p_tenant, 'whatsapp', (app.entitlements(p_tenant)).whatsapp_monthly)
$$;

-- Eventos de pagamento pendentes de processamento (webhook gravado e ainda não verificado).
create or replace function public.claim_payment_events(p_limit int default 20) returns setof public.payment_events
language sql security definer set search_path = '' as $$
  update public.payment_events e set attempts = attempts + 1
   where e.id in (select id from public.payment_events
                   where status in ('received', 'error') and attempts < 10
                   order by received_at limit p_limit for update skip locked)
  returning e.*
$$;

create or replace function public.finish_payment_event(p_event uuid, p_status text, p_error text default null) returns void
language sql security definer set search_path = '' as $$
  update public.payment_events set status = p_status, error = left(p_error, 500),
    processed_at = case when p_status in ('processed', 'ignored', 'review') then now() end
  where id = p_event
$$;

-- Configura a instância Evolution do condomínio (nome derivado no servidor).
create or replace function public.set_whatsapp_instance(p_tenant uuid, p_instance text, p_enabled boolean) returns void
language sql security definer set search_path = '' as $$
  insert into public.tenant_integrations (tenant_id, provider, enabled, config)
  values (p_tenant, 'whatsapp_evolution', p_enabled, jsonb_build_object('instance', p_instance))
  on conflict (tenant_id, provider) do update set enabled = excluded.enabled, config = excluded.config, updated_at = now()
$$;

revoke execute on function public.claim_notification_jobs(int), public.complete_notification_job(uuid, text, text, text),
  public.notification_context(uuid), public.consume_whatsapp(uuid), public.claim_payment_events(int),
  public.finish_payment_event(uuid, text, text), public.set_whatsapp_instance(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_notification_jobs(int), public.complete_notification_job(uuid, text, text, text),
  public.notification_context(uuid), public.consume_whatsapp(uuid), public.claim_payment_events(int),
  public.finish_payment_event(uuid, text, text), public.set_whatsapp_instance(uuid, text, boolean)
  to service_role;

-- Integrações: o cliente não escreve direto (nome da instância é decidido no servidor).
revoke insert, update on public.tenant_integrations from authenticated;

-- Checagem usada pela API de conexão do WhatsApp (age como o usuário).
create or replace function public.has_settings_and_whatsapp(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_perm(p_tenant, 'settings') and app.has_feature(p_tenant, 'whatsapp')
$$;
revoke execute on function public.has_settings_and_whatsapp(uuid) from public, anon;
grant execute on function public.has_settings_and_whatsapp(uuid) to authenticated, service_role;
