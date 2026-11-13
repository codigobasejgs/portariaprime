-- =============================================================================
-- Portaria Prime IA — assistente do condomínio no WhatsApp (Whaileys). Estritamente aditiva.
--
-- Modelo de segurança:
--  * Número vinculado = (condomínio, conta da EQUIPE ativa, telefone, nível). Só o síndico com 'team' cadastra.
--  * O webhook (service_role) nunca decide permissão. Toda leitura/ação roda por app.assistant_as(), que fixa
--    request.jwt.claim.sub = conta vinculada DENTRO da transação: as RPCs existentes aplicam as mesmas regras
--    do painel (is_admin, has_perm, can_operate, limites). Sem conta/vínculo ativo, nada roda.
--  * Nível: basic (leitura e relatórios), intermediate (+ ações com confirmação), advanced (+ áudio, foto, arquivo).
--    O nível é conferido no banco a cada execução, não só no servidor.
--  * Escrita: sempre ação pendente (10 min) -> resumo -> Confirmar. assistant_confirm executa uma vez
--    (status + for update), grava audit_logs com via 'Portaria Prime IA (WhatsApp)'.
--  * Mensagens recebidas deduplicadas por id do provedor (entrega "pelo menos uma vez").
-- =============================================================================

create table public.assistant_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  phone text not null check (phone ~ '^55\d{10,11}$'),
  level text not null default 'basic' check (level in ('basic', 'intermediate', 'advanced')),
  label text check (label is null or length(btrim(label)) between 1 and 60),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Um telefone por condomínio; o mesmo telefone pode servir a mais de um condomínio (escolha no WhatsApp).
create unique index assistant_links_phone_uq on public.assistant_links (tenant_id, phone);
create index assistant_links_phone_idx on public.assistant_links (phone) where active;

create table public.assistant_sessions (
  phone text primary key check (phone ~ '^55\d{10,11}$'),
  tenant_id uuid references public.tenants(id) on delete cascade,
  options text[] not null default '{}',          -- ids das opções numeradas do último card ("1", "2"...)
  updated_at timestamptz not null default now()
);

create table public.assistant_pending (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.assistant_links(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  action text not null check (action in ('approve_resident', 'reject_resident', 'destinate_package', 'return_package',
    'keyword_used', 'receive_package', 'register_courier')),
  params jsonb not null,
  summary text not null check (length(summary) <= 1500),
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled', 'expired', 'failed')),
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index assistant_pending_link_idx on public.assistant_pending (link_id, status, created_at desc);

create table public.assistant_messages (
  provider_id text primary key check (length(provider_id) between 4 and 128),
  phone text not null,
  created_at timestamptz not null default now()
);
create index assistant_messages_created_idx on public.assistant_messages (created_at);
create index assistant_messages_phone_idx on public.assistant_messages (phone, created_at desc);

-- Orçamento de IA (texto livre e áudio) por condomínio e dia, contado no banco (vale entre instâncias do servidor).
create table public.assistant_ai_usage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day date not null,
  n int not null default 0,
  primary key (tenant_id, day)
);

-- Nada disso é lido ou escrito direto por usuários: só pelas RPCs abaixo (e o service_role do webhook).
alter table public.assistant_links enable row level security;
alter table public.assistant_sessions enable row level security;
alter table public.assistant_pending enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.assistant_ai_usage enable row level security;
revoke all on public.assistant_links, public.assistant_sessions, public.assistant_pending, public.assistant_messages, public.assistant_ai_usage from public, anon, authenticated;
grant select, insert, update, delete on public.assistant_sessions, public.assistant_messages to service_role;
grant select on public.assistant_links, public.assistant_pending to service_role;

-- -----------------------------------------------------------------------------
-- Helpers internos
-- -----------------------------------------------------------------------------
create or replace function app.assistant_phone(p text) returns text
language sql immutable set search_path = '' as $$
  -- Celular brasileiro sem o 9º dígito (como o WhatsApp às vezes envia) vira a forma com 9.
  select case
    when d ~ '^55\d{2}[6-9]\d{7}$' then left(d, 4) || '9' || right(d, 8)
    when d ~ '^\d{10,11}$' then app.assistant_phone('55' || d)
    when d ~ '^55\d{10,11}$' then d
  end from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') d) x
$$;

create or replace function app.assistant_level_rank(p text) returns int
language sql immutable set search_path = '' as $$
  select case p when 'basic' then 1 when 'intermediate' then 2 when 'advanced' then 3 else 0 end
$$;

/**
 * Vínculo utilizável: ativo, condomínio ativo, conta da equipe ainda ativa nesse condomínio.
 * Porteiro com identidade biométrica só opera em turno (app.is_staff exige sessão de turno). O WhatsApp não abre
 * turno, então esse porteiro fica fora do assistente; porteiro sem biometria (login simples) segue a regra do painel.
 */
create or replace function app.assistant_link_ok(l public.assistant_links) returns boolean
language sql stable security definer set search_path = '' as $$
  select l.active and exists (
    select 1 from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = l.tenant_id and m.user_id = l.user_id and m.status = 'active' and t.status = 'active'
      and (m.role = 'admin' or (m.role = 'porteiro'
        and not exists (select 1 from public.porter_identities pi where pi.tenant_id = l.tenant_id and pi.user_id = l.user_id))))
$$;

/** Passa a agir como a conta vinculada nesta transação (as RPCs existentes leem auth.uid()). */
create or replace function app.assistant_as(p_link uuid, p_min_level text) returns public.assistant_links
language plpgsql security definer set search_path = '' as $$
declare l public.assistant_links;
begin
  select * into l from public.assistant_links where id = p_link;
  if not found or not app.assistant_link_ok(l) then
    raise exception 'Número não autorizado neste condomínio.' using errcode = '42501';
  end if;
  if app.assistant_level_rank(l.level) < app.assistant_level_rank(p_min_level) then
    raise exception 'Seu nível no assistente não permite esta ação.' using errcode = '42501';
  end if;
  perform set_config('request.jwt.claim.sub', l.user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', l.user_id, 'role', 'authenticated', 'via', 'whatsapp')::text, true);
  return l;
end $$;

revoke all on function app.assistant_phone(text), app.assistant_level_rank(text), app.assistant_link_ok(public.assistant_links),
  app.assistant_as(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Painel do síndico (permissão 'team'): números autorizados e nível de cada um
-- -----------------------------------------------------------------------------
create or replace function public.assistant_links_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'team'), 'Somente quem gerencia a equipe vê os números do assistente.');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', l.id, 'phone', l.phone, 'level', l.level, 'label', l.label, 'active', l.active, 'user_id', l.user_id,
      'full_name', coalesce(p.full_name, u.email::text), 'role', m.role, 'usable', app.assistant_link_ok(l), 'created_at', l.created_at)
    order by l.created_at)
    from public.assistant_links l
    join auth.users u on u.id = l.user_id
    left join public.profiles p on p.id = l.user_id
    left join public.tenant_memberships m on m.tenant_id = l.tenant_id and m.user_id = l.user_id and m.role in ('admin', 'porteiro')
    where l.tenant_id = p_tenant), '[]'::jsonb);
end $$;

/** Equipe que pode receber um número (admins e porteiros ativos). */
create or replace function public.assistant_team_options(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'team'), 'Somente quem gerencia a equipe vê os números do assistente.');
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role,
      'full_name', coalesce(p.full_name, u.email::text)) order by m.role, coalesce(p.full_name, u.email::text))
    from public.tenant_memberships m join auth.users u on u.id = m.user_id left join public.profiles p on p.id = m.user_id
    where m.tenant_id = p_tenant and m.status = 'active' and m.role in ('admin', 'porteiro')), '[]'::jsonb);
end $$;

create or replace function public.assistant_link_save(p_tenant uuid, p_id uuid, p_user uuid, p_phone text, p_level text, p_label text, p_active boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_phone text := app.assistant_phone(p_phone); l public.assistant_links;
begin
  perform app.require(app.has_perm(p_tenant, 'team'), 'Somente quem gerencia a equipe vê os números do assistente.');
  perform app.require(app.has_feature(p_tenant, 'whatsapp'), 'O assistente no WhatsApp exige plano com WhatsApp.');
  -- Dar um WhatsApp para agir em nome de alguém é ação sensível: senha recente (e MFA, se ativo), como no painel.
  perform app.mdm_require_recent_auth();
  if v_phone is null then raise exception 'Informe o WhatsApp com DDD (ex.: 11 99999-0000).' using errcode = '22023'; end if;
  if coalesce(p_level, '') not in ('basic', 'intermediate', 'advanced') then raise exception 'Nível inválido.' using errcode = '22023'; end if;
  if not exists (select 1 from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and status = 'active' and role in ('admin', 'porteiro')) then
    raise exception 'Escolha uma pessoa ativa da equipe (síndico, administrador ou porteiro).' using errcode = '22023';
  end if;
  -- Sem escalada: só vincula a conta de outra pessoa quem já tem todas as permissões dela (mesma regra dos convites).
  if p_user <> auth.uid() and not (coalesce(app.user_permissions(p_tenant, p_user), '{}') <@ coalesce(app.user_permissions(p_tenant, auth.uid()), '{}')) then
    raise exception 'Você não pode autorizar um número para alguém com mais permissões que você.' using errcode = '42501';
  end if;
  if p_id is null then
    insert into public.assistant_links (tenant_id, user_id, phone, level, label, active, created_by)
    values (p_tenant, p_user, v_phone, p_level, nullif(btrim(coalesce(p_label, '')), ''), coalesce(p_active, true), auth.uid())
    returning * into l;
  else
    update public.assistant_links set user_id = p_user, phone = v_phone, level = p_level, label = nullif(btrim(coalesce(p_label, '')), ''),
      active = coalesce(p_active, active), updated_at = now()
    where id = p_id and tenant_id = p_tenant returning * into l;
    if not found then raise exception 'Número não encontrado.' using errcode = 'P0002'; end if;
    -- Nível ou dono mudou: ações pendentes antigas deixam de valer.
    update public.assistant_pending set status = 'cancelled', decided_at = now() where link_id = l.id and status = 'pending';
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (p_tenant, auth.uid(), 'assistant.link_saved', 'assistant_link', l.id::text,
    jsonb_build_object('level', l.level, 'active', l.active, 'phone_last4', right(l.phone, 4), 'user_id', l.user_id));
  return jsonb_build_object('id', l.id, 'phone', l.phone, 'level', l.level, 'active', l.active);
exception when unique_violation then
  raise exception 'Este WhatsApp já está cadastrado neste condomínio.' using errcode = '23505';
end $$;

create or replace function public.assistant_link_delete(p_tenant uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_phone text;
begin
  perform app.require(app.has_perm(p_tenant, 'team'), 'Somente quem gerencia a equipe vê os números do assistente.');
  delete from public.assistant_links where id = p_id and tenant_id = p_tenant returning phone into v_phone;
  if v_phone is null then raise exception 'Número não encontrado.' using errcode = 'P0002'; end if;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (p_tenant, auth.uid(), 'assistant.link_deleted', 'assistant_link', p_id::text, jsonb_build_object('phone_last4', right(v_phone, 4)));
end $$;

revoke all on function public.assistant_links_list(uuid), public.assistant_team_options(uuid),
  public.assistant_link_save(uuid, uuid, uuid, text, text, text, boolean), public.assistant_link_delete(uuid, uuid) from public, anon;
grant execute on function public.assistant_links_list(uuid), public.assistant_team_options(uuid),
  public.assistant_link_save(uuid, uuid, uuid, text, text, text, boolean), public.assistant_link_delete(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Webhook (service_role): quem é este telefone, leituras e ações como a conta vinculada
-- -----------------------------------------------------------------------------
/** Vínculos utilizáveis do telefone (pode haver mais de um condomínio). Telefone desconhecido = lista vazia. */
create or replace function public.assistant_resolve(p_phone text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('link_id', l.id, 'tenant_id', l.tenant_id, 'tenant_name', t.name, 'level', l.level,
      'role', m.role, 'can_approve', m.role = 'admin' and 'approve' = any (m.permissions), 'is_admin', m.role = 'admin',
      'full_name', coalesce(p.full_name, 'você'), 'timezone', t.timezone, 'feature_ocr', app.has_feature(l.tenant_id, 'ocr'))
    order by t.name), '[]'::jsonb)
  from public.assistant_links l
  join public.tenants t on t.id = l.tenant_id
  join public.tenant_memberships m on m.tenant_id = l.tenant_id and m.user_id = l.user_id and m.status = 'active' and m.role in ('admin', 'porteiro')
  left join public.profiles p on p.id = l.user_id
  where l.phone = app.assistant_phone(p_phone) and app.assistant_link_ok(l) and app.has_feature(l.tenant_id, 'whatsapp')
$$;

/**
 * Leituras do assistente, sempre como a conta vinculada (nível basic basta). Cada tipo reaproveita a RPC do painel,
 * então o que a pessoa não vê no sistema também não vê no WhatsApp.
 */
create or replace function public.assistant_read(p_link uuid, p_kind text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.assistant_links; v_tz text; v_from date; v_to date; v_days int; r jsonb; v_today date;
begin
  l := app.assistant_as(p_link, 'basic');
  select timezone into v_tz from public.tenants where id = l.tenant_id;
  v_today := (app.now() at time zone v_tz)::date;
  if p_kind = 'today' then
    -- Pendências do dia: só o que a conta pode ver (porteiro não vê cadastros pendentes nem a fila do síndico).
    return jsonb_build_object(
      'waiting', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status)),
      'overdue_7d', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.received_at <= app.now() - interval '7 days'),
      'overdue_72h', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.received_at <= app.now() - interval '72 hours'),
      'rejected', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.rejected_at is not null),
      'unidentified', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.unidentified_reason is not null),
      'received_today', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and (p.received_at at time zone v_tz)::date = v_today and p.status <> 'PRE_REGISTRADA'),
      'picked_today', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and (p.picked_up_at at time zone v_tz)::date = v_today),
      'access_requests', public.access_requests_pending_count(l.tenant_id),
      'keywords', jsonb_array_length(public.list_delivery_keywords(l.tenant_id, null)),
      'oldest', coalesce((select jsonb_agg(x) from (select jsonb_build_object('ref', app.package_ref(p.id), 'unit', concat_ws(' ', u.block, u.label),
          'carrier', p.carrier, 'recipient', p.recipient_name, 'days', floor(extract(epoch from app.now() - p.received_at) / 86400)::int) x
        from public.packages p left join public.units u on u.id = p.unit_id
        where p.tenant_id = l.tenant_id and app.occupies_space(p.status) order by p.received_at limit 5) s), '[]'::jsonb));
  elsif p_kind = 'pending_by_unit' then
    -- Filtro por bloco/unidade com a mesma normalização do OCR ("Bloco 01A" = "01A").
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('ref', app.package_ref(p.id), 'unit', concat_ws(' ', u.block, u.label),
        'carrier', p.carrier, 'recipient', p.recipient_name, 'storage', sl.code,
        'days', floor(extract(epoch from app.now() - p.received_at) / 86400)::int, 'rejected', p.rejected_at is not null) x
      from public.packages p join public.units u on u.id = p.unit_id left join public.storage_locations sl on sl.id = p.storage_location_id
      where p.tenant_id = l.tenant_id and app.occupies_space(p.status)
        and (nullif(p_args->>'block', '') is null or app.norm_block(u.block) = app.norm_block(p_args->>'block'))
        and (nullif(p_args->>'unit', '') is null or app.norm_unit(u.label) = app.norm_unit(p_args->>'unit'))
      order by p.received_at limit 15) s), '[]'::jsonb);
  elsif p_kind = 'access_requests' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', e->>'id', 'name', e->>'full_name', 'unit', concat_ws(' ', e->>'block_text', e->>'unit_text'),
        'unit_id', e->>'unit_id', 'relation', e->>'relation') x
      from jsonb_array_elements(public.list_access_requests(l.tenant_id, 'pending')) e limit 10) s), '[]'::jsonb);
  elsif p_kind = 'unidentified' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', e->>'id', 'ref', app.package_ref((e->>'id')::uuid),
        'unit', concat_ws(' ', e->>'unit_block', e->>'unit_label'), 'carrier', e->>'carrier', 'recipient', e->>'recipient_name') x
      from jsonb_array_elements(public.list_unidentified_packages(l.tenant_id)) e limit 10) s), '[]'::jsonb);
  elsif p_kind = 'keywords' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', e->>'id', 'keyword', e->>'keyword',
        'unit', concat_ws(' ', e->>'unit_block', e->>'unit_label'), 'carrier', e->>'carrier') x
      from jsonb_array_elements(public.list_delivery_keywords(l.tenant_id, null)) e limit 10) s), '[]'::jsonb);
  elsif p_kind = 'report' then
    v_days := case p_args->>'period' when 'today' then 0 when 'month' then 29 when '3m' then 89 when '6m' then 179 when 'year' then 364 end;
    if v_days is null then raise exception 'Período inválido.' using errcode = '22023'; end if;
    v_to := v_today; v_from := v_today - v_days;
    -- Mesmos números da aba Análise (só administrador), mais ranking de porteiros e entregadores.
    r := public.dashboard_executive(l.tenant_id, v_from, v_to, '{}'::jsonb);
    return jsonb_build_object('from', v_from, 'to', v_to, 'received', r->'received'->'value', 'delivered', r->'delivered'->'value',
      'pending_now', r->'pending_now', 'overdue_now', r->'overdue_now', 'avg_pickup_h', r->'pickup_time'->'avg_h',
      'carriers', r->'carriers', 'occupancy', (public.dashboard_operation(l.tenant_id, 72))->'occupancy',
      'rejected', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and p.rejected_at is not null
        and (p.received_at at time zone v_tz)::date between v_from and v_to),
      'unidentified', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and p.unidentified_reason is not null
        and (p.received_at at time zone v_tz)::date between v_from and v_to),
      'porters', coalesce((select jsonb_agg(x order by (x->>'n')::int desc) from (select jsonb_build_object('name', coalesce(p.received_by_name, 'Sem nome'), 'n', count(*)) x
        from public.packages p where p.tenant_id = l.tenant_id and p.status <> 'PRE_REGISTRADA' and (p.received_at at time zone v_tz)::date between v_from and v_to
        group by coalesce(p.received_by_name, 'Sem nome') order by count(*) desc limit 5) s), '[]'::jsonb),
      'couriers', (select count(distinct coalesce(p.courier_id::text, lower(btrim(p.courier_name)))) from public.packages p
        where p.tenant_id = l.tenant_id and p.courier_name is not null and (p.received_at at time zone v_tz)::date between v_from and v_to));
  elsif p_kind = 'unit_lookup' then
    -- Unidade por texto + moradores (nome e situação). Usado para montar ações (destinatário, destino).
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', u.id, 'unit', concat_ws(' ', u.block, u.label),
        'residents', public.unit_residents_for_staff(l.tenant_id, u.id)) x
      from public.units u where u.tenant_id = l.tenant_id and u.active
        and (nullif(p_args->>'block', '') is null or app.norm_block(u.block) = app.norm_block(p_args->>'block'))
        and app.norm_unit(u.label) = app.norm_unit(p_args->>'unit')
      order by u.block nulls first, u.label limit 5) s), '[]'::jsonb);
  elsif p_kind = 'match_label' then
    return public.match_recipient(l.tenant_id, p_args->>'name', p_args->>'block', p_args->>'unit');
  elsif p_kind = 'consume_ocr' then
    return to_jsonb(public.consume_ocr(l.tenant_id));
  end if;
  raise exception 'Consulta desconhecida.' using errcode = '22023';
end $$;

/** Nível mínimo por ação. Leitura = basic; ações = intermediate; ações que nascem de foto = advanced. */
create or replace function app.assistant_action_level(p_action text) returns text
language sql immutable set search_path = '' as $$
  select case when p_action in ('receive_package', 'register_courier') then 'advanced' else 'intermediate' end
$$;
revoke all on function app.assistant_action_level(text) from public, anon, authenticated;

/** Cria a ação pendente (10 min). Só uma pendente por número: a nova substitui a anterior. */
create or replace function public.assistant_propose(p_link uuid, p_action text, p_params jsonb, p_summary text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.assistant_links; p public.assistant_pending;
begin
  l := app.assistant_as(p_link, app.assistant_action_level(p_action));
  if p_params is null or jsonb_typeof(p_params) <> 'object' or length(p_params::text) > 4000 then
    raise exception 'Dados da ação inválidos.' using errcode = '22023';
  end if;
  update public.assistant_pending set status = 'cancelled', decided_at = now() where link_id = l.id and status = 'pending';
  insert into public.assistant_pending (link_id, tenant_id, action, params, summary, expires_at)
  values (l.id, l.tenant_id, p_action, p_params, left(coalesce(p_summary, ''), 1500), app.now() + interval '10 minutes')
  returning * into p;
  return jsonb_build_object('id', p.id, 'expires_at', p.expires_at);
end $$;

create or replace function public.assistant_cancel(p_link uuid, p_pending uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.assistant_pending set status = 'cancelled', decided_at = now()
  where id = p_pending and link_id = p_link and status = 'pending';
  get diagnostics n = row_count;
  return jsonb_build_object('cancelled', n > 0);
end $$;

/**
 * Executa a ação confirmada, uma única vez, como a conta vinculada. Nível conferido de novo (pode ter mudado).
 * Erro de regra (ex.: unidade lotada) marca a pendente como failed e devolve a mensagem; nada fica pela metade
 * porque cada RPC chamada é transacional e esta função roda numa transação só.
 */
create or replace function public.assistant_confirm(p_link uuid, p_pending uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.assistant_pending; l public.assistant_links; r jsonb; a jsonb; v_msg text;
begin
  select * into p from public.assistant_pending where id = p_pending and link_id = p_link for update;
  if not found then raise exception 'Ação não encontrada.' using errcode = 'P0002'; end if;
  if p.status = 'done' then return jsonb_build_object('status', 'done', 'replayed', true, 'result', p.result); end if;
  if p.status <> 'pending' then return jsonb_build_object('status', p.status); end if;
  if p.expires_at <= app.now() then
    update public.assistant_pending set status = 'expired', decided_at = now() where id = p.id;
    return jsonb_build_object('status', 'expired');
  end if;
  l := app.assistant_as(p_link, app.assistant_action_level(p.action));
  a := p.params;
  -- Defesa em profundidade: o pedido de cadastro precisa ser do condomínio deste vínculo
  -- (decide_access_request autoriza pelo condomínio do pedido; a mesma conta pode administrar dois).
  if p.action in ('approve_resident', 'reject_resident') and not exists (
      select 1 from public.access_requests where id = nullif(a->>'request_id', '')::uuid and tenant_id = l.tenant_id) then
    update public.assistant_pending set status = 'failed', decided_at = now(), result = jsonb_build_object('error', 'Cadastro não encontrado neste condomínio.') where id = p.id;
    return jsonb_build_object('status', 'failed', 'error', 'Cadastro não encontrado neste condomínio.');
  end if;
  begin
    if p.action = 'approve_resident' then
      r := public.decide_access_request((a->>'request_id')::uuid, true, nullif(a->>'unit_id', '')::uuid, null);
    elsif p.action = 'reject_resident' then
      r := public.decide_access_request((a->>'request_id')::uuid, false, null, a->>'reason');
    elsif p.action = 'destinate_package' then
      r := public.package_destinate(l.tenant_id, (a->>'package_id')::uuid, (a->>'unit_id')::uuid, a->>'recipient', nullif(a->>'resident_user', '')::uuid);
    elsif p.action = 'return_package' then
      r := public.resolve_package(l.tenant_id, (a->>'package_id')::uuid, 'DEVOLVIDA', a->>'reason');
    elsif p.action = 'keyword_used' then
      r := to_jsonb(public.delivery_keyword_mark_used(l.tenant_id, (a->>'keyword_id')::uuid));
    elsif p.action = 'receive_package' then
      -- Guarda física: o local foi informado no resumo e a pessoa confirmou que guardou nele.
      r := public.receive_and_store(l.tenant_id, 'wa-' || p.id::text, (a->>'unit_id')::uuid, nullif(a->>'tracking', ''), coalesce(nullif(a->>'carrier', ''), 'Outra'),
        nullif(a->>'recipient', ''), 'Registrada pelo assistente no WhatsApp.', nullif(a->>'storage_location_id', '')::uuid, null,
        coalesce(nullif(a->>'courier', ''), 'Informado no WhatsApp'), coalesce(nullif(a->>'received_by', ''), 'Assistente WhatsApp'));
    elsif p.action = 'register_courier' then
      r := public.courier_upsert_from_ocr(l.tenant_id, a->>'full_name', nullif(a->>'cpf', ''), nullif(a->>'cnh', ''), nullif(a->>'category', ''), nullif(a->>'carrier', ''));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    update public.assistant_pending set status = 'failed', decided_at = now(), result = jsonb_build_object('error', left(v_msg, 300)) where id = p.id;
    return jsonb_build_object('status', 'failed', 'error', left(v_msg, 300));
  end;
  update public.assistant_pending set status = 'done', decided_at = now(), result = coalesce(r, '{}'::jsonb) where id = p.id;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (l.tenant_id, l.user_id, 'assistant.' || p.action, 'assistant_pending', p.id::text,
    jsonb_build_object('via', 'Portaria Prime IA (WhatsApp)', 'phone_last4', right(l.phone, 4), 'level', l.level, 'summary', left(p.summary, 400)));
  return jsonb_build_object('status', 'done', 'result', coalesce(r, '{}'::jsonb));
end $$;

/**
 * Local de guarda sugerido para registro por foto: o de mais espaço (mesma ordem de storage_availability).
 * Sem locais cadastrados = {} (receive_and_store aceita sem local). Todos lotados = {full: true}.
 */
create or replace function public.assistant_storage(p_link uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.assistant_links; a jsonb; e jsonb;
begin
  l := app.assistant_as(p_link, 'advanced');
  a := public.storage_availability(l.tenant_id);
  if a is null or jsonb_array_length(a) = 0 then return '{}'::jsonb; end if;
  select x into e from jsonb_array_elements(a) x where (x->>'free')::int > 0 limit 1;
  if e is null then return jsonb_build_object('full', true); end if;
  return jsonb_build_object('id', e->>'id', 'name', concat_ws(' › ', e->>'concierge', e->>'rack', e->>'shelf', case when e->>'rack' is null then e->>'code' end));
end $$;
revoke all on function public.assistant_storage(uuid) from public, anon, authenticated;
grant execute on function public.assistant_storage(uuid) to service_role;

/**
 * Limites de uso antes de cada resposta: até 20 mensagens por telefone em 10 minutos (todas as mensagens) e,
 * quando a mensagem vai para a IA (texto livre/áudio), até 400 chamadas por condomínio por dia. Atômico.
 */
create or replace function public.assistant_rate(p_link uuid, p_phone text, p_ai boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.assistant_links; v_recent int; v_day date; v_n int;
begin
  select * into l from public.assistant_links where id = p_link;
  if not found then return jsonb_build_object('ok', false, 'reason', 'link'); end if;
  select count(*) into v_recent from public.assistant_messages where phone = app.assistant_phone(p_phone) and created_at > now() - interval '10 minutes';
  if v_recent > 20 then return jsonb_build_object('ok', false, 'reason', 'phone'); end if;
  if not coalesce(p_ai, false) then return jsonb_build_object('ok', true); end if;
  v_day := (app.now() at time zone coalesce((select timezone from public.tenants where id = l.tenant_id), 'America/Sao_Paulo'))::date;
  insert into public.assistant_ai_usage (tenant_id, day, n) values (l.tenant_id, v_day, 1)
  on conflict (tenant_id, day) do update set n = public.assistant_ai_usage.n + 1 returning n into v_n;
  if v_n > 400 then return jsonb_build_object('ok', false, 'reason', 'tenant'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.assistant_rate(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.assistant_rate(uuid, text, boolean) to service_role;

/** Limpeza: pendentes vencidas e ids de mensagem com mais de 2 dias (chamado pelo job diário). */
create or replace function public.assistant_housekeeping() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a int; b int;
begin
  update public.assistant_pending set status = 'expired', decided_at = now() where status = 'pending' and expires_at <= app.now();
  get diagnostics a = row_count;
  -- LGPD: documento da CNH só serve até a confirmação. Encerradas há mais de 1 dia perdem os parâmetros sensíveis.
  update public.assistant_pending set params = jsonb_build_object('redacted', true), result = null
  where status <> 'pending' and decided_at < now() - interval '1 day' and not (params ? 'redacted');
  delete from public.assistant_pending where created_at < now() - interval '90 days';
  delete from public.assistant_ai_usage where day < current_date - 40;
  delete from public.assistant_messages where created_at < now() - interval '2 days';
  get diagnostics b = row_count;
  return jsonb_build_object('expired', a, 'messages_deleted', b);
end $$;

revoke all on function public.assistant_resolve(text), public.assistant_read(uuid, text, jsonb), public.assistant_propose(uuid, text, jsonb, text),
  public.assistant_cancel(uuid, uuid), public.assistant_confirm(uuid, uuid), public.assistant_housekeeping() from public, anon, authenticated;
grant execute on function public.assistant_resolve(text), public.assistant_read(uuid, text, jsonb), public.assistant_propose(uuid, text, jsonb, text),
  public.assistant_cancel(uuid, uuid), public.assistant_confirm(uuid, uuid), public.assistant_housekeeping() to service_role;
