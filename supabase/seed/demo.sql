-- =============================================================================
-- PORTARIA PRIME — SEED DE DEMONSTRAÇÃO (dados 100% fictícios)
-- NÃO é recuperação de dados. Proibido em produção: só roda se a flag
-- deliberada existir:  insert into app.config values ('allow_demo_seed', 'on');
-- Usuários são criados SEM senha (acesso via "Esqueci minha senha"/magic link).
-- =============================================================================
do $$
begin
  if not exists (select 1 from app.config where key = 'allow_demo_seed' and value = 'on') then
    raise exception 'Seed de demonstração bloqueado. Defina app.config allow_demo_seed=on somente em ambiente local/homologação.';
  end if;
end $$;

-- Catálogo publicado apenas na demonstração.
update public.plans set published = true where code in ('essencial', 'profissional', 'prime', 'sob-medida');

create or replace function pg_temp.demo_user(p_email text, p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from auth.users where email = p_email;
  if v is not null then return v; end if;
  v := gen_random_uuid();
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = 'aud') then
    execute 'insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
             values ($1, ''00000000-0000-0000-0000-000000000000'', ''authenticated'', ''authenticated'', $2, now(), $3, ''{"provider":"email","providers":["email"]}'', now(), now())'
      using v, p_email, jsonb_build_object('full_name', p_name);
  else
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values (v, p_email, now(), jsonb_build_object('full_name', p_name));
  end if;
  return v;
end $$;

do $$
declare
  t record; v_tenant uuid; v_admin uuid; v_port uuid; v_mor uuid; v_unit uuid; v_unit2 uuid; v_conc uuid;
  v_loc uuid; v_plan uuid; v_price public.plan_prices; i int;
begin
  for t in select * from (values
      ('demo-aurora', 'Residencial Aurora (demonstração)', '11222333000181', 'aurora'),
      ('demo-jardim', 'Condomínio Jardim das Palmeiras (demonstração)', '44555666000172', 'jardim')) as x(slug, name, doc, key) loop
    if exists (select 1 from public.tenants where slug = t.slug) then continue; end if;

    v_admin := pg_temp.demo_user('sindico.' || t.key || '@demo.portariaprime.invalid', 'Síndica Demo ' || initcap(t.key));
    v_port  := pg_temp.demo_user('porteiro.' || t.key || '@demo.portariaprime.invalid', 'Porteiro Demo ' || initcap(t.key));
    v_mor   := pg_temp.demo_user('morador.' || t.key || '@demo.portariaprime.invalid', 'Morador Demo ' || initcap(t.key));

    insert into public.tenants (slug, name, document, contact_email, timezone, created_by)
    values (t.slug, t.name, t.doc, 'sindico.' || t.key || '@demo.portariaprime.invalid', 'America/Sao_Paulo', v_admin)
    returning id into v_tenant;
    insert into public.trial_eligibility (key, tenant_id) values ('doc:' || t.doc, v_tenant) on conflict do nothing;

    select id into v_plan from public.plans where code = 'profissional';
    select * into v_price from public.plan_prices where plan_id = v_plan and cycle = 'monthly' and active;
    insert into public.subscriptions (tenant_id, status, plan_id, cycle, price_id, price_cents_snapshot, trial_started_at, trial_ends_at)
    values (v_tenant, 'trialing', v_plan, 'monthly', v_price.id, v_price.amount_cents, now(), app.add_months(now(), 'America/Sao_Paulo', 1));

    insert into public.tenant_branding (tenant_id, display_name, color_primary, color_accent)
    values (v_tenant, t.name, case t.key when 'aurora' then '#1F3A5F' else '#126B61' end, '#C8AB78');
    insert into public.tenant_settings (tenant_id) values (v_tenant);
    insert into public.tenant_memberships (tenant_id, user_id, role, permissions) values
      (v_tenant, v_admin, 'admin', array['team', 'approve', 'billing', 'settings']),
      (v_tenant, v_port, 'porteiro', '{}'),
      (v_tenant, v_mor, 'morador', '{}');

    insert into public.concierge_locations (tenant_id, name) values (v_tenant, 'Portaria principal') returning id into v_conc;
    for i in 1..3 loop
      insert into public.storage_locations (tenant_id, concierge_location_id, code, capacity, sort_order)
      values (v_tenant, v_conc, 'Estante ' || chr(64 + i), 12, i);
    end loop;
    insert into public.storage_locations (tenant_id, concierge_location_id, code, capacity, sort_order, is_contingency)
    values (v_tenant, v_conc, 'Contingência', 20, 99, true);
    select id into v_loc from public.storage_locations where tenant_id = v_tenant and code = 'Estante A';

    -- Mesmo bloco/unidade nos dois condomínios (teste de colisão).
    insert into public.units (tenant_id, block, label) values (v_tenant, 'A', '101') returning id into v_unit;
    insert into public.units (tenant_id, block, label) values (v_tenant, 'B', 'Casa 12') returning id into v_unit2;
    insert into public.units (tenant_id, block, label)
    select v_tenant, b, n::text from unnest(array['A', 'B']) b, generate_series(102, 110) n
    on conflict do nothing;

    insert into public.unit_memberships (tenant_id, unit_id, user_id) values (v_tenant, v_unit, v_mor);
    insert into public.resident_contacts (tenant_id, unit_id, user_id, name, email, notify_whatsapp)
    values (v_tenant, v_unit, v_mor, 'Morador Demo ' || initcap(t.key), 'morador.' || t.key || '@demo.portariaprime.invalid', false);

    -- Encomendas em todos os estados (rastreio igual nos dois condomínios de propósito).
    insert into public.packages (tenant_id, unit_id, concierge_location_id, storage_location_id, status, tracking_code, carrier,
      recipient_name, registered_via, idempotency_key, received_at, received_by, stored_at, courier_name)
    values
      (v_tenant, null, v_conc, null, 'PRE_REGISTRADA', 'DEMO000PRE', 'Loggi', null, 'totem', 'seed-pre-' || t.key, now() - interval '20 minutes', null, null, 'Entregador Demo'),
      (v_tenant, v_unit2, v_conc, null, 'RECEBIDA', 'DEMO000REC', 'Correios', 'Morador Casa 12', 'portaria', 'seed-rec-' || t.key, now() - interval '2 hours', v_port, null, null),
      (v_tenant, v_unit, v_conc, v_loc, 'ARMAZENADA', 'DEMO000ARM', 'Mercado Livre', 'Morador Demo', 'portaria', 'seed-arm-' || t.key, now() - interval '1 day', v_port, now() - interval '1 day', null);

    insert into public.packages (tenant_id, unit_id, concierge_location_id, status, tracking_code, carrier, registered_via,
      idempotency_key, received_at, received_by, picked_up_at, picked_up_by_name, delivered_by, pickup_method, manual_reason)
    values (v_tenant, v_unit, v_conc, 'RETIRADA', 'DEMO000RET', 'Amazon', 'portaria', 'seed-ret-' || t.key,
      now() - interval '3 days', v_port, now() - interval '2 days', 'Morador Demo', v_port, 'manual', 'Registro histórico de demonstração');

    insert into public.packages (tenant_id, unit_id, concierge_location_id, status, tracking_code, carrier, registered_via,
      idempotency_key, received_at, received_by, resolution_reason, resolved_at, resolved_by)
    values
      (v_tenant, v_unit, v_conc, 'CANCELADA', 'DEMO000CAN', 'Shopee', 'portaria', 'seed-can-' || t.key, now() - interval '5 days', v_port, 'Registro duplicado por engano (demo)', now() - interval '5 days', v_admin),
      (v_tenant, v_unit2, v_conc, 'DEVOLVIDA', 'DEMO000DEV', 'Correios', 'portaria', 'seed-dev-' || t.key, now() - interval '6 days', v_port, 'Destinatário desconhecido no condomínio (demo)', now() - interval '4 days', v_port),
      (v_tenant, v_unit2, v_conc, 'EXTRAVIADA', 'DEMO000EXT', 'Outra', 'portaria', 'seed-ext-' || t.key, now() - interval '9 days', v_port, 'Não localizada na conferência semanal (demo)', now() - interval '7 days', v_admin);

    insert into public.package_events (tenant_id, package_id, type, data)
    select tenant_id, id, 'seeded', jsonb_build_object('note', 'dados fictícios') from public.packages where tenant_id = v_tenant;
  end loop;
end $$;
