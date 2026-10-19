-- =============================================================================
-- PORTARIA PRIME — 0100: base multi-tenant (condomínios, identidade, vínculos)
-- Cadeia canônica. As migrations antigas do Village Azaleia estão em
-- supabase/legacy/ e NÃO fazem parte desta cadeia.
-- Requer um projeto Supabase novo (schemas auth e storage já existem).
-- =============================================================================

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- Configuração interna (flags de teste). Nenhum papel de cliente acessa.
create table app.config (key text primary key, value text not null);
revoke all on app.config from public;

-- Relógio: em produção é sempre now(). Testes podem congelar o relógio apenas
-- se a flag 'test_clock' existir em app.config (nunca criada em produção).
create or replace function app.now() returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if exists (select 1 from app.config where key = 'test_clock' and value = 'on') then
    v := current_setting('app.test_now', true);
    if v is not null and v <> '' then return v::timestamptz; end if;
  end if;
  return now();
end $$;

-- Soma meses de calendário no fuso do condomínio, preservando horário local.
-- 31/01 + 1 mês = último dia de fevereiro (regra nativa do Postgres para intervalos).
create or replace function app.add_months(p_ts timestamptz, p_tz text, p_months int)
returns timestamptz language sql stable set search_path = '' as $$
  select ((p_ts at time zone p_tz) + make_interval(months => p_months)) at time zone p_tz
$$;

create or replace function app.cycle_months(p_cycle text) returns int
language sql immutable set search_path = '' as $$
  select case p_cycle when 'monthly' then 1 when 'quarterly' then 3 when 'yearly' then 12 end
$$;

create or replace function app.valid_timezone(p_tz text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz)
$$;

create or replace function app.digits(p text) returns text
language sql immutable set search_path = '' as $$ select nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') $$;

create or replace function app.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

-- Token aleatório opaco (~244 bits) sem depender de pgcrypto.
create or replace function app.random_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

-- -----------------------------------------------------------------------------
-- Condomínios (tenants)
-- -----------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  document text check (document ~ '^\d{11}$|^\d{14}$'),
  contact_email text,
  contact_phone text,
  timezone text not null default 'America/Sao_Paulo' check (app.valid_timezone(timezone)),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  provision_request_id uuid unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Perfil = identidade do usuário Auth. Sem autoridade nenhuma.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or length(full_name) <= 120),
  phone text check (phone is null or length(phone) <= 30),
  created_at timestamptz not null default now()
);

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, left(nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), ''), 120))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- Privilégio global — escrito só por script de bootstrap (service role).
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);

create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'porteiro', 'morador')),
  -- Permissões sensíveis separadas; só fazem sentido para admin.
  permissions text[] not null default '{}'
    check (permissions <@ array['team', 'approve', 'billing', 'settings']::text[]),
  status text not null default 'active' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, role),
  check (role = 'admin' or permissions = '{}')
);
create index tenant_memberships_user_idx on public.tenant_memberships (user_id, status);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email like '%@%'),
  role text not null check (role in ('admin', 'porteiro', 'morador')),
  permissions text[] not null default '{}',
  unit_id uuid,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (role = 'morador' or unit_id is null),
  check (role <> 'morador' or unit_id is not null)
);
create index invitations_tenant_idx on public.invitations (tenant_id, created_at desc);

create table public.tenant_branding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  display_name text check (display_name is null or length(display_name) <= 80),
  logo_path text,
  color_primary text check (color_primary is null or color_primary ~ '^#[0-9A-Fa-f]{6}$'),
  color_secondary text check (color_secondary is null or color_secondary ~ '^#[0-9A-Fa-f]{6}$'),
  color_accent text check (color_accent is null or color_accent ~ '^#[0-9A-Fa-f]{6}$'),
  theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  updated_at timestamptz not null default now()
);

create table public.tenant_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  grace_days int not null default 7 check (grace_days between 0 and 30),
  qr_ttl_hours int not null default 72 check (qr_ttl_hours between 1 and 720),
  notify_whatsapp boolean not null default true,
  notify_email boolean not null default true,
  notify_push boolean not null default true,
  max_residents_per_unit int not null default 10 check (max_residents_per_unit between 1 and 50),
  onboarding jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.tenant_integrations (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null check (provider in ('whatsapp_evolution')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb, -- somente dados não secretos (ex.: nome da instância)
  updated_at timestamptz not null default now(),
  primary key (tenant_id, provider)
);

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('terms', 'privacy', 'resident_data')),
  version text not null,
  accepted_at timestamptz not null default now()
);

-- Auditoria append-only (sem tokens/senhas).
create table public.audit_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete set null,
  actor_id uuid,
  action text not null,
  target_type text,
  target_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_tenant_idx on public.audit_logs (tenant_id, created_at desc);

create or replace function app.block_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% é append-only (% bloqueado)', tg_table_name, tg_op using errcode = '42501';
end $$;
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function app.block_mutation();

create or replace function app.audit(p_tenant uuid, p_action text, p_type text, p_id text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (p_tenant, auth.uid(), p_action, p_type, p_id, coalesce(p_data, '{}'::jsonb))
$$;

-- -----------------------------------------------------------------------------
-- Helpers de autorização (usados por RLS e RPCs). Sempre a partir de auth.uid()
-- e do vínculo ativo no banco — nunca de metadados editáveis do usuário.
-- Revogação/suspensão vale na próxima query, mesmo com JWT ainda válido.
-- -----------------------------------------------------------------------------
create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

create or replace function app.has_role(p_tenant uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant and m.user_id = auth.uid()
      and m.status = 'active' and t.status = 'active' and m.role = any (p_roles))
$$;

create or replace function app.is_staff(p_tenant uuid) returns boolean
language sql stable set search_path = '' as $$ select app.has_role(p_tenant, array['admin', 'porteiro']) $$;

create or replace function app.is_admin(p_tenant uuid) returns boolean
language sql stable set search_path = '' as $$ select app.has_role(p_tenant, array['admin']) $$;

create or replace function app.is_member(p_tenant uuid) returns boolean
language sql stable set search_path = '' as $$ select app.has_role(p_tenant, array['admin', 'porteiro', 'morador']) $$;

create or replace function app.has_perm(p_tenant uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenant_memberships m
    join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant and m.user_id = auth.uid() and m.status = 'active'
      and t.status = 'active' and m.role = 'admin' and p_perm = any (m.permissions))
$$;

create or replace function app.require(p_ok boolean, p_msg text default 'Sem permissão para esta ação.')
returns void language plpgsql set search_path = '' as $$
begin
  if not coalesce(p_ok, false) then raise exception '%', p_msg using errcode = '42501'; end if;
end $$;
