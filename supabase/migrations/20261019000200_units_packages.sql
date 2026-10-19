-- =============================================================================
-- PORTARIA PRIME — 0200: unidades, moradores, locais, encomendas e provas
-- Todas as tabelas de negócio têm tenant_id NOT NULL e FKs compostas
-- (tenant_id, id) para impedir referência cruzada entre condomínios.
-- =============================================================================

create table public.units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  block text check (block is null or length(btrim(block)) between 1 and 30),
  label text not null check (length(btrim(label)) between 1 and 30), -- 101A, Casa 12, Sala 02
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
-- Unicidade por condomínio, ignorando caixa e espaços.
create unique index units_tenant_label_uq on public.units
  (tenant_id, upper(btrim(coalesce(block, ''))), upper(btrim(label)));

create table public.unit_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  relation text not null default 'morador' check (length(relation) <= 30),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id) on delete cascade,
  unique (unit_id, user_id)
);
create index unit_memberships_user_idx on public.unit_memberships (user_id, status);

-- Contatos por pessoa (vários familiares por unidade); preferências por contato.
create table public.resident_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  user_id uuid references auth.users(id) on delete set null,
  name text not null check (length(btrim(name)) between 2 and 120),
  phone text check (phone is null or phone ~ '^\+?\d{10,15}$'),
  email text check (email is null or (email = lower(btrim(email)) and email like '%@%')),
  notify_whatsapp boolean not null default true,
  notify_email boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id) on delete cascade
);
create index resident_contacts_unit_idx on public.resident_contacts (tenant_id, unit_id);

create table public.concierge_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.storage_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  concierge_location_id uuid not null,
  code text not null check (length(btrim(code)) between 1 and 20),  -- ex.: A1, Prateleira 3
  capacity int not null check (capacity between 1 and 1000),
  sort_order int not null default 0,
  is_contingency boolean not null default false,
  active boolean not null default true,
  unique (tenant_id, id),
  foreign key (tenant_id, concierge_location_id) references public.concierge_locations (tenant_id, id) on delete cascade
);
create unique index storage_locations_code_uq on public.storage_locations
  (tenant_id, concierge_location_id, upper(btrim(code)));

-- -----------------------------------------------------------------------------
-- Encomendas
-- PRE_REGISTRADA: deixada via totem, aguardando conferência da portaria.
-- RECEBIDA/ARMAZENADA: fisicamente na portaria. "Avisada" não é estado físico:
-- é notified_at (o canal de aviso não muda a ocupação).
-- -----------------------------------------------------------------------------
create table public.packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  unit_id uuid,
  concierge_location_id uuid,
  storage_location_id uuid,
  status text not null check (status in
    ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA', 'RETIRADA', 'CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA')),
  tracking_code text check (tracking_code is null or length(tracking_code) <= 80),
  carrier text not null default 'Outra' check (length(carrier) <= 40),
  recipient_name text check (recipient_name is null or length(recipient_name) <= 120),
  notes text check (notes is null or length(notes) <= 500),
  registered_via text not null default 'portaria' check (registered_via in ('portaria', 'totem')),
  courier_name text check (courier_name is null or length(courier_name) <= 80),
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  received_at timestamptz not null default now(),
  received_by uuid references auth.users(id) on delete set null,
  stored_at timestamptz,
  notified_at timestamptz,
  picked_up_at timestamptz,
  picked_up_by_name text,
  delivered_by uuid references auth.users(id) on delete set null,
  pickup_method text check (pickup_method in ('qr', 'manual')),
  manual_reason text,
  resolution_reason text,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id),
  foreign key (tenant_id, concierge_location_id) references public.concierge_locations (tenant_id, id),
  foreign key (tenant_id, storage_location_id) references public.storage_locations (tenant_id, id),
  check (status = 'PRE_REGISTRADA' or unit_id is not null),
  check (status <> 'RETIRADA' or (picked_up_at is not null and length(btrim(picked_up_by_name)) > 0 and pickup_method is not null)),
  check (pickup_method is distinct from 'manual' or length(btrim(manual_reason)) >= 10),
  check (status not in ('CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA') or length(btrim(resolution_reason)) >= 10),
  check (picked_up_at is null or picked_up_at >= received_at)
);
create index packages_tenant_status_idx on public.packages (tenant_id, status, received_at desc);
create index packages_tenant_unit_idx on public.packages (tenant_id, unit_id, received_at desc);
create index packages_tenant_received_idx on public.packages (tenant_id, received_at desc);
create index packages_storage_idx on public.packages (tenant_id, storage_location_id) where status in ('RECEBIDA', 'ARMAZENADA');
-- Rastreio ativo único por condomínio (o mesmo rastreio pode existir em outro condomínio).
create unique index packages_tracking_active_uq on public.packages (tenant_id, upper(tracking_code))
  where tracking_code is not null and status in ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA');

-- Regra única e compartilhada de ocupação física / pendência.
create or replace function app.occupies_space(p_status text) returns boolean
language sql immutable set search_path = '' as $$ select p_status in ('RECEBIDA', 'ARMAZENADA') $$;
create or replace function app.is_pending(p_status text) returns boolean
language sql immutable set search_path = '' as $$ select p_status in ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA') $$;

create table public.package_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  package_id uuid not null,
  type text not null,
  actor_id uuid,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id)
);
create index package_events_pkg_idx on public.package_events (tenant_id, package_id, created_at);
create trigger package_events_append_only before update or delete on public.package_events
  for each row execute function app.block_mutation();

-- Provas guardadas por object key (nunca por URL assinada).
create table public.package_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  package_id uuid not null,
  kind text not null check (kind in ('label_photo', 'signature', 'handover_photo')),
  object_path text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id),
  check (split_part(object_path, '/', 1) = tenant_id::text)
);
create index package_attachments_pkg_idx on public.package_attachments (tenant_id, package_id);

-- QR opaco: somente o hash fica no banco.
create table public.pickup_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  package_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id)
);
create index pickup_tokens_pkg_idx on public.pickup_tokens (tenant_id, package_id);

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  package_id uuid not null,
  protocol text not null,
  issued_at timestamptz not null default now(),
  snapshot jsonb not null,
  unique (tenant_id, protocol),
  unique (tenant_id, package_id),
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id)
);
create trigger receipts_append_only before update or delete on public.receipts
  for each row execute function app.block_mutation();

-- Totem: dispositivo pareado, credencial por dispositivo (hash), revogável.
create table public.device_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 60),
  concierge_location_id uuid,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  secret_hash text unique,
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  last_seen_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, concierge_location_id) references public.concierge_locations (tenant_id, id)
);

-- Morador tem acesso a esta unidade?
create or replace function app.is_unit_member(p_tenant uuid, p_unit uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_role(p_tenant, array['morador']) and exists (
    select 1 from public.unit_memberships um
    where um.tenant_id = p_tenant and um.unit_id = p_unit and um.user_id = auth.uid() and um.status = 'active')
$$;
