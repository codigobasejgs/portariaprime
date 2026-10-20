-- Correções incrementais: reconciliação, períodos futuros, revogação, totem e push.
-- Nenhuma chamada externa; não altera migrations já executadas.

alter table public.subscriptions
  add column previous_plan_id uuid references public.plans(id),
  add column previous_price_id uuid references public.plan_prices(id),
  add column previous_cycle text,
  add column previous_price_cents int,
  add column previous_period_start timestamptz,
  add column previous_period_end timestamptz;

-- O contrato pago futuro fica persistido; o contrato vigente é resolvido pelo
-- relógio do servidor em cada leitura, sem depender de execução do scheduler.
create function app.effective_subscription(p_tenant uuid) returns public.subscriptions
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions;
begin
  select * into s from public.subscriptions where tenant_id = p_tenant;
  if s.previous_plan_id is not null and app.now() < s.current_period_start then
    s.next_plan_id := s.plan_id;
    s.next_price_id := s.price_id;
    s.next_cycle := s.cycle;
    s.plan_id := s.previous_plan_id;
    s.price_id := s.previous_price_id;
    s.cycle := s.previous_cycle;
    s.price_cents_snapshot := s.previous_price_cents;
    s.current_period_start := s.previous_period_start;
    s.current_period_end := s.previous_period_end;
  end if;
  return s;
end $$;

create or replace function app.entitlements(p_tenant uuid) returns public.plan_entitlements
language sql stable security definer set search_path = '' as $$
  select e.* from public.plan_entitlements e
  where e.plan_id = (app.effective_subscription(p_tenant)).plan_id
$$;

alter function public.subscription_overview(uuid) rename to subscription_overview_before_security_fix;
create function public.subscription_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.subscriptions; result jsonb;
begin
  perform app.require(app.is_member(p_tenant));
  result := public.subscription_overview_before_security_fix(p_tenant);
  s := app.effective_subscription(p_tenant);
  return result || jsonb_build_object(
    'plan', (select jsonb_build_object('code', code, 'name', name) from public.plans where id = s.plan_id),
    'cycle', s.cycle, 'price_cents', s.price_cents_snapshot,
    'current_period_start', s.current_period_start, 'current_period_end', s.current_period_end,
    'next_plan', (select jsonb_build_object('code', code, 'name', name, 'cycle', s.next_cycle) from public.plans where id = s.next_plan_id),
    'entitlements', to_jsonb(app.entitlements(p_tenant)) - 'plan_id');
end $$;

alter function public.apply_verified_payment(text,text,text,int,int,int,text,text)
  rename to apply_verified_payment_before_security_fix;
create function public.apply_verified_payment(
  p_order_nsu text, p_transaction_nsu text, p_slug text, p_amount int, p_paid_amount int,
  p_installments int, p_capture_method text, p_receipt_url text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.billing_orders; s public.subscriptions; result jsonb;
begin
  -- Serializa inclusive verificações repetidas do mesmo pedido.
  select * into o from public.billing_orders where order_nsu = p_order_nsu for update;
  if found then
    if o.status in ('canceled', 'review') then
      if o.status = 'canceled' then
        update public.billing_orders set status = 'review', review_reason = 'Pagamento de pedido cancelado exige análise', updated_at = now() where id = o.id;
        insert into public.billing_incidents(tenant_id, order_id, kind, detail)
        values(o.tenant_id, o.id, 'paid_canceled_order', jsonb_build_object('transaction_nsu', p_transaction_nsu));
      end if;
      return jsonb_build_object('result', 'review', 'reason', 'order_not_payable');
    end if;
    select * into s from public.subscriptions where id = o.subscription_id for update;
    -- Não substitui outra renovação futura já paga por uma cadeia de planos ambígua.
    if o.status <> 'paid' and s.previous_plan_id is not null and app.now() < s.current_period_start then
      update public.billing_orders set status = 'review', review_reason = 'Já existe período futuro pago' where id = o.id;
      insert into public.billing_incidents(tenant_id, order_id, kind)
      values(o.tenant_id, o.id, 'future_period_already_paid');
      return jsonb_build_object('result', 'review', 'reason', 'future_period_already_paid');
    end if;
  end if;
  result := public.apply_verified_payment_before_security_fix(p_order_nsu, p_transaction_nsu, p_slug,
    p_amount, p_paid_amount, p_installments, p_capture_method, p_receipt_url);
  if result->>'result' = 'activated' then
    update public.subscriptions set
      previous_plan_id = case when s.current_period_end > app.now() then s.plan_id end,
      previous_price_id = case when s.current_period_end > app.now() then s.price_id end,
      previous_cycle = case when s.current_period_end > app.now() then s.cycle end,
      previous_price_cents = case when s.current_period_end > app.now() then s.price_cents_snapshot end,
      previous_period_start = case when s.current_period_end > app.now() then s.current_period_start end,
      previous_period_end = case when s.current_period_end > app.now() then s.current_period_end end
    where id = s.id;
  end if;
  return result;
end $$;

-- Suspensão do condomínio também vale para dispositivo com credencial válida.
create or replace function app.can_operate(p_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.tenants where id = p_tenant and status = 'active')
    and app.commercial_state(p_tenant) in ('full', 'grace')
$$;

-- Retira contatos de usuários revogados. Não reativa contatos automaticamente.
create function app.revoke_resident_contacts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'morador' and new.status = 'revoked' then
    update public.resident_contacts set active = false
    where tenant_id = new.tenant_id and user_id = new.user_id;
  end if;
  return new;
end $$;
create trigger membership_contacts_revoked after update of status on public.tenant_memberships
for each row execute function app.revoke_resident_contacts();
update public.resident_contacts c set active = false where c.user_id is not null and exists (
  select 1 from public.tenant_memberships m where m.tenant_id = c.tenant_id and m.user_id = c.user_id
    and m.role = 'morador' and m.status = 'revoked');

-- Resolve autorização novamente ao enviar, não apenas quando enfileirado.
create function app.notification_allowed(j public.notification_jobs) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare u uuid;
begin
  if not exists(select 1 from public.tenants where id = j.tenant_id and status = 'active') then return false; end if;
  if j.event in ('package_received','package_picked_up') then
    select unit_id into u from public.packages where tenant_id = j.tenant_id and id::text = j.ref_id;
    if u is null then return false; end if;
    if j.channel = 'push' then
      return exists(select 1 from public.unit_memberships um join public.tenant_memberships m
        on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
        where um.tenant_id = j.tenant_id and um.unit_id = u and um.user_id::text = j.recipient and um.status = 'active');
    end if;
    return exists(select 1 from public.resident_contacts c where c.tenant_id = j.tenant_id and c.unit_id = u and c.active
      and ((j.channel = 'email' and c.notify_email and c.email = j.recipient)
        or (j.channel = 'whatsapp' and c.notify_whatsapp and c.phone = j.recipient))
      and (c.user_id is null or exists(select 1 from public.unit_memberships um join public.tenant_memberships m
        on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
        where um.tenant_id = c.tenant_id and um.unit_id = c.unit_id and um.user_id = c.user_id and um.status = 'active')));
  end if;
  if j.event in ('trial_reminder','billing_order','billing_paid') then
    return j.channel = 'email' and j.recipient in (select app.billing_admin_emails(j.tenant_id));
  end if;
  return false;
end $$;
create function public.notification_is_authorized(p_job uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select app.notification_allowed(j) from public.notification_jobs j where id = p_job),false)
$$;
create function app.guard_notification_recipient() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not app.notification_allowed(new) then return null; end if;
  return new;
end $$;
create trigger notification_recipient_guard before insert on public.notification_jobs
for each row execute function app.guard_notification_recipient();

-- Endpoints Web Push somente de serviços conhecidos. Sem IPs, portas customizadas,
-- userinfo, hosts parecidos ou redirecionamento controlado pelo assinante.
create function app.valid_push_endpoint(p_endpoint text) returns boolean
language sql immutable set search_path = '' as $$
  select p_endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:]#]*$'
$$;
alter table public.push_subscriptions add constraint push_endpoint_allowlist
  check(app.valid_push_endpoint(endpoint)) not valid;
-- Inscrições antigas fora da lista não são enviadas; a função de envio revalida.
grant execute on function app.valid_push_endpoint(text) to authenticated, service_role;

-- Wrappers antigos só são acessíveis pelo proprietário das funções, nunca via API.
revoke all on function public.subscription_overview_before_security_fix(uuid),
 public.apply_verified_payment_before_security_fix(text,text,text,int,int,int,text,text)
 from public, anon, authenticated, service_role;
revoke all on function app.effective_subscription(uuid), app.notification_allowed(public.notification_jobs),
 app.revoke_resident_contacts(), app.guard_notification_recipient(), app.valid_push_endpoint(text)
 from public, anon;
revoke all on function public.subscription_overview(uuid), public.apply_verified_payment(text,text,text,int,int,int,text,text),
 public.notification_is_authorized(uuid) from public, anon, authenticated;
grant execute on function public.subscription_overview(uuid) to authenticated, service_role;
grant execute on function public.apply_verified_payment(text,text,text,int,int,int,text,text),
 public.notification_is_authorized(uuid) to service_role;
