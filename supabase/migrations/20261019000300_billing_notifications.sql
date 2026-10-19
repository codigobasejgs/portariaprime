-- =============================================================================
-- PORTARIA PRIME — 0300: planos, assinatura/trial, cobrança InfinitePay,
-- contadores de uso e outbox de notificações.
-- =============================================================================

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_-]{2,30}$'),
  name text not null,
  description text,
  sort_order int not null default 0,
  is_custom boolean not null default false,  -- "Sob medida": sem checkout, só consulta
  published boolean not null default false,  -- só planos publicados aceitam trial/compra
  created_at timestamptz not null default now()
);

-- Preços versionados em centavos (BRL). Pedido guarda snapshot; mudar catálogo
-- não altera fatura aberta nem período pago.
create table public.plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id) on delete restrict,
  cycle text not null check (cycle in ('monthly', 'quarterly', 'yearly')),
  amount_cents int not null check (amount_cents > 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  version int not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (plan_id, cycle, version)
);
create unique index plan_prices_active_uq on public.plan_prices (plan_id, cycle) where active;

create table public.plan_entitlements (
  plan_id uuid primary key references public.plans(id) on delete cascade,
  max_units int not null check (max_units > 0),
  max_concierges int not null check (max_concierges > 0),
  ocr_monthly int not null default 0 check (ocr_monthly >= 0),
  whatsapp_monthly int not null default 0 check (whatsapp_monthly >= 0),
  storage_mb int not null default 1024 check (storage_mb > 0),
  feature_ocr boolean not null default false,
  feature_whatsapp boolean not null default false,
  feature_totem boolean not null default false,
  feature_reports_plus boolean not null default false
);

-- Uma assinatura por condomínio.
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  status text not null check (status in ('trialing', 'pending_payment', 'active', 'past_due', 'suspended', 'canceled')),
  plan_id uuid not null references public.plans(id),
  cycle text not null check (cycle in ('monthly', 'quarterly', 'yearly')),
  price_id uuid not null references public.plan_prices(id),   -- preço futuro aceito
  price_cents_snapshot int not null,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  trial_extended_reason text,
  current_period_start timestamptz,
  current_period_end timestamptz,   -- exclusiva
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  next_plan_id uuid references public.plans(id),
  next_cycle text check (next_cycle in ('monthly', 'quarterly', 'yearly')),
  next_price_id uuid references public.plan_prices(id),
  reminders_sent text[] not null default '{}',
  updated_at timestamptz not null default now(),
  check (status <> 'trialing' or (trial_started_at is not null and trial_ends_at > trial_started_at))
);

-- Elegibilidade ao mês grátis: chave por documento (CNPJ/CPF) e por nome+cidade
-- normalizados. Sobrevive à exclusão do condomínio — impede trial repetido.
create table public.trial_eligibility (
  key text primary key,
  tenant_id uuid,
  used_at timestamptz not null default now()
);

create table public.billing_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  subscription_id uuid not null references public.subscriptions(id),
  order_nsu text not null unique,
  plan_id uuid not null references public.plans(id),
  price_id uuid not null references public.plan_prices(id),
  cycle text not null,
  amount_cents int not null check (amount_cents > 0),
  snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'link_failed', 'paid', 'canceled', 'review')),
  kind text not null check (kind in ('first_after_trial', 'renewal', 'reactivation')),
  checkout_url text,
  provider_slug text,
  transaction_nsu text unique,
  receipt_url text,
  paid_amount_cents int,
  paid_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  review_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- No máximo um pedido aberto por assinatura (job duplicado/retry não duplica).
create unique index billing_orders_open_uq on public.billing_orders (subscription_id)
  where status in ('pending', 'link_failed');
create index billing_orders_tenant_idx on public.billing_orders (tenant_id, created_at desc);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  order_id uuid not null references public.billing_orders(id),
  transaction_nsu text not null unique,
  amount_cents int not null,
  paid_amount_cents int not null,
  installments int,
  capture_method text,
  receipt_url text,
  verified_via text not null check (verified_via in ('payment_check')),
  created_at timestamptz not null default now()
);

-- Eventos crus do webhook, gravados antes de processar. Não confiáveis por si.
create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('webhook', 'redirect', 'reconcile')),
  dedupe_key text not null unique,
  order_nsu text,
  transaction_nsu text,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'review', 'error')),
  error text,
  attempts int not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index payment_events_status_idx on public.payment_events (status, received_at);

-- Ocorrências financeiras que exigem humano (pagamento duplicado, divergência…).
create table public.billing_incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  order_id uuid references public.billing_orders(id),
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.usage_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  metric text not null check (metric in ('ocr', 'whatsapp')),
  period text not null check (period ~ '^\d{4}-\d{2}$'),
  used int not null default 0 check (used >= 0),
  primary key (tenant_id, metric, period)
);

-- -----------------------------------------------------------------------------
-- Notificações
-- -----------------------------------------------------------------------------
create table public.notifications (           -- caixa interna por usuário
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  package_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, tenant_id, created_at desc);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, endpoint)
);

-- Outbox: nasce na mesma transação do evento. Destinatário resolvido no servidor.
create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event text not null check (event in ('package_received', 'package_picked_up', 'invitation', 'trial_reminder', 'billing_order', 'billing_paid')),
  channel text not null check (channel in ('whatsapp', 'email', 'push')),
  recipient text not null,           -- telefone/e-mail/user_id, resolvido pelo servidor
  ref_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'sending', 'accepted', 'delivered', 'failed', 'disabled')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event, channel, recipient, ref_id)  -- deduplicação
);
create index notification_jobs_due_idx on public.notification_jobs (status, next_attempt_at);

create table public.notification_attempts (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.notification_jobs(id) on delete cascade,
  tenant_id uuid not null,
  ok boolean not null,
  provider_ref text,
  error text,
  created_at timestamptz not null default now()
);

-- Contato comercial (formulário da landing), com rate limit simples por hash de IP.
create table public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 120),
  email text not null check (email like '%@%' and length(email) <= 200),
  phone text check (phone is null or length(phone) <= 30),
  message text not null check (length(btrim(message)) between 5 and 2000),
  ip_hash text,
  created_at timestamptz not null default now()
);
