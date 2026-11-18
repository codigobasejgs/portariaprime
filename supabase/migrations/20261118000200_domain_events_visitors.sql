-- =============================================================================
-- Evolução modular · P0 · Eventos de domínio (outbox/inbox), Visitantes e Gateway local (simulado).
-- Aditiva. O módulo de encomendas NÃO muda: os eventos parcel.* nascem de um gatilho AFTER em packages, na mesma
-- transação das RPCs atuais (receive_and_store, deliver_package, resolve_package...), sem reimplementar nada.
--
-- 1) domain_events (outbox) + event_consumers + event_deliveries (inbox idempotente por consumidor, retries,
--    dead-letter) + event_pull/event_ack (service_role). Payload mínimo: ids e status, sem PII, foto ou URL.
-- 2) Visitantes (módulo 'visitors'): convite do morador com QR de uso único e validade, check-in/out na portaria.
-- 3) Gateway local: provisionamento por código, credencial por gateway (hash), heartbeat, comandos assinados com
--    TTL/nonce/sequência e estados separados sent → acknowledged → physically_confirmed | unknown | expired.
--    Nesta fase só existe o driver 'simulator' e nenhum comando físico é emitido pela nuvem.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Outbox / inbox
-- -----------------------------------------------------------------------------
create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_type text not null check (event_type ~ '^[a-z_]+\.[a-z_]+\.v[0-9]+$'),
  schema_version int not null default 1,
  aggregate_type text not null check (aggregate_type in ('parcel', 'visitor_pass', 'access_command', 'gateway')),
  aggregate_id uuid not null,
  correlation_id uuid not null default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and length(payload::text) <= 2000),
  occurred_at timestamptz not null default now(),
  dedupe_key text not null,
  unique (tenant_id, dedupe_key)
);
create index domain_events_tenant_idx on public.domain_events (tenant_id, occurred_at desc);
create index domain_events_retention_idx on public.domain_events (occurred_at);
create trigger domain_events_append_only before update on public.domain_events for each row execute function app.block_mutation();

-- Consumidores autorizados: cada um lê só os tipos de evento que assinou. Credencial = hash (service_role valida).
create table public.event_consumers (
  key text primary key check (key ~ '^[a-z0-9_.-]{3,60}$'),
  description text not null,
  event_types text[] not null check (cardinality(event_types) between 1 and 50),
  tenant_id uuid references public.tenants(id) on delete cascade,     -- null = consumidor da plataforma
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.event_deliveries (
  consumer_key text not null references public.event_consumers(key) on delete cascade,
  event_id uuid not null references public.domain_events(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'leased', 'done', 'dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text check (last_error is null or length(last_error) <= 500),
  done_at timestamptz,
  primary key (consumer_key, event_id)
);
create index event_deliveries_due_idx on public.event_deliveries (consumer_key, status, next_attempt_at);

alter table public.domain_events enable row level security;
alter table public.event_consumers enable row level security;
alter table public.event_deliveries enable row level security;
revoke all on public.domain_events, public.event_consumers, public.event_deliveries from public, anon, authenticated;
grant all on public.domain_events, public.event_consumers, public.event_deliveries to service_role;

-- Publica um evento (idempotente por dedupe_key) e cria a entrega para cada consumidor ativo assinante.
create function app.emit_event(p_tenant uuid, p_type text, p_aggregate_type text, p_aggregate uuid, p_payload jsonb,
  p_dedupe text, p_correlation uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.domain_events (tenant_id, event_type, aggregate_type, aggregate_id, payload, dedupe_key, correlation_id)
  values (p_tenant, p_type, p_aggregate_type, p_aggregate, coalesce(p_payload, '{}'::jsonb), p_dedupe, coalesce(p_correlation, gen_random_uuid()))
  on conflict (tenant_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then return null; end if;
  insert into public.event_deliveries (consumer_key, event_id)
  select c.key, v_id from public.event_consumers c
   where c.active and p_type = any (c.event_types) and (c.tenant_id is null or c.tenant_id = p_tenant);
  return v_id;
end $$;

-- Encomendas → eventos, sem tocar nas RPCs. Payload só com ids e status (nada de nome, telefone, foto ou caminho).
create function app.parcel_events() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_type text; v_payload jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status not in ('RECEBIDA', 'ARMAZENADA') then return new; end if;
    v_type := 'parcel.received.v1';
  elsif new.status is distinct from old.status then
    v_type := case when new.status = 'RETIRADA' then 'parcel.picked_up.v1'
                   when new.status in ('CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA') then 'parcel.exception.v1'
                   when new.status in ('RECEBIDA', 'ARMAZENADA') and old.status = 'PRE_REGISTRADA' then 'parcel.received.v1' end;
    if v_type is null then return new; end if;
  else return new;
  end if;
  v_payload := jsonb_build_object('parcel_id', new.id, 'unit_id', new.unit_id, 'status', lower(new.status),
    'registered_via', new.registered_via, 'pickup_method', case when v_type = 'parcel.picked_up.v1' then new.pickup_method end);
  perform app.emit_event(new.tenant_id, v_type, 'parcel', new.id, jsonb_strip_nulls(v_payload), v_type || ':' || new.id::text);
  return new;
end $$;
create trigger packages_domain_events after insert or update of status on public.packages
  for each row execute function app.parcel_events();

-- Consumo (service_role): reserva até p_limit entregas vencidas, com lease; retries 1, 4, 16, 64 min; dead-letter após 6.
create function public.event_pull(p_consumer text, p_limit int default 50) returns table
  (event_id uuid, seq bigint, tenant_id uuid, event_type text, schema_version int, aggregate_id uuid, correlation_id uuid, occurred_at timestamptz, payload jsonb, attempts int)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.event_consumers where key = p_consumer and active) then
    raise exception 'Consumidor desconhecido ou inativo.' using errcode = '42501';
  end if;
  return query
  with due as (
    select d.event_id from public.event_deliveries d
     where d.consumer_key = p_consumer
       and ((d.status = 'pending' and d.next_attempt_at <= now()) or (d.status = 'leased' and d.lease_until < now()))
     order by d.next_attempt_at limit least(greatest(coalesce(p_limit, 50), 1), 500) for update skip locked),
  upd as (
    update public.event_deliveries d set status = 'leased', attempts = d.attempts + 1, lease_until = now() + interval '2 minutes'
      from due where d.consumer_key = p_consumer and d.event_id = due.event_id returning d.event_id, d.attempts)
  select e.id, e.seq, e.tenant_id, e.event_type, e.schema_version, e.aggregate_id, e.correlation_id, e.occurred_at, e.payload, upd.attempts
    from upd join public.domain_events e on e.id = upd.event_id order by e.seq;
end $$;

create function public.event_ack(p_consumer text, p_event uuid, p_ok boolean, p_error text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare d public.event_deliveries;
begin
  select * into d from public.event_deliveries where consumer_key = p_consumer and event_id = p_event for update;
  if not found then raise exception 'Entrega não encontrada.' using errcode = 'P0002'; end if;
  if d.status = 'done' then return 'done'; end if;          -- ack repetido: idempotente
  if p_ok then
    update public.event_deliveries set status = 'done', done_at = now(), lease_until = null, last_error = null
     where consumer_key = p_consumer and event_id = p_event;
    return 'done';
  end if;
  update public.event_deliveries set
    status = case when d.attempts >= 6 then 'dead' else 'pending' end, lease_until = null, last_error = left(p_error, 500),
    next_attempt_at = now() + make_interval(mins => power(4, least(d.attempts, 4) - 1)::int)
   where consumer_key = p_consumer and event_id = p_event;
  return case when d.attempts >= 6 then 'dead' else 'retry' end;
end $$;

-- Reprocessar dead-letter (plataforma, com auditoria).
create function public.event_redeliver(p_consumer text, p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.platform_require('notification_retry');
  update public.event_deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
   where consumer_key = p_consumer and event_id = p_event and status = 'dead';
  if not found then raise exception 'Somente entrega em dead-letter pode ser reprocessada.' using errcode = 'P0001'; end if;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id)
  select e.tenant_id, auth.uid(), 'event.redeliver', 'domain_event', e.id::text from public.domain_events e where e.id = p_event;
end $$;

-- Retenção: eventos entregues a todos (ou sem consumidor) saem após 90 dias.
create function public.event_retention(p_limit int default 5000) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.domain_events e where e.id in (
    select x.id from public.domain_events x where x.occurred_at < now() - interval '90 days'
       and not exists (select 1 from public.event_deliveries d where d.event_id = x.id and d.status in ('pending', 'leased'))
     limit least(greatest(coalesce(p_limit, 5000), 1), 50000));
  get diagnostics n = row_count;
  return n;
end $$;
-- Retenção apaga (dentro da regra acima); o append-only vale só para UPDATE.

-- -----------------------------------------------------------------------------
-- 2) Visitantes
-- -----------------------------------------------------------------------------
create table public.visitor_passes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null,
  visitor_name text not null check (length(btrim(visitor_name)) between 2 and 120),
  kind text not null default 'visita' check (kind in ('visita', 'prestador', 'entrega', 'outro')),
  document_last4 text check (document_last4 is null or document_last4 ~ '^[0-9A-Za-z]{4}$'),   -- minimização: só 4 dígitos
  notes text check (notes is null or length(notes) <= 300),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  max_uses int not null default 1 check (max_uses between 1 and 20),
  uses int not null default 0 check (uses >= 0),
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked', 'used', 'expired')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id) on delete cascade,
  unique (tenant_id, id),
  check (valid_until > valid_from and valid_until <= valid_from + interval '30 days')
);
create index visitor_passes_tenant_idx on public.visitor_passes (tenant_id, valid_from desc);
create index visitor_passes_unit_idx on public.visitor_passes (tenant_id, unit_id, valid_from desc);

create table public.visitor_visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pass_id uuid,
  unit_id uuid not null,
  visitor_name text not null check (length(btrim(visitor_name)) between 2 and 120),
  kind text not null check (kind in ('visita', 'prestador', 'entrega', 'outro')),
  method text not null check (method in ('qr', 'manual')),
  authorized_by_name text check (authorized_by_name is null or length(authorized_by_name) <= 120),
  reason text check (reason is null or length(reason) <= 300),
  checked_in_at timestamptz not null default now(),
  checked_in_by uuid references auth.users(id) on delete set null,
  checked_out_at timestamptz,
  checked_out_by uuid references auth.users(id) on delete set null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id) on delete cascade,
  foreign key (pass_id) references public.visitor_passes (id) on delete set null,   -- convite do mesmo condomínio (conferido na RPC)
  unique (tenant_id, idempotency_key)
);
create index visitor_visits_tenant_idx on public.visitor_visits (tenant_id, checked_in_at desc);
create index visitor_visits_open_idx on public.visitor_visits (tenant_id) where checked_out_at is null;

alter table public.visitor_passes enable row level security;
alter table public.visitor_visits enable row level security;
revoke all on public.visitor_passes, public.visitor_visits from public, anon, authenticated;
grant select on public.visitor_passes, public.visitor_visits to authenticated;
grant all on public.visitor_passes, public.visitor_visits to service_role;
-- Leitura: equipe do condomínio, ou morador da própria unidade; sempre com módulo ligado. token_hash não é exposto
-- (as telas usam as RPCs abaixo; a coluna existe só para o servidor conferir o QR).
revoke select on public.visitor_passes from authenticated;
grant select (id, tenant_id, unit_id, visitor_name, kind, notes, valid_from, valid_until, max_uses, uses, status, created_at, revoked_at)
  on public.visitor_passes to authenticated;
create policy visitor_passes_select on public.visitor_passes for select to authenticated
  using (app.module_enabled(tenant_id, 'visitors') and (app.is_staff(tenant_id) or app.is_unit_member(tenant_id, unit_id)));
create policy visitor_visits_select on public.visitor_visits for select to authenticated
  using (app.module_enabled(tenant_id, 'visitors') and (app.is_staff(tenant_id) or app.is_unit_member(tenant_id, unit_id)));

create function app.visitor_pass_status(p public.visitor_passes) returns text
language sql stable set search_path = '' as $$
  select case when p.status in ('revoked', 'used') then p.status
              when p.valid_until <= app.now() then 'expired'
              when p.uses >= p.max_uses then 'used' else 'active' end
$$;

-- Morador (da unidade) ou equipe cria convite. Devolve o token UMA vez (QR "PV1.<token>"); só o hash fica no banco.
create function public.visitor_pass_create(p_tenant uuid, p_unit uuid, p_name text, p_kind text default 'visita',
  p_valid_from timestamptz default null, p_valid_until timestamptz default null, p_max_uses int default 1,
  p_document_last4 text default null, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tok text := app.random_token(); v public.visitor_passes; v_from timestamptz := coalesce(p_valid_from, app.now());
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.is_unit_member(p_tenant, p_unit) or app.is_staff(p_tenant), 'Sem permissão para convidar para esta unidade.');
  perform app.require(app.can_operate(p_tenant), 'Condomínio com acesso restrito: novos convites indisponíveis.');
  if not exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active) then
    raise exception 'Unidade não encontrada.' using errcode = 'P0002';
  end if;
  if (select count(*) from public.visitor_passes where tenant_id = p_tenant and unit_id = p_unit and status = 'active' and valid_until > app.now()) >= 50 then
    raise exception 'Limite de 50 convites ativos por unidade.' using errcode = 'P0001';
  end if;
  insert into public.visitor_passes (tenant_id, unit_id, visitor_name, kind, document_last4, notes, valid_from, valid_until, max_uses, token_hash, created_by)
  values (p_tenant, p_unit, regexp_replace(btrim(p_name), '\s+', ' ', 'g'), coalesce(p_kind, 'visita'), nullif(btrim(p_document_last4), ''),
          nullif(btrim(p_notes), ''), v_from, coalesce(p_valid_until, v_from + interval '1 day'), coalesce(p_max_uses, 1),
          app.sha256_hex(v_tok), auth.uid())
  returning * into v;
  perform app.emit_event(p_tenant, 'visitor.invited.v1', 'visitor_pass', v.id,
    jsonb_build_object('pass_id', v.id, 'unit_id', v.unit_id, 'kind', v.kind, 'valid_until', v.valid_until), 'visitor.invited.v1:' || v.id);
  perform app.audit(p_tenant, 'visitor.pass_created', 'visitor_pass', v.id::text, jsonb_build_object('kind', v.kind, 'max_uses', v.max_uses));
  return jsonb_build_object('id', v.id, 'qr', 'PV1.' || v_tok, 'valid_from', v.valid_from, 'valid_until', v.valid_until);
end $$;

create function public.visitor_pass_revoke(p_tenant uuid, p_pass uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.visitor_passes;
begin
  perform app.require_module(p_tenant, 'visitors');
  select * into v from public.visitor_passes where tenant_id = p_tenant and id = p_pass for update;
  if not found then raise exception 'Convite não encontrado.' using errcode = 'P0002'; end if;
  perform app.require(app.is_unit_member(p_tenant, v.unit_id) or app.is_staff(p_tenant));
  if v.status = 'revoked' then return; end if;
  update public.visitor_passes set status = 'revoked', revoked_at = now() where id = p_pass;
  perform app.audit(p_tenant, 'visitor.pass_revoked', 'visitor_pass', p_pass::text);
end $$;

-- Listas para as telas (sem token).
create function public.visitor_list(p_tenant uuid, p_unit uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_staff boolean := app.is_staff(p_tenant);
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(v_staff or (p_unit is not null and app.is_unit_member(p_tenant, p_unit)) or (p_unit is null and app.has_role(p_tenant, array['morador'])));
  return jsonb_build_object(
    'passes', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'unit_id', p.unit_id, 'unit', app.unit_display(p_tenant, u.block, u.label),
        'visitor_name', p.visitor_name, 'kind', p.kind, 'notes', p.notes, 'valid_from', p.valid_from, 'valid_until', p.valid_until,
        'uses', p.uses, 'max_uses', p.max_uses, 'status', app.visitor_pass_status(p)) order by p.valid_from desc), '[]'::jsonb)
      from (select * from public.visitor_passes x where x.tenant_id = p_tenant and (p_unit is null or x.unit_id = p_unit)
              and (v_staff or app.is_unit_member(p_tenant, x.unit_id))
              and (x.valid_until > app.now() - interval '7 days') order by x.valid_from desc limit 200) p
      join public.units u on u.id = p.unit_id),
    'visits', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'unit_id', v.unit_id, 'unit', app.unit_display(p_tenant, u.block, u.label),
        'visitor_name', v.visitor_name, 'kind', v.kind, 'method', v.method, 'checked_in_at', v.checked_in_at, 'checked_out_at', v.checked_out_at,
        'authorized_by_name', v.authorized_by_name) order by v.checked_in_at desc), '[]'::jsonb)
      from (select * from public.visitor_visits x where x.tenant_id = p_tenant and (p_unit is null or x.unit_id = p_unit)
              and (v_staff or app.is_unit_member(p_tenant, x.unit_id))
              and (x.checked_out_at is null or x.checked_in_at > app.now() - interval '30 days') order by x.checked_in_at desc limit 200) v
      join public.units u on u.id = v.unit_id));
end $$;

-- Portaria confere o QR (sem registrar entrada).
create function public.visitor_pass_lookup(p_tenant uuid, p_qr text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v public.visitor_passes; u public.units;
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.is_staff(p_tenant));
  select * into v from public.visitor_passes where token_hash = app.sha256_hex(regexp_replace(btrim(coalesce(p_qr, '')), '^PV1\.', ''));
  if not found or v.tenant_id <> p_tenant then raise exception 'Convite não reconhecido neste condomínio.' using errcode = 'P0002'; end if;
  select * into u from public.units where id = v.unit_id;
  return jsonb_build_object('id', v.id, 'visitor_name', v.visitor_name, 'kind', v.kind, 'unit_id', v.unit_id,
    'unit', app.unit_display(p_tenant, u.block, u.label), 'valid_from', v.valid_from, 'valid_until', v.valid_until,
    'uses', v.uses, 'max_uses', v.max_uses, 'status', case when v.valid_from > app.now() then 'not_yet' else app.visitor_pass_status(v) end,
    'document_last4', v.document_last4, 'notes', v.notes);
end $$;

-- Check-in: com QR (uso único/validade conferidos com bloqueio) ou manual (motivo + quem autorizou). Idempotente.
-- Registrar a entrada NÃO abre portão: comando físico é outro fluxo (gateway, P2).
create function public.visitor_check_in(p_tenant uuid, p_idempotency_key text, p_qr text default null, p_unit uuid default null,
  p_name text default null, p_kind text default 'visita', p_authorized_by text default null, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.visitor_passes; r public.visitor_visits; v_method text := case when nullif(btrim(p_qr), '') is null then 'manual' else 'qr' end;
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.is_staff(p_tenant));
  select * into r from public.visitor_visits where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('id', r.id, 'replayed', true, 'unit_id', r.unit_id); end if;
  if v_method = 'qr' then
    select * into v from public.visitor_passes where token_hash = app.sha256_hex(regexp_replace(btrim(p_qr), '^PV1\.', '')) for update;
    if not found or v.tenant_id <> p_tenant then raise exception 'Convite não reconhecido neste condomínio.' using errcode = 'P0002'; end if;
    if v.status = 'revoked' then raise exception 'Convite revogado pelo morador.' using errcode = 'P0001'; end if;
    if v.valid_from > app.now() then raise exception 'Convite ainda não começou a valer.' using errcode = 'P0001'; end if;
    if v.valid_until <= app.now() then raise exception 'Convite expirado.' using errcode = 'P0001'; end if;
    if v.uses >= v.max_uses or v.status = 'used' then raise exception 'Convite já utilizado.' using errcode = 'P0001'; end if;
    -- Unidade desativada ou quem convidou deixou a unidade (e não é da equipe): o convite deixa de valer.
    if not exists (select 1 from public.units where tenant_id = p_tenant and id = v.unit_id and active)
       or not (exists (select 1 from public.unit_memberships um where um.tenant_id = p_tenant and um.unit_id = v.unit_id
                        and um.user_id = v.created_by and um.status = 'active')
               or exists (select 1 from public.tenant_memberships m where m.tenant_id = p_tenant and m.user_id = v.created_by
                        and m.status = 'active' and m.role in ('admin', 'porteiro'))) then
      raise exception 'Convite sem validade: quem convidou não tem mais vínculo com a unidade.' using errcode = 'P0001';
    end if;
    update public.visitor_passes set uses = uses + 1, status = case when uses + 1 >= max_uses then 'used' else status end where id = v.id;
    insert into public.visitor_visits (tenant_id, pass_id, unit_id, visitor_name, kind, method, idempotency_key, checked_in_by)
    values (p_tenant, v.id, v.unit_id, v.visitor_name, v.kind, 'qr', p_idempotency_key, auth.uid()) returning * into r;
  else
    if p_unit is null or not exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active) then
      raise exception 'Selecione a unidade.' using errcode = '22023';
    end if;
    if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o nome do visitante.' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_authorized_by, ''))) < 2 then raise exception 'Informe quem autorizou a entrada.' using errcode = '22023'; end if;
    insert into public.visitor_visits (tenant_id, unit_id, visitor_name, kind, method, authorized_by_name, reason, idempotency_key, checked_in_by)
    values (p_tenant, p_unit, regexp_replace(btrim(p_name), '\s+', ' ', 'g'), coalesce(p_kind, 'visita'), 'manual', btrim(p_authorized_by),
            nullif(btrim(p_reason), ''), p_idempotency_key, auth.uid()) returning * into r;
  end if;
  perform app.emit_event(p_tenant, 'visitor.arrived.v1', 'visitor_pass', coalesce(r.pass_id, r.id),
    jsonb_build_object('visit_id', r.id, 'pass_id', r.pass_id, 'unit_id', r.unit_id, 'method', r.method), 'visitor.arrived.v1:' || r.id);
  perform app.emit_event(p_tenant, 'visitor.authorized.v1', 'visitor_pass', coalesce(r.pass_id, r.id),
    jsonb_build_object('visit_id', r.id, 'unit_id', r.unit_id, 'by', r.method), 'visitor.authorized.v1:' || r.id);
  perform app.audit(p_tenant, 'visitor.checked_in', 'visitor_visit', r.id::text, jsonb_build_object('method', r.method));
  -- Aviso ao morador da unidade pela caixa interna existente (sem novo canal).
  insert into public.notifications (tenant_id, user_id, kind, title, body)
  select p_tenant, um.user_id, 'visitor_arrived', 'Visitante na portaria', r.visitor_name || ' entrou às ' ||
         to_char(r.checked_in_at at time zone coalesce((select timezone from public.tenants where id = p_tenant), 'America/Sao_Paulo'), 'HH24:MI') || '.'
    from public.unit_memberships um where um.tenant_id = p_tenant and um.unit_id = r.unit_id and um.status = 'active';
  return jsonb_build_object('id', r.id, 'replayed', false, 'unit_id', r.unit_id, 'visitor_name', r.visitor_name, 'method', r.method);
end $$;

-- Saída: só equipe, SEM exigir o módulo — quem já entrou sempre pode ter a saída registrada.
create function public.visitor_check_out(p_tenant uuid, p_visit uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.visitor_visits;
begin
  perform app.require(app.is_staff(p_tenant));
  update public.visitor_visits set checked_out_at = coalesce(checked_out_at, now()), checked_out_by = coalesce(checked_out_by, auth.uid())
   where tenant_id = p_tenant and id = p_visit returning * into r;
  if not found then raise exception 'Visita não encontrada.' using errcode = 'P0002'; end if;
  perform app.audit(p_tenant, 'visitor.checked_out', 'visitor_visit', r.id::text);
  return jsonb_build_object('id', r.id, 'checked_out_at', r.checked_out_at);
end $$;

-- -----------------------------------------------------------------------------
-- 3) Gateway local (somente simulador em P0)
-- -----------------------------------------------------------------------------
create table public.gateways (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 60),
  kind text not null default 'simulator' check (kind in ('simulator', 'linux', 'windows')),   -- P0: só 'simulator' é criado
  secret_hash text unique,                                      -- credencial do gateway (hash); null até parear
  pair_code_hash text unique,
  pair_expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'online', 'offline', 'revoked')),
  last_seen_at timestamptz,
  clock_drift_ms int,
  agent_version text check (agent_version is null or length(agent_version) <= 40),
  last_seq bigint not null default 0,                           -- maior sequência respondida (telemetria; anti-replay é o status do comando)
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, id)
);

create table public.gateway_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  gateway_id uuid not null,
  name text not null check (length(btrim(name)) between 2 and 60),
  device_type text not null check (device_type in ('camera', 'nvr', 'access_point', 'intercom', 'sensor')),
  vendor text, model text, firmware text,
  driver text not null default 'simulator' check (driver in ('simulator', 'onvif', 'rtsp', 'intelbras', 'hikvision', 'dahua', 'axis', 'uniview', 'linear_hcs', 'sip')),
  capabilities text[] not null default '{}',
  homologation_status text not null default 'simulated'
    check (homologation_status in ('simulated', 'candidate', 'tested_lab', 'tested_field', 'partial', 'unsupported')),
  has_physical_sensor boolean not null default false,
  state text not null default 'unknown' check (state in ('online', 'offline', 'unknown', 'error')),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, gateway_id) references public.gateways (tenant_id, id) on delete cascade,
  unique (tenant_id, id),
  -- tested_field exige evidência registrada (modelo + firmware); nada de compatibilidade declarada sem teste.
  check (homologation_status <> 'tested_field' or (model is not null and firmware is not null))
);

create table public.access_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  gateway_id uuid not null,
  device_id uuid not null,
  action text not null check (action in ('pulse_open', 'read_state')),
  seq bigint not null,
  nonce text not null unique check (nonce ~ '^[0-9a-f]{32}$'),
  status text not null default 'requested'
    check (status in ('requested', 'sent', 'acknowledged', 'physically_confirmed', 'failed', 'unknown', 'expired', 'rejected')),
  reason text not null check (length(btrim(reason)) between 3 and 200),
  expires_at timestamptz not null,
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  confirmed_at timestamptz,
  result_detail text check (result_detail is null or length(result_detail) <= 200),
  simulated boolean not null,
  foreign key (tenant_id, gateway_id) references public.gateways (tenant_id, id) on delete cascade,
  foreign key (tenant_id, device_id) references public.gateway_devices (tenant_id, id) on delete cascade,
  unique (gateway_id, seq)
);
create index access_commands_gateway_idx on public.access_commands (gateway_id, status, requested_at);

alter table public.gateways enable row level security;
alter table public.gateway_devices enable row level security;
alter table public.access_commands enable row level security;
revoke all on public.gateways, public.gateway_devices, public.access_commands from public, anon, authenticated;
grant all on public.gateways, public.gateway_devices, public.access_commands to service_role;
-- Equipe vê inventário e estado (sem hash/código) quando o módulo 'concierge' está ligado.
grant select (id, tenant_id, name, kind, status, last_seen_at, clock_drift_ms, agent_version, created_at, revoked_at) on public.gateways to authenticated;
grant select on public.gateway_devices to authenticated;
grant select (id, tenant_id, gateway_id, device_id, action, status, reason, expires_at, requested_at, acknowledged_at, confirmed_at, result_detail, simulated)
  on public.access_commands to authenticated;
create policy gateways_select on public.gateways for select to authenticated using (app.is_staff(tenant_id) and app.module_enabled(tenant_id, 'concierge'));
create policy gateway_devices_select on public.gateway_devices for select to authenticated using (app.is_staff(tenant_id) and app.module_enabled(tenant_id, 'concierge'));
create policy access_commands_select on public.access_commands for select to authenticated using (app.is_staff(tenant_id) and app.module_enabled(tenant_id, 'concierge'));

-- Síndico (settings + senha recente) cria um gateway e recebe o código de pareamento (uma vez, 15 min).
create function public.gateway_create(p_tenant uuid, p_name text, p_kind text default 'simulator') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(substr(app.random_token(), 1, 10)); g public.gateways;
begin
  perform app.require_module(p_tenant, 'concierge');
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Requer permissão de configurações.');
  perform app.mdm_require_recent_auth();
  if coalesce(p_kind, 'simulator') <> 'simulator' then
    raise exception 'Gateway físico indisponível nesta fase (pending_hardware). Use o simulador.' using errcode = 'P0001';
  end if;
  -- Pendente com código vencido não ocupa vaga.
  if (select count(*) from public.gateways where tenant_id = p_tenant and (status in ('online', 'offline')
        or (status = 'pending' and pair_expires_at > app.now()))) >= 5 then
    raise exception 'Limite de 5 gateways por condomínio.' using errcode = 'P0001';
  end if;
  insert into public.gateways (tenant_id, name, kind, pair_code_hash, pair_expires_at, created_by)
  values (p_tenant, btrim(p_name), coalesce(p_kind, 'simulator'), app.sha256_hex(v_code), app.now() + interval '15 minutes', auth.uid())
  returning * into g;
  perform app.audit(p_tenant, 'gateway.created', 'gateway', g.id::text, jsonb_build_object('kind', g.kind));
  return jsonb_build_object('id', g.id, 'pair_code', v_code, 'expires_at', g.pair_expires_at);
end $$;

create function public.gateway_revoke(p_tenant uuid, p_gateway uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Requer permissão de configurações.');
  perform app.mdm_require_recent_auth();
  update public.gateways set status = 'revoked', revoked_at = now(), secret_hash = null, pair_code_hash = null
   where tenant_id = p_tenant and id = p_gateway and status <> 'revoked';
  if not found then raise exception 'Gateway não encontrado ou já revogado.' using errcode = 'P0002'; end if;
  update public.access_commands set status = 'expired', result_detail = 'gateway revogado'
   where gateway_id = p_gateway and status in ('requested', 'sent');
  perform app.audit(p_tenant, 'gateway.revoked', 'gateway', p_gateway::text);
  perform app.emit_event(p_tenant, 'gateway.status_changed.v1', 'gateway', p_gateway, jsonb_build_object('gateway_id', p_gateway, 'status', 'revoked'),
    'gateway.status_changed.v1:' || p_gateway || ':revoked');
end $$;

-- Chamadas do próprio gateway (via API, service_role, com o segredo dele já validado por hash).
create function public.gateway_pair(p_code text, p_secret_hash text, p_agent_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.gateways;
begin
  if coalesce(p_secret_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'Credencial inválida.' using errcode = '22023'; end if;
  select * into g from public.gateways where pair_code_hash = app.sha256_hex(upper(btrim(coalesce(p_code, '')))) for update;
  if not found or g.status = 'revoked' or g.pair_expires_at <= app.now() then
    raise exception 'Código de pareamento inválido ou vencido.' using errcode = '42501';
  end if;
  update public.gateways set secret_hash = p_secret_hash, pair_code_hash = null, pair_expires_at = null, status = 'online',
         last_seen_at = now(), agent_version = left(p_agent_version, 40) where id = g.id;
  perform app.emit_event(g.tenant_id, 'gateway.status_changed.v1', 'gateway', g.id, jsonb_build_object('gateway_id', g.id, 'status', 'online'),
    'gateway.status_changed.v1:' || g.id || ':paired');
  return jsonb_build_object('gateway_id', g.id, 'tenant_id', g.tenant_id);
end $$;

-- Heartbeat: estado, drift e inventário (somente dispositivos simulados são aceitos em P0). Devolve comandos pendentes.
create function public.gateway_heartbeat(p_secret_hash text, p_clock timestamptz, p_devices jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.gateways; d jsonb; v_prev text; v_cmds jsonb;
begin
  select * into g from public.gateways where secret_hash = p_secret_hash and status <> 'revoked' for update;
  if not found then raise exception 'Gateway não autorizado.' using errcode = '42501'; end if;
  v_prev := g.status;
  update public.gateways set status = 'online', last_seen_at = now(),
         clock_drift_ms = least(greatest((extract(epoch from (p_clock - now())) * 1000)::bigint, -2147483647), 2147483647)::int where id = g.id;
  if v_prev <> 'online' then
    perform app.emit_event(g.tenant_id, 'gateway.status_changed.v1', 'gateway', g.id, jsonb_build_object('gateway_id', g.id, 'status', 'online'),
      'gateway.status_changed.v1:' || g.id || ':online:' || floor(extract(epoch from now()) / 60)::text);
  end if;
  for d in select * from jsonb_array_elements(case when jsonb_typeof(p_devices) = 'array' then p_devices else '[]'::jsonb end) limit 50 loop
    -- P0: só simulador; item malformado é ignorado (não derruba o heartbeat).
    continue when d->>'driver' is distinct from 'simulator' or coalesce(d->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(d->>'device_type', '') not in ('camera', 'nvr', 'access_point', 'intercom', 'sensor')
      or coalesce(d->>'state', 'unknown') not in ('online', 'offline', 'unknown', 'error')
      or coalesce(d->>'has_physical_sensor', 'false') not in ('true', 'false')
      or (d ? 'capabilities' and jsonb_typeof(d->'capabilities') <> 'array');
    insert into public.gateway_devices as x (id, tenant_id, gateway_id, name, device_type, driver, capabilities, has_physical_sensor, state, vendor, model, homologation_status)
    values ((d->>'id')::uuid, g.tenant_id, g.id, left(coalesce(d->>'name', 'Dispositivo'), 60), d->>'device_type', 'simulator',
            coalesce(array(select jsonb_array_elements_text(d->'capabilities')), '{}'), coalesce((d->>'has_physical_sensor')::boolean, false),
            coalesce(d->>'state', 'unknown'), 'Portaria Prime', 'Simulador', 'simulated')
    on conflict (id) do update set state = excluded.state, capabilities = excluded.capabilities, has_physical_sensor = excluded.has_physical_sensor,
      updated_at = now() where x.tenant_id = g.tenant_id and x.gateway_id = g.id;
  end loop;
  -- Comandos vencidos não são entregues; cada comando é entregue UMA vez (requested -> sent), nunca reenviado.
  update public.access_commands set status = 'expired' where gateway_id = g.id and status in ('requested', 'sent') and expires_at <= now();
  with sent as (update public.access_commands x set status = 'sent' where x.gateway_id = g.id and x.status = 'requested' returning x.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'device_id', c.device_id, 'action', c.action, 'seq', c.seq, 'nonce', c.nonce,
      'expires_at', c.expires_at, 'simulated', c.simulated) order by c.seq), '[]'::jsonb) into v_cmds from sent c;
  return jsonb_build_object('gateway_id', g.id, 'commands', v_cmds);
end $$;

-- Marca gateways sem contato há 2 min como offline (chamado pelo worker).
create function public.gateway_sweep() returns int
language plpgsql security definer set search_path = '' as $$
declare g record; n int := 0;
begin
  for g in update public.gateways set status = 'offline' where status = 'online' and last_seen_at < now() - interval '2 minutes' returning id, tenant_id loop
    perform app.emit_event(g.tenant_id, 'gateway.status_changed.v1', 'gateway', g.id, jsonb_build_object('gateway_id', g.id, 'status', 'offline'),
      'gateway.status_changed.v1:' || g.id || ':offline:' || floor(extract(epoch from now()) / 60)::text);
    n := n + 1;
  end loop;
  -- Comando de gateway offline também vence (não fica pendente para sempre).
  update public.access_commands set status = 'expired', result_detail = coalesce(result_detail, 'sem resposta do gateway')
   where status in ('requested', 'sent') and expires_at <= now();
  return n;
end $$;

-- Pedido de comando (equipe + concierge ligado + senha recente). Em P0 só para dispositivo SIMULADO: a nuvem não
-- emite comando físico. Recebimento de encomenda nunca chama isto.
create function public.access_command_request(p_tenant uuid, p_device uuid, p_action text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.gateway_devices; g public.gateways; c public.access_commands;
begin
  perform app.require_module(p_tenant, 'concierge');
  perform app.require(app.is_staff(p_tenant));
  perform app.mdm_require_recent_auth();
  select * into d from public.gateway_devices where tenant_id = p_tenant and id = p_device;
  if not found then raise exception 'Dispositivo não encontrado.' using errcode = 'P0002'; end if;
  if d.homologation_status <> 'simulated' then
    raise exception 'Comando físico indisponível: dispositivo não homologado nesta fase (pending_hardware).' using errcode = 'P0001';
  end if;
  if p_action not in ('pulse_open', 'read_state') or not (p_action = any (d.capabilities)) then
    raise exception 'Ação não suportada por este dispositivo.' using errcode = '22023';
  end if;
  select * into g from public.gateways where tenant_id = p_tenant and id = d.gateway_id for update;
  if g.status = 'revoked' then raise exception 'Gateway revogado.' using errcode = 'P0001'; end if;
  if g.kind <> 'simulator' then raise exception 'Comando físico indisponível nesta fase (pending_hardware).' using errcode = 'P0001'; end if;
  insert into public.access_commands (tenant_id, gateway_id, device_id, action, seq, nonce, reason, expires_at, requested_by, simulated)
  values (p_tenant, g.id, d.id, p_action, coalesce((select max(seq) from public.access_commands where gateway_id = g.id), g.last_seq) + 1,
          substr(app.random_token(), 1, 32), btrim(p_reason), app.now() + interval '30 seconds', auth.uid(), true)
  returning * into c;
  perform app.emit_event(p_tenant, 'access.command_requested.v1', 'access_command', c.id,
    jsonb_build_object('command_id', c.id, 'device_id', d.id, 'action', c.action, 'simulated', true), 'access.command_requested.v1:' || c.id);
  perform app.audit(p_tenant, 'access.command_requested', 'access_command', c.id::text, jsonb_build_object('action', c.action, 'simulated', true));
  return jsonb_build_object('id', c.id, 'seq', c.seq, 'status', c.status, 'expires_at', c.expires_at, 'simulated', true);
end $$;

-- Resposta do gateway: confere segredo, eco do nonce + seq do comando entregue, estado (um resultado só) e validade.
-- Não é assinatura criptográfica: HMAC por gateway, verificado pelo agente, é requisito de P2 antes de hardware real.
-- physically_confirmed só quando o dispositivo declara sensor físico.
create function public.gateway_command_result(p_secret_hash text, p_command uuid, p_seq bigint, p_nonce text, p_result text, p_detail text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare g public.gateways; c public.access_commands; d public.gateway_devices; v_status text;
begin
  select * into g from public.gateways where secret_hash = p_secret_hash and status <> 'revoked' for update;
  if not found then raise exception 'Gateway não autorizado.' using errcode = '42501'; end if;
  select * into c from public.access_commands where id = p_command and gateway_id = g.id for update;
  if not found then raise exception 'Comando desconhecido para este gateway.' using errcode = '42501'; end if;
  -- Recusas devolvem o motivo (sem exceção) para a trilha de auditoria ficar gravada.
  if c.nonce <> coalesce(p_nonce, '') or c.seq <> p_seq then
    perform app.audit(g.tenant_id, 'access.command_rejected', 'access_command', c.id::text, jsonb_build_object('why', 'signature'));
    return 'rejected_signature';
  end if;
  if c.status not in ('requested', 'sent') then
    perform app.audit(g.tenant_id, 'access.command_rejected', 'access_command', c.id::text, jsonb_build_object('why', 'replay'));
    return 'rejected_replay';
  end if;
  if c.expires_at <= now() then
    -- Chegou tarde: pode ter executado. Fica como desconhecido, com o detalhe, e auditado.
    update public.access_commands set status = 'unknown', result_detail = left(coalesce('tardio: ' || p_detail, 'resultado após o prazo'), 200) where id = c.id;
    perform app.audit(g.tenant_id, 'access.command_late_result', 'access_command', c.id::text, jsonb_build_object('result', p_result));
    return 'expired';
  end if;
  select * into d from public.gateway_devices where id = c.device_id;
  v_status := case p_result when 'acknowledged' then 'acknowledged'
                            when 'physically_confirmed' then case when d.has_physical_sensor then 'physically_confirmed' else 'unknown' end
                            when 'failed' then 'failed' else 'unknown' end;
  update public.access_commands set status = v_status,
         acknowledged_at = case when v_status in ('acknowledged', 'physically_confirmed') then coalesce(acknowledged_at, now()) end,
         confirmed_at = case when v_status = 'physically_confirmed' then now() end, result_detail = left(p_detail, 200)
   where id = c.id;
  update public.gateways set last_seq = greatest(last_seq, c.seq), last_seen_at = now() where id = g.id;
  perform app.emit_event(g.tenant_id, case v_status when 'physically_confirmed' then 'access.physically_confirmed.v1'
      when 'acknowledged' then 'access.device_acknowledged.v1' else 'access.command_failed.v1' end,
    'access_command', c.id, jsonb_build_object('command_id', c.id, 'status', v_status, 'simulated', c.simulated), 'access.result.v1:' || c.id);
  return v_status;
end $$;

-- Painel integrado da portaria (equipe): números, sem listas de dados pessoais além das visitas abertas.
create function public.concierge_overview(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_visitors boolean := app.module_enabled(p_tenant, 'visitors');
begin
  perform app.require(app.is_staff(p_tenant));
  perform app.require_module(p_tenant, 'concierge');
  return jsonb_build_object(
    'parcels', (select jsonb_build_object('waiting', count(*) filter (where p.status in ('RECEBIDA', 'ARMAZENADA')),
        'received_today', count(*) filter (where p.received_at >= date_trunc('day', app.now() at time zone t.timezone) at time zone t.timezone),
        'picked_today', count(*) filter (where p.picked_up_at >= date_trunc('day', app.now() at time zone t.timezone) at time zone t.timezone))
      from public.packages p, public.tenants t where p.tenant_id = p_tenant and t.id = p_tenant),
    'visitors', case when not v_visitors then null else jsonb_build_object(
        'expected_today', (select count(*) from public.visitor_passes x where x.tenant_id = p_tenant and x.status = 'active'
                            and x.valid_from <= app.now() + interval '12 hours' and x.valid_until > app.now() and x.uses < x.max_uses),
        'inside', (select count(*) from public.visitor_visits v where v.tenant_id = p_tenant and v.checked_out_at is null
                    and v.checked_in_at > app.now() - interval '24 hours')) end,
    'gateways', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'kind', g.kind, 'status', g.status,
        'last_seen_at', g.last_seen_at, 'devices', (select count(*) from public.gateway_devices d where d.gateway_id = g.id))
        order by g.created_at), '[]'::jsonb)
      from public.gateways g where g.tenant_id = p_tenant and g.status <> 'revoked'),
    'modules', jsonb_build_object('visitors', v_visitors, 'cctv', app.module_enabled(p_tenant, 'cctv'),
      'access_control', app.module_enabled(p_tenant, 'access_control')));
end $$;

revoke all on sequence public.domain_events_seq_seq from public, anon, authenticated;

-- Nenhum consumidor é criado aqui: cada integração é cadastrada explicitamente pela plataforma (event_consumers),
-- assim não acumulam entregas pendentes sem dono. Eventos sem consumidor saem pela retenção de 90 dias.

revoke all on function app.emit_event(uuid, text, text, uuid, jsonb, text, uuid), app.parcel_events(), app.visitor_pass_status(public.visitor_passes),
  public.event_pull(text, int), public.event_ack(text, uuid, boolean, text), public.event_redeliver(text, uuid), public.event_retention(int),
  public.visitor_pass_create(uuid, uuid, text, text, timestamptz, timestamptz, int, text, text), public.visitor_pass_revoke(uuid, uuid),
  public.visitor_list(uuid, uuid), public.visitor_pass_lookup(uuid, text),
  public.visitor_check_in(uuid, text, text, uuid, text, text, text, text), public.visitor_check_out(uuid, uuid),
  public.gateway_create(uuid, text, text), public.gateway_revoke(uuid, uuid), public.gateway_pair(text, text, text),
  public.gateway_heartbeat(text, timestamptz, jsonb), public.gateway_sweep(), public.access_command_request(uuid, uuid, text, text),
  public.gateway_command_result(text, uuid, bigint, text, text, text), public.concierge_overview(uuid) from public, anon, authenticated;
grant execute on function app.visitor_pass_status(public.visitor_passes), public.event_redeliver(text, uuid),
  public.visitor_pass_create(uuid, uuid, text, text, timestamptz, timestamptz, int, text, text), public.visitor_pass_revoke(uuid, uuid),
  public.visitor_list(uuid, uuid), public.visitor_pass_lookup(uuid, text),
  public.visitor_check_in(uuid, text, text, uuid, text, text, text, text), public.visitor_check_out(uuid, uuid),
  public.gateway_create(uuid, text, text), public.gateway_revoke(uuid, uuid), public.access_command_request(uuid, uuid, text, text),
  public.concierge_overview(uuid) to authenticated;
-- Somente as funções desta migration (nunca "all functions": isso reabriria wrappers internos de migrations antigas).
grant execute on function public.event_pull(text, int), public.event_ack(text, uuid, boolean, text), public.event_retention(int),
  public.gateway_pair(text, text, text), public.gateway_heartbeat(text, timestamptz, jsonb), public.gateway_sweep(),
  public.gateway_command_result(text, uuid, bigint, text, text, text) to service_role;
grant execute on function app.emit_event(uuid, text, text, uuid, jsonb, text, uuid) to service_role;
