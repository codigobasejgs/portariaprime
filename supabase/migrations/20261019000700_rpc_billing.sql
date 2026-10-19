-- =============================================================================
-- PORTARIA PRIME — 0700: ciclo comercial (trial, plano, pedidos, pagamento)
-- "Renovação com pagamento por link": não há débito automático.
-- =============================================================================

create or replace function app.billing_admin_emails(p_tenant uuid) returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct lower(u.email::text) from public.tenant_memberships m join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant and m.status = 'active' and m.role = 'admin' and 'billing' = any (m.permissions)
$$;

create or replace function app.enqueue_billing_email(p_tenant uuid, p_event text, p_ref text, p_payload jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  select p_tenant, p_event, 'email', e, p_ref, p_payload from app.billing_admin_emails(p_tenant) e
  on conflict do nothing
$$;

-- Cria (ou devolve) o pedido aberto da assinatura. Valor vem do snapshot aceito,
-- ou do plano agendado para o próximo ciclo. Índice único impede pedido duplicado.
create or replace function app.ensure_open_order(p_sub uuid, p_kind text, p_actor uuid default null)
returns public.billing_orders language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; o public.billing_orders; pr public.plan_prices; pl public.plans;
begin
  select * into s from public.subscriptions where id = p_sub for update;
  select * into o from public.billing_orders where subscription_id = p_sub and status in ('pending', 'link_failed');
  if found then return o; end if;
  select * into pr from public.plan_prices where id = coalesce(s.next_price_id, s.price_id);
  select * into pl from public.plans where id = pr.plan_id;
  insert into public.billing_orders (tenant_id, subscription_id, order_nsu, plan_id, price_id, cycle, amount_cents, snapshot, kind, created_by)
  values (s.tenant_id, s.id, 'pp-' || replace(gen_random_uuid()::text, '-', ''), pl.id, pr.id, pr.cycle,
    case when s.next_price_id is null then s.price_cents_snapshot else pr.amount_cents end,
    jsonb_build_object('plan_code', pl.code, 'plan_name', pl.name, 'cycle', pr.cycle, 'price_version', pr.version,
      'amount_cents', case when s.next_price_id is null then s.price_cents_snapshot else pr.amount_cents end),
    p_kind, p_actor)
  returning * into o;
  perform app.enqueue_billing_email(s.tenant_id, 'billing_order', o.id::text,
    jsonb_build_object('order_id', o.id, 'amount_cents', o.amount_cents, 'plan_name', pl.name, 'cycle', pr.cycle));
  return o;
end $$;

-- -----------------------------------------------------------------------------
-- Job periódico (idempotente; pode rodar em paralelo/atrasado). Chamado pela
-- API /api/jobs/tick com segredo. A RLS/RPC já aplica o vencimento por data,
-- independentemente do job.
-- -----------------------------------------------------------------------------
create or replace function app.tick_subscription(p_sub uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; v_now timestamptz := app.now(); k text; v_days numeric; v_out text := 'none';
begin
  select * into s from public.subscriptions where id = p_sub for update skip locked;
  if not found then return 'locked'; end if;
  -- Lembretes do teste: D-7, D-3 e no término (deduplicados).
  if s.status = 'trialing' and not s.cancel_at_period_end then
    v_days := extract(epoch from s.trial_ends_at - v_now) / 86400;
    k := case when v_days <= 0 then 'trial_end' when v_days <= 3 then 'trial_d3' when v_days <= 7 then 'trial_d7' end;
    if k is not null and not (k = any (s.reminders_sent)) then
      perform app.enqueue_billing_email(s.tenant_id, 'trial_reminder', s.id::text || ':' || k,
        jsonb_build_object('kind', k, 'trial_ends_at', s.trial_ends_at, 'amount_cents', s.price_cents_snapshot, 'cycle', s.cycle));
      update public.subscriptions set reminders_sent = reminders_sent || k where id = s.id;
      v_out := 'reminder';
    end if;
  end if;

  if s.status = 'trialing' and v_now >= s.trial_ends_at then
    if s.cancel_at_period_end then
      update public.subscriptions set status = 'canceled', updated_at = now() where id = s.id;
      return 'canceled';
    end if;
    update public.subscriptions set status = 'pending_payment', updated_at = now() where id = s.id;
    perform app.ensure_open_order(s.id, 'first_after_trial');
    return 'first_order';
  elsif s.status = 'active' then
    if s.cancel_at_period_end and v_now >= s.current_period_end then
      update public.subscriptions set status = 'canceled', updated_at = now() where id = s.id;
      return 'canceled';
    elsif not s.cancel_at_period_end and v_now >= s.current_period_end - interval '7 days' then
      perform app.ensure_open_order(s.id, 'renewal');  -- devolve o existente se já houver
      if v_now >= s.current_period_end then
        update public.subscriptions set status = 'past_due', updated_at = now() where id = s.id;
        return 'past_due';
      end if;
      return 'renewal_order';
    end if;
  end if;
  return v_out;
end $$;

-- Job periódico (idempotente; pode rodar em paralelo/atrasado). Chamado pela
-- API /api/jobs/tick com segredo. O acesso já é decidido por data em
-- app.commercial_state, mesmo se este job atrasar.
create or replace function public.billing_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_res jsonb := '{}'::jsonb; k text;
begin
  for r in select s.id from public.subscriptions s join public.tenants t on t.id = s.tenant_id
            where t.status = 'active' and s.status in ('trialing', 'active') loop
    k := app.tick_subscription(r.id);
    v_res := jsonb_set(v_res, array[k], to_jsonb(coalesce((v_res ->> k)::int, 0) + 1));
  end loop;
  return v_res || jsonb_build_object('at', app.now());
end $$;

-- -----------------------------------------------------------------------------
-- Ações do gestor
-- -----------------------------------------------------------------------------
create or replace function public.subscription_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions; pl public.plans; e public.plan_entitlements; nx public.plans;
begin
  perform app.require(app.is_member(p_tenant));
  select * into s from public.subscriptions where tenant_id = p_tenant;
  select * into pl from public.plans where id = s.plan_id;
  select * into e from public.plan_entitlements where plan_id = s.plan_id;
  select * into nx from public.plans where id = s.next_plan_id;
  return jsonb_build_object(
    'status', s.status, 'commercial_state', app.commercial_state(p_tenant), 'now', app.now(),
    'plan', jsonb_build_object('code', pl.code, 'name', pl.name), 'cycle', s.cycle,
    'price_cents', s.price_cents_snapshot, 'trial_started_at', s.trial_started_at, 'trial_ends_at', s.trial_ends_at,
    'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
    'grace_days', (select grace_days from public.tenant_settings where tenant_id = p_tenant),
    'access_until', app.access_until(p_tenant), 'cancel_at_period_end', s.cancel_at_period_end,
    'next_plan', case when nx.id is null then null else jsonb_build_object('code', nx.code, 'name', nx.name, 'cycle', s.next_cycle) end,
    'entitlements', to_jsonb(e) - 'plan_id',
    'usage', jsonb_build_object(
      'units', (select count(*) from public.units where tenant_id = p_tenant and active),
      'concierges', (select count(*) from public.concierge_locations where tenant_id = p_tenant and active),
      'ocr', coalesce((select used from public.usage_counters where tenant_id = p_tenant and metric = 'ocr' and period = to_char(app.now() at time zone 'UTC', 'YYYY-MM')), 0),
      'whatsapp', coalesce((select used from public.usage_counters where tenant_id = p_tenant and metric = 'whatsapp' and period = to_char(app.now() at time zone 'UTC', 'YYYY-MM')), 0)),
    'can_manage', app.has_perm(p_tenant, 'billing'));
end $$;

-- Troca de plano. No teste: aplica já (mantém o vencimento original do teste).
-- Assinatura paga: agenda para o próximo ciclo (sem pró-rata), se o uso couber.
create or replace function public.change_plan(p_tenant uuid, p_plan_code text, p_cycle text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; pl public.plans; pr public.plan_prices; e public.plan_entitlements; v_units int;
begin
  perform app.require(app.has_perm(p_tenant, 'billing'));
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  select * into pl from public.plans where code = p_plan_code and published and not is_custom;
  if not found then raise exception 'Plano indisponível.' using errcode = '22023'; end if;
  select * into pr from public.plan_prices where plan_id = pl.id and cycle = p_cycle and active;
  if not found then raise exception 'Ciclo indisponível.' using errcode = '22023'; end if;
  select * into e from public.plan_entitlements where plan_id = pl.id;
  select count(*) into v_units from public.units where tenant_id = p_tenant and active;
  if v_units > e.max_units then
    raise exception 'O condomínio tem % unidades ativas; o plano % permite %. Nenhum dado é apagado, mas é preciso desativar unidades antes.', v_units, pl.name, e.max_units
      using errcode = 'P0001';
  end if;

  if s.status = 'trialing' then
    update public.subscriptions set plan_id = pl.id, cycle = p_cycle, price_id = pr.id, price_cents_snapshot = pr.amount_cents,
      next_plan_id = null, next_cycle = null, next_price_id = null, updated_at = now() where id = s.id;
    perform app.audit(p_tenant, 'subscription.plan_changed_trial', 'subscription', s.id::text, jsonb_build_object('plan', pl.code, 'cycle', p_cycle));
    return jsonb_build_object('effective', 'now', 'trial_ends_at', s.trial_ends_at);
  end if;
  update public.subscriptions set next_plan_id = pl.id, next_cycle = p_cycle, next_price_id = pr.id, updated_at = now() where id = s.id;
  -- Pedido aberto ainda não pago passa a refletir o novo plano.
  update public.billing_orders set status = 'canceled', updated_at = now()
   where subscription_id = s.id and status in ('pending', 'link_failed');
  perform app.audit(p_tenant, 'subscription.plan_scheduled', 'subscription', s.id::text, jsonb_build_object('plan', pl.code, 'cycle', p_cycle));
  return jsonb_build_object('effective', 'next_cycle', 'effective_at', s.current_period_end);
end $$;

create or replace function public.cancel_subscription(p_tenant uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  perform app.require(app.has_perm(p_tenant, 'billing'));
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  if s.status = 'canceled' then return; end if;
  update public.subscriptions set cancel_at_period_end = true, canceled_at = app.now(), updated_at = now() where id = s.id;
  update public.billing_orders set status = 'canceled', updated_at = now()
   where subscription_id = s.id and status in ('pending', 'link_failed');
  if s.status in ('pending_payment', 'past_due') then
    update public.subscriptions set status = 'canceled' where id = s.id;
  end if;
  perform app.audit(p_tenant, 'subscription.canceled', 'subscription', s.id::text);
end $$;

-- Reativar: no teste/período vigente mantém as datas originais (não recria teste).
create or replace function public.reactivate_subscription(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; v_now timestamptz := app.now();
begin
  perform app.require(app.has_perm(p_tenant, 'billing'));
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  if s.status in ('trialing', 'active') and s.cancel_at_period_end and v_now < app.access_until(p_tenant) then
    update public.subscriptions set cancel_at_period_end = false, canceled_at = null, updated_at = now() where id = s.id;
    perform app.audit(p_tenant, 'subscription.reactivated', 'subscription', s.id::text);
    return jsonb_build_object('status', s.status, 'access_until', app.access_until(p_tenant));
  end if;
  if s.status in ('canceled', 'pending_payment', 'past_due') or (s.status = 'trialing' and v_now >= s.trial_ends_at) then
    update public.subscriptions set status = case when status = 'canceled' then 'pending_payment' else status end,
      cancel_at_period_end = false, canceled_at = null, updated_at = now() where id = s.id;
    perform app.ensure_open_order(s.id, 'reactivation', auth.uid());
    return jsonb_build_object('status', 'pending_payment');
  end if;
  return jsonb_build_object('status', s.status);
end $$;

-- Prepara o checkout (chamado pela API com o JWT do gestor). Durante o teste
-- não existe cobrança. Devolve o pedido aberto, criando-o quando cabível.
create or replace function public.prepare_checkout(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; o public.billing_orders; v_now timestamptz := app.now();
begin
  perform app.require(app.has_perm(p_tenant, 'billing'), 'Somente quem gerencia o faturamento pode pagar a assinatura.');
  select * into s from public.subscriptions where tenant_id = p_tenant;
  if s.status = 'trialing' and v_now < s.trial_ends_at then
    raise exception 'Seu mês grátis vai até %. A primeira cobrança só fica disponível depois disso.',
      to_char(s.trial_ends_at at time zone (select timezone from public.tenants where id = p_tenant), 'DD/MM/YYYY HH24:MI')
      using errcode = 'P0001';
  end if;
  if s.status = 'trialing' then perform app.tick_subscription(s.id); select * into s from public.subscriptions where id = s.id; end if;
  if s.status = 'canceled' then raise exception 'Assinatura cancelada. Use "Reativar" para gerar uma nova cobrança.' using errcode = 'P0001'; end if;
  if s.status = 'active' and v_now < s.current_period_end - interval '7 days' then
    raise exception 'A renovação fica disponível 7 dias antes de %.', s.current_period_end using errcode = 'P0001';
  end if;
  o := app.ensure_open_order(s.id, case when s.status = 'active' then 'renewal' when s.current_period_end is null then 'first_after_trial' else 'renewal' end, auth.uid());
  return jsonb_build_object('order_id', o.id, 'order_nsu', o.order_nsu, 'amount_cents', o.amount_cents,
    'description', 'Portaria Prime — ' || (o.snapshot ->> 'plan_name') || ' (' || o.cycle || ')',
    'checkout_url', o.checkout_url, 'status', o.status);
end $$;

-- Somente service_role: grava o link criado no provedor.
create or replace function public.order_set_link(p_order uuid, p_url text, p_ok boolean) returns void
language sql security definer set search_path = '' as $$
  update public.billing_orders set checkout_url = case when p_ok then p_url else checkout_url end,
    status = case when p_ok then 'pending' else 'link_failed' end, updated_at = now()
  where id = p_order and status in ('pending', 'link_failed')
$$;

-- -----------------------------------------------------------------------------
-- Aplica pagamento JÁ VERIFICADO no provedor (payment_check paid=true).
-- Somente service_role. Idempotente por transaction_nsu; divergências viram
-- ocorrência para revisão, sem conceder acesso.
-- -----------------------------------------------------------------------------
create or replace function public.apply_verified_payment(
  p_order_nsu text, p_transaction_nsu text, p_slug text, p_amount int, p_paid_amount int,
  p_installments int, p_capture_method text, p_receipt_url text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.billing_orders; s public.subscriptions; v_tz text; v_now timestamptz := app.now();
        v_start timestamptz; v_end timestamptz; pr public.plan_prices;
begin
  if p_transaction_nsu is null or p_transaction_nsu = '' then raise exception 'transaction_nsu ausente' using errcode = '22023'; end if;
  if exists (select 1 from public.payments where transaction_nsu = p_transaction_nsu) then
    return jsonb_build_object('result', 'duplicate_ignored');
  end if;
  select * into o from public.billing_orders where order_nsu = p_order_nsu for update;
  if not found then
    insert into public.billing_incidents (kind, detail) values ('unknown_order',
      jsonb_build_object('order_nsu', p_order_nsu, 'transaction_nsu', p_transaction_nsu, 'amount', p_amount));
    return jsonb_build_object('result', 'review', 'reason', 'unknown_order');
  end if;
  if o.status = 'paid' then
    insert into public.billing_incidents (tenant_id, order_id, kind, detail) values (o.tenant_id, o.id, 'second_payment_same_order',
      jsonb_build_object('transaction_nsu', p_transaction_nsu, 'paid_amount', p_paid_amount));
    return jsonb_build_object('result', 'review', 'reason', 'already_paid');
  end if;
  if o.status = 'canceled' then
    update public.billing_orders set status = 'review', review_reason = 'Pagamento recebido para pedido cancelado', updated_at = now() where id = o.id;
    insert into public.billing_incidents (tenant_id, order_id, kind, detail) values (o.tenant_id, o.id, 'paid_canceled_order',
      jsonb_build_object('transaction_nsu', p_transaction_nsu, 'paid_amount', p_paid_amount));
    return jsonb_build_object('result', 'review', 'reason', 'order_canceled');
  end if;
  -- amount = valor-base do pedido; paid_amount pode incluir encargos do parcelamento.
  if p_amount is null or p_amount < o.amount_cents or coalesce(p_paid_amount, 0) < o.amount_cents then
    update public.billing_orders set status = 'review', review_reason = 'Valor divergente', updated_at = now() where id = o.id;
    insert into public.billing_incidents (tenant_id, order_id, kind, detail) values (o.tenant_id, o.id, 'amount_mismatch',
      jsonb_build_object('expected', o.amount_cents, 'amount', p_amount, 'paid_amount', p_paid_amount));
    return jsonb_build_object('result', 'review', 'reason', 'amount_mismatch');
  end if;

  select * into s from public.subscriptions where id = o.subscription_id for update;
  select timezone into v_tz from public.tenants where id = o.tenant_id;
  select * into pr from public.plan_prices where id = o.price_id;
  -- Renovação antecipada começa no fim do período vigente; senão, na confirmação.
  v_start := case when s.current_period_end is not null and s.current_period_end > v_now then s.current_period_end else v_now end;
  v_end := app.add_months(v_start, v_tz, app.cycle_months(o.cycle));

  insert into public.payments (tenant_id, order_id, transaction_nsu, amount_cents, paid_amount_cents, installments, capture_method, receipt_url, verified_via)
  values (o.tenant_id, o.id, p_transaction_nsu, p_amount, p_paid_amount, p_installments, p_capture_method, p_receipt_url, 'payment_check');
  update public.billing_orders set status = 'paid', transaction_nsu = p_transaction_nsu, provider_slug = coalesce(p_slug, provider_slug),
    receipt_url = p_receipt_url, paid_amount_cents = p_paid_amount, paid_at = v_now, period_start = v_start, period_end = v_end, updated_at = now()
  where id = o.id;
  update public.subscriptions set status = 'active', plan_id = o.plan_id, cycle = o.cycle, price_id = o.price_id,
    price_cents_snapshot = o.amount_cents, current_period_start = v_start, current_period_end = v_end,
    next_plan_id = null, next_cycle = null, next_price_id = null, cancel_at_period_end = false, updated_at = now()
  where id = s.id;
  insert into public.audit_logs (tenant_id, action, target_type, target_id, data)
  values (o.tenant_id, 'billing.paid', 'billing_order', o.id::text, jsonb_build_object('period_end', v_end, 'amount', o.amount_cents));
  perform app.enqueue_billing_email(o.tenant_id, 'billing_paid', o.id::text, jsonb_build_object('period_end', v_end, 'amount_cents', o.amount_cents));
  return jsonb_build_object('result', 'activated', 'period_start', v_start, 'period_end', v_end, 'tenant_id', o.tenant_id);
end $$;

-- Pedido mínimo e sanitizado (página de retorno / tela de assinatura).
create or replace function public.get_order(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.billing_orders;
begin
  select * into o from public.billing_orders where id = p_order;
  perform app.require(found and app.has_perm(o.tenant_id, 'billing'));
  return jsonb_build_object('id', o.id, 'status', o.status, 'amount_cents', o.amount_cents, 'cycle', o.cycle,
    'plan_name', o.snapshot ->> 'plan_name', 'checkout_url', case when o.status in ('pending') then o.checkout_url end,
    'paid_at', o.paid_at, 'period_end', o.period_end, 'tenant_id', o.tenant_id);
end $$;

-- Somente service_role: dados para reconciliar um pedido do tenant (sem confiar no browser).
create or replace function public.order_for_reconcile(p_order uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('order_nsu', o.order_nsu, 'transaction_nsu', o.transaction_nsu, 'slug', o.provider_slug,
    'status', o.status, 'tenant_id', o.tenant_id)
  from public.billing_orders o where o.id = p_order
$$;

-- -----------------------------------------------------------------------------
-- Superadministrador
-- -----------------------------------------------------------------------------
create or replace function public.admin_extend_trial(p_tenant uuid, p_new_end timestamptz, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  perform app.require(app.is_platform_admin());
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Justificativa obrigatória (mín. 10 caracteres).' using errcode = '22023'; end if;
  select * into s from public.subscriptions where tenant_id = p_tenant for update;
  if s.status not in ('trialing', 'pending_payment') or s.current_period_end is not null or p_new_end <= s.trial_ends_at then
    raise exception 'Prorrogação só se aplica a teste vigente ou recém-expirado, para data posterior.' using errcode = 'P0001';
  end if;
  update public.subscriptions set status = 'trialing', trial_ends_at = p_new_end,
    trial_extended_reason = btrim(p_reason), reminders_sent = '{}', updated_at = now() where id = s.id;
  update public.billing_orders set status = 'canceled', updated_at = now()
   where subscription_id = s.id and status in ('pending', 'link_failed');
  perform app.audit(p_tenant, 'admin.trial_extended', 'subscription', s.id::text,
    jsonb_build_object('from', s.trial_ends_at, 'to', p_new_end, 'reason', btrim(p_reason)));
end $$;

create or replace function public.admin_set_tenant_status(p_tenant uuid, p_status text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.is_platform_admin());
  if p_status not in ('active', 'suspended', 'closed') or length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'Situação e justificativa (mín. 10 caracteres) obrigatórias.' using errcode = '22023';
  end if;
  update public.tenants set status = p_status where id = p_tenant;
  perform app.audit(p_tenant, 'admin.tenant_status', 'tenant', p_tenant::text, jsonb_build_object('status', p_status, 'reason', btrim(p_reason)));
end $$;

-- Nova versão de preço (pedidos/períodos existentes mantêm o snapshot).
create or replace function public.admin_set_price(p_plan_code text, p_cycle text, p_amount_cents int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare pl public.plans; v_ver int; v_id uuid;
begin
  perform app.require(app.is_platform_admin());
  select * into pl from public.plans where code = p_plan_code;
  if not found or p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Dados inválidos.' using errcode = '22023'; end if;
  select coalesce(max(version), 0) + 1 into v_ver from public.plan_prices where plan_id = pl.id and cycle = p_cycle;
  update public.plan_prices set active = false where plan_id = pl.id and cycle = p_cycle and active;
  insert into public.plan_prices (plan_id, cycle, amount_cents, version) values (pl.id, p_cycle, p_amount_cents, v_ver) returning id into v_id;
  perform app.audit(null, 'admin.price_set', 'plan_price', v_id::text, jsonb_build_object('plan', p_plan_code, 'cycle', p_cycle, 'amount', p_amount_cents));
  return v_id;
end $$;

create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_platform_admin());
  return jsonb_build_object(
    'tenants', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status,
        'subscription', s.status, 'plan', p.code, 'trial_ends_at', s.trial_ends_at, 'period_end', s.current_period_end,
        'commercial_state', app.commercial_state(t.id), 'created_at', t.created_at) order by t.created_at desc)
      from public.tenants t left join public.subscriptions s on s.tenant_id = t.id left join public.plans p on p.id = s.plan_id), '[]'::jsonb),
    'incidents_open', (select count(*) from public.billing_incidents where resolved_at is null),
    'events_pending', (select count(*) from public.payment_events where status in ('received', 'error')),
    'jobs_failed', (select count(*) from public.notification_jobs where status = 'failed'));
end $$;
