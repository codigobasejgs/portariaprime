-- =============================================================================
-- PORTARIA PRIME — Onboarding do teste grátis retomável (rascunho no servidor).
-- Um rascunho por conta: etapa + dados do condomínio + request_id da ativação.
-- O request_id é o mesmo de provision_tenant (já idempotente): refresh, duplo clique,
-- timeout ou outro aparelho reaproveitam o mesmo id e nunca criam dois condomínios.
-- Estado comercial continua só em provision_tenant/subscriptions; o rascunho é só UX.
-- =============================================================================

create table public.onboarding_drafts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  step smallint not null default 1 check (step between 1 and 3),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 4096),
  request_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Sem políticas: acesso só pelas RPCs abaixo (cada uma limitada a auth.uid()).
alter table public.onboarding_drafts enable row level security;
revoke all on public.onboarding_drafts from public, anon, authenticated;
grant all on public.onboarding_drafts to service_role;

-- Condomínio criado por este rascunho (null enquanto não ativado).
create or replace function app.onboarding_tenant(p_request uuid, p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tenant_id', t.id, 'slug', t.slug, 'name', t.name, 'plan', p.name, 'cycle', s.cycle,
    'status', s.status, 'trial_started_at', s.trial_started_at, 'trial_ends_at', s.trial_ends_at)
  from public.tenants t
  join public.subscriptions s on s.tenant_id = t.id
  join public.plans p on p.id = s.plan_id
  where t.provision_request_id = p_request and t.created_by = p_uid
$$;

-- Estado para retomar: rascunho, condomínio já ativado e prévia do fim do teste (relógio do servidor).
create or replace function public.onboarding_state(p_timezone text default 'America/Sao_Paulo') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  d public.onboarding_drafts;
  v_tz text := case when app.valid_timezone(p_timezone) then p_timezone else 'America/Sao_Paulo' end;
begin
  perform app.require(v_uid is not null, 'Faça login para continuar.');
  select * into d from public.onboarding_drafts where user_id = v_uid;
  return jsonb_build_object(
    'draft', case when d.user_id is null then null else jsonb_build_object('step', d.step, 'data', d.data, 'request_id', d.request_id, 'updated_at', d.updated_at) end,
    'tenant', case when d.user_id is null then null else app.onboarding_tenant(d.request_id, v_uid) end,
    'now', app.now(),
    'trial_end_preview', app.add_months(app.now(), v_tz, 1));
end $$;

-- Salva a etapa e os campos permitidos (strings curtas). Recusa depois de ativado.
create or replace function public.onboarding_save(p_step int, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_data jsonb;
  d public.onboarding_drafts;
begin
  perform app.require(v_uid is not null, 'Faça login para continuar.');
  if p_step is null or p_step not between 1 and 3 or jsonb_typeof(p_data) is distinct from 'object' then
    raise exception 'Dados do cadastro inválidos.' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into v_data
  from jsonb_each(p_data)
  where key = any (array['name', 'slug', 'document', 'phone', 'timezone', 'plan', 'cycle'])
    and jsonb_typeof(value) = 'string' and length(value #>> '{}') <= 160;
  select * into d from public.onboarding_drafts where user_id = v_uid for update;
  if found and app.onboarding_tenant(d.request_id, v_uid) is not null then
    raise exception 'Este cadastro já foi ativado.' using errcode = 'P0001';
  end if;
  insert into public.onboarding_drafts as o (user_id, step, data) values (v_uid, p_step, v_data)
  on conflict (user_id) do update set step = excluded.step, data = excluded.data, updated_at = now()
  returning * into d;
  return jsonb_build_object('step', d.step, 'request_id', d.request_id, 'updated_at', d.updated_at);
end $$;

-- "Cadastrar outro condomínio": novo rascunho (novo request_id). O condomínio já criado não é tocado.
create or replace function public.onboarding_reset() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  delete from public.onboarding_drafts where user_id = auth.uid();
end $$;

-- Disponibilidade do endereço (o slug já é público pelo portal; não revela mais nada).
create or replace function public.slug_available(p_slug text) returns boolean
language sql stable security definer set search_path = '' as $$
  select lower(btrim(p_slug)) ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
     and not exists (select 1 from public.tenants where slug = lower(btrim(p_slug)))
$$;

revoke all on function public.onboarding_state(text), public.onboarding_save(int, jsonb), public.onboarding_reset(), public.slug_available(text) from public, anon;
revoke all on function app.onboarding_tenant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.onboarding_state(text), public.onboarding_save(int, jsonb), public.onboarding_reset(), public.slug_available(text) to authenticated;
