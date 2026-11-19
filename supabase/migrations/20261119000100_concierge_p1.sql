-- =============================================================================
-- Evolução modular · P1 · Portaria e Visitantes. Aditiva, sobre o P0 (20261118000100/0200).
--
-- 1) Configuração do módulo por condomínio (validade padrão/máxima do convite, nº de entradas, exige documento,
--    morador pode convidar, avisa morador na entrada).
-- 2) Cadastro de visitantes frequentes e prestadores (visitor_profiles) reaproveitado nas entradas, sem duplicar:
--    mesma pessoa = mesmo cadastro por documento (últimos 4) + nome normalizado dentro do condomínio.
--    Bloqueio de entrada (lista restrita) com motivo e auditoria, decidido por quem tem 'approve'.
-- 3) Ocorrências (incident): registro da portaria com categoria, gravidade, unidade opcional, encerramento.
--    Liga o módulo 'incident' no catálogo (available = true).
-- 4) Integração Encomendas × Portaria SEM duplicar registros: entregador que chega para entregar encomenda é a
--    visita do tipo 'entrega' vinculada às encomendas recebidas na mesma janela (visit_parcels), não um novo cadastro;
--    o recebimento continua 100% nas RPCs atuais.
-- 5) Histórico unificado de acessos (portaria_timeline): visitas + encomendas + ocorrências, paginado, por unidade.
-- 6) Pontos de acesso declarativos (access_points) para a interface futura de câmeras, interfonia e portões —
--    só cadastro e estado; nenhum comando físico nesta fase.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Configuração
-- -----------------------------------------------------------------------------
create table public.concierge_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  pass_default_hours int not null default 24 check (pass_default_hours between 1 and 720),
  pass_max_days int not null default 30 check (pass_max_days between 1 and 30),
  pass_max_uses int not null default 5 check (pass_max_uses between 1 and 20),
  require_document boolean not null default false,
  residents_can_invite boolean not null default true,
  notify_resident_on_arrival boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (pass_default_hours <= pass_max_days * 24)
);
alter table public.concierge_settings enable row level security;
revoke all on public.concierge_settings from public, anon, authenticated;
grant all on public.concierge_settings to service_role;

create function app.concierge_cfg(p_tenant uuid) returns public.concierge_settings
language plpgsql stable security definer set search_path = '' as $$
declare v public.concierge_settings;
begin
  select * into v from public.concierge_settings where tenant_id = p_tenant;
  if not found then
    v.tenant_id := p_tenant; v.pass_default_hours := 24; v.pass_max_days := 30; v.pass_max_uses := 5;
    v.require_document := false; v.residents_can_invite := true; v.notify_resident_on_arrival := true; v.updated_at := now();
  end if;
  return v;
end $$;

create function public.concierge_settings_get(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_member(p_tenant));
  perform app.require_module(p_tenant, 'visitors');
  return to_jsonb(app.concierge_cfg(p_tenant)) - 'updated_by' - 'tenant_id';
end $$;

create function public.concierge_settings_save(p_tenant uuid, p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.concierge_settings; c public.concierge_settings := app.concierge_cfg(p_tenant);
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Requer permissão de configurações.');
  if coalesce(jsonb_typeof(p_cfg), '') <> 'object' then raise exception 'Configuração inválida.' using errcode = '22023'; end if;
  -- Só as chaves enviadas mudam; as demais ficam como estão.
  insert into public.concierge_settings as s (tenant_id, pass_default_hours, pass_max_days, pass_max_uses, require_document,
    residents_can_invite, notify_resident_on_arrival, updated_by, updated_at)
  values (p_tenant, coalesce((p_cfg->>'pass_default_hours')::int, c.pass_default_hours), coalesce((p_cfg->>'pass_max_days')::int, c.pass_max_days),
          coalesce((p_cfg->>'pass_max_uses')::int, c.pass_max_uses), coalesce((p_cfg->>'require_document')::boolean, c.require_document),
          coalesce((p_cfg->>'residents_can_invite')::boolean, c.residents_can_invite),
          coalesce((p_cfg->>'notify_resident_on_arrival')::boolean, c.notify_resident_on_arrival), auth.uid(), now())
  on conflict (tenant_id) do update set pass_default_hours = excluded.pass_default_hours, pass_max_days = excluded.pass_max_days,
    pass_max_uses = excluded.pass_max_uses, require_document = excluded.require_document, residents_can_invite = excluded.residents_can_invite,
    notify_resident_on_arrival = excluded.notify_resident_on_arrival, updated_by = excluded.updated_by, updated_at = now()
  returning * into v;
  perform app.audit(p_tenant, 'concierge.settings_saved', 'tenant', p_tenant::text, to_jsonb(v) - 'updated_by' - 'tenant_id' - 'updated_at');
  return to_jsonb(v) - 'updated_by' - 'tenant_id';
exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
  raise exception 'Valores fora do permitido.' using errcode = '22023';
end $$;

-- -----------------------------------------------------------------------------
-- 2) Cadastro de visitantes/prestadores (sem duplicar pessoa)
-- -----------------------------------------------------------------------------
create table public.visitor_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  kind text not null default 'visita' check (kind in ('visita', 'prestador', 'entrega', 'outro')),
  company text check (company is null or length(company) <= 80),
  document_last4 text check (document_last4 is null or document_last4 ~ '^[0-9A-Za-z]{4}$'),
  courier_id uuid,                                   -- entregador já cadastrado em Encomendas: mesma pessoa, sem novo cadastro
  blocked boolean not null default false,
  blocked_reason text check (blocked_reason is null or length(blocked_reason) between 5 and 300),
  blocked_by uuid references auth.users(id) on delete set null,
  blocked_at timestamptz,
  visits int not null default 0,
  last_visit_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, courier_id) references public.couriers (tenant_id, id) on delete set null (courier_id),
  check (not blocked or blocked_reason is not null)
);
create unique index visitor_profiles_identity_uq on public.visitor_profiles (tenant_id, app.norm_text(full_name), coalesce(document_last4, ''));
create unique index visitor_profiles_courier_uq on public.visitor_profiles (tenant_id, courier_id) where courier_id is not null;
create index visitor_profiles_recent_idx on public.visitor_profiles (tenant_id, last_visit_at desc nulls last);
alter table public.visitor_profiles enable row level security;
revoke all on public.visitor_profiles from public, anon, authenticated;
grant all on public.visitor_profiles to service_role;

alter table public.visitor_visits add column if not exists profile_id uuid;
alter table public.visitor_visits add column if not exists company text check (company is null or length(company) <= 80);
alter table public.visitor_visits add column if not exists notes text check (notes is null or length(notes) <= 300);
alter table public.visitor_visits add column if not exists denied boolean not null default false;
do $$ begin
  alter table public.visitor_visits add constraint visitor_visits_tenant_id_uq unique (tenant_id, id);
exception when duplicate_object or duplicate_table then null; end $$;
do $$ begin
  alter table public.visitor_visits add constraint visitor_visits_profile_fk foreign key (tenant_id, profile_id)
    references public.visitor_profiles (tenant_id, id) on delete set null (profile_id);
exception when duplicate_object then null; end $$;
-- Leitura direta (PostgREST) só das colunas que o morador pode ver; motivo, observação e cadastro ficam nas RPCs da equipe.
revoke select on public.visitor_visits from authenticated;
grant select (id, tenant_id, unit_id, visitor_name, kind, method, checked_in_at, checked_out_at, denied) on public.visitor_visits to authenticated;
create index if not exists visitor_visits_profile_idx on public.visitor_visits (tenant_id, profile_id, checked_in_at desc) where profile_id is not null;
create index if not exists visitor_visits_unit_idx on public.visitor_visits (tenant_id, unit_id, checked_in_at desc);

-- Encontra ou cria o cadastro (mesma pessoa = mesmo nome normalizado + mesmos 4 dígitos, ou mesmo entregador).
create function app.visitor_profile_upsert(p_tenant uuid, p_name text, p_kind text, p_doc4 text, p_company text, p_courier uuid)
returns public.visitor_profiles language plpgsql security definer set search_path = '' as $$
declare v public.visitor_profiles; v_name text := regexp_replace(btrim(p_name), '\s+', ' ', 'g'); v_doc text := nullif(btrim(p_doc4), '');
begin
  if p_courier is not null then
    select * into v from public.visitor_profiles where tenant_id = p_tenant and courier_id = p_courier;
    if found then return v; end if;
  end if;
  select * into v from public.visitor_profiles where tenant_id = p_tenant and app.norm_text(full_name) = app.norm_text(v_name)
     and coalesce(document_last4, '') = coalesce(v_doc, '');
  if found then
    if p_courier is not null and v.courier_id is null then update public.visitor_profiles set courier_id = p_courier where id = v.id returning * into v; end if;
    return v;
  end if;
  insert into public.visitor_profiles (tenant_id, full_name, kind, company, document_last4, courier_id)
  values (p_tenant, v_name, coalesce(p_kind, 'visita'), nullif(btrim(p_company), ''), v_doc, p_courier)
  on conflict do nothing returning * into v;
  if v.id is null then   -- outra entrada simultânea criou a mesma pessoa: reaproveita
    select * into v from public.visitor_profiles where tenant_id = p_tenant and app.norm_text(full_name) = app.norm_text(v_name)
       and coalesce(document_last4, '') = coalesce(v_doc, '');
  end if;
  return v;
end $$;

create function public.visitor_profile_search(p_tenant uuid, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_n text := app.norm_text(btrim(coalesce(p_query, '')));
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.is_staff(p_tenant));
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'kind', p.kind, 'company', p.company,
      'document_last4', p.document_last4, 'blocked', p.blocked, 'blocked_reason', p.blocked_reason, 'visits', p.visits,
      'last_visit_at', p.last_visit_at, 'courier_id', p.courier_id) order by p.last_visit_at desc nulls last, p.full_name)
    from (select * from public.visitor_profiles x where x.tenant_id = p_tenant
            and (v_n is null or length(v_n) < 2 or not exists (select 1 from unnest(string_to_array(v_n, ' ')) w where strpos(app.norm_text(x.full_name), w) = 0)
                 or app.norm_text(coalesce(x.company, '')) like '%' || v_n || '%')
           order by x.last_visit_at desc nulls last, x.full_name limit 20) p), '[]'::jsonb);
end $$;

-- Bloqueio: só quem aprova cadastros ('approve'); motivo obrigatório; desbloqueio idem. Auditado.
create function public.visitor_profile_block(p_tenant uuid, p_profile uuid, p_blocked boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.visitor_profiles;
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros pode bloquear ou liberar visitantes.');
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe o motivo (mín. 5 caracteres).' using errcode = '22023'; end if;
  update public.visitor_profiles set blocked = p_blocked, blocked_reason = case when p_blocked then btrim(p_reason) end,
         blocked_by = auth.uid(), blocked_at = now()
   where tenant_id = p_tenant and id = p_profile returning * into v;
  if not found then raise exception 'Cadastro não encontrado.' using errcode = 'P0002'; end if;
  perform app.audit(p_tenant, case when p_blocked then 'visitor.blocked' else 'visitor.unblocked' end, 'visitor_profile', v.id::text,
    jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('id', v.id, 'blocked', v.blocked);
end $$;

-- -----------------------------------------------------------------------------
-- Entrada (P1): substitui visitor_check_in mantendo a mesma assinatura do P0 e acrescentando a versão completa.
-- Regras novas: convite respeita a configuração; visitante bloqueado não entra (registro de entrada negada fica
-- no histórico); cadastro reaproveitado; entregador ligado às encomendas recebidas sem novo registro de encomenda.
-- -----------------------------------------------------------------------------
create function public.visitor_entry(p_tenant uuid, p_idempotency_key text, p_qr text default null, p_unit uuid default null,
  p_name text default null, p_kind text default 'visita', p_authorized_by text default null, p_reason text default null,
  p_profile uuid default null, p_document_last4 text default null, p_company text default null, p_notes text default null,
  p_courier uuid default null, p_confirm_distinct boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.visitor_passes; r public.visitor_visits; pr public.visitor_profiles; cfg public.concierge_settings := app.concierge_cfg(p_tenant);
        v_method text := case when nullif(btrim(p_qr), '') is null then 'manual' else 'qr' end; v_name text; v_kind text; v_unit uuid;
        v_doc text := nullif(btrim(p_document_last4), '');
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.is_staff(p_tenant));
  select * into r from public.visitor_visits where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('id', r.id, 'replayed', true, 'unit_id', r.unit_id, 'denied', r.denied); end if;

  if v_method = 'qr' then
    select * into v from public.visitor_passes where token_hash = app.sha256_hex(regexp_replace(btrim(p_qr), '^PV1\.', '')) for update;
    if not found or v.tenant_id <> p_tenant then raise exception 'Convite não reconhecido neste condomínio.' using errcode = 'P0002'; end if;
    if v.status = 'revoked' then raise exception 'Convite revogado pelo morador.' using errcode = 'P0001'; end if;
    if v.valid_from > app.now() then raise exception 'Convite ainda não começou a valer.' using errcode = 'P0001'; end if;
    if v.valid_until <= app.now() then raise exception 'Convite expirado.' using errcode = 'P0001'; end if;
    if v.uses >= v.max_uses or v.status = 'used' then raise exception 'Convite já utilizado.' using errcode = 'P0001'; end if;
    if not exists (select 1 from public.units where tenant_id = p_tenant and id = v.unit_id and active)
       or not (exists (select 1 from public.unit_memberships um where um.tenant_id = p_tenant and um.unit_id = v.unit_id
                        and um.user_id = v.created_by and um.status = 'active')
               or exists (select 1 from public.tenant_memberships m where m.tenant_id = p_tenant and m.user_id = v.created_by
                        and m.status = 'active' and m.role in ('admin', 'porteiro'))) then
      raise exception 'Convite sem validade: quem convidou não tem mais vínculo com a unidade.' using errcode = 'P0001';
    end if;
    v_name := v.visitor_name; v_kind := v.kind; v_unit := v.unit_id; v_doc := coalesce(v_doc, v.document_last4);
  else
    if p_unit is null or not exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active) then
      raise exception 'Selecione a unidade.' using errcode = '22023';
    end if;
    if p_profile is not null then
      select * into pr from public.visitor_profiles where tenant_id = p_tenant and id = p_profile;
      if not found then raise exception 'Cadastro não encontrado.' using errcode = 'P0002'; end if;
      v_name := pr.full_name; v_kind := coalesce(p_kind, pr.kind); v_doc := coalesce(v_doc, pr.document_last4);
    else
      v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_kind := coalesce(p_kind, 'visita');
    end if;
    if length(v_name) < 2 then raise exception 'Informe o nome do visitante.' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_authorized_by, ''))) < 2 then raise exception 'Informe quem autorizou a entrada.' using errcode = '22023'; end if;
    v_unit := p_unit;
  end if;
  if cfg.require_document and v_doc is null then
    raise exception 'Este condomínio exige os 4 últimos dígitos do documento do visitante.' using errcode = '22023';
  end if;
  if p_courier is not null and not exists (select 1 from public.couriers where tenant_id = p_tenant and id = p_courier) then
    raise exception 'Entregador não encontrado.' using errcode = 'P0002';
  end if;
  if pr.id is null then pr := app.visitor_profile_upsert(p_tenant, v_name, v_kind, v_doc, p_company, p_courier); end if;
  -- Mesmo nome de uma pessoa bloqueada (outro documento ou sem documento): não passa sem a equipe confirmar que é outra pessoa.
  if not pr.blocked and exists (select 1 from public.visitor_profiles b where b.tenant_id = p_tenant and b.blocked and b.id <> pr.id
       and app.norm_text(b.full_name) = app.norm_text(pr.full_name)) then
    if not coalesce(p_confirm_distinct, false) then
      raise exception 'Atenção: há uma pessoa bloqueada com este nome. Confira o documento e confirme que é outra pessoa.' using errcode = 'P0001', hint = 'namesake';
    end if;
    perform app.audit(p_tenant, 'visitor.namesake_confirmed', 'visitor_profile', pr.id::text);
  end if;

  -- Bloqueado: não entra. Fica registrado como tentativa negada (histórico e auditoria), sem consumir o convite.
  if pr.blocked then
    insert into public.visitor_visits (tenant_id, pass_id, unit_id, visitor_name, kind, method, authorized_by_name, reason, idempotency_key,
                                       checked_in_by, checked_out_at, checked_out_by, profile_id, company, notes, denied)
    values (p_tenant, v.id, v_unit, pr.full_name, v_kind, v_method, nullif(btrim(p_authorized_by), ''), 'Entrada não autorizada (cadastro bloqueado)', p_idempotency_key,
            auth.uid(), now(), auth.uid(), pr.id, coalesce(nullif(btrim(p_company), ''), pr.company), nullif(btrim(p_notes), ''), true) returning * into r;
    perform app.audit(p_tenant, 'visitor.entry_denied', 'visitor_visit', r.id::text, jsonb_build_object('why', 'blocked'));
    perform app.emit_event(p_tenant, 'access.denied.v1', 'visitor_pass', coalesce(v.id, r.id),
      jsonb_build_object('visit_id', r.id, 'unit_id', v_unit, 'why', 'blocked'), 'access.denied.v1:' || r.id);
    return jsonb_build_object('id', r.id, 'replayed', false, 'denied', true, 'reason', pr.blocked_reason, 'visitor_name', pr.full_name);
  end if;

  if v.id is not null then
    update public.visitor_passes set uses = uses + 1, status = case when uses + 1 >= max_uses then 'used' else status end where id = v.id;
  end if;
  insert into public.visitor_visits (tenant_id, pass_id, unit_id, visitor_name, kind, method, authorized_by_name, reason, idempotency_key,
                                     checked_in_by, profile_id, company, notes)
  values (p_tenant, v.id, v_unit, pr.full_name, v_kind, v_method, case when v_method = 'manual' then btrim(p_authorized_by) end,
          nullif(btrim(p_reason), ''), p_idempotency_key, auth.uid(), pr.id, coalesce(nullif(btrim(p_company), ''), pr.company), nullif(btrim(p_notes), ''))
  returning * into r;
  update public.visitor_profiles set visits = visits + 1, last_visit_at = now() where id = pr.id;
  if p_courier is not null then update public.couriers set last_visit_at = now() where tenant_id = p_tenant and id = p_courier; end if;

  perform app.emit_event(p_tenant, 'visitor.arrived.v1', 'visitor_pass', coalesce(r.pass_id, r.id),
    jsonb_build_object('visit_id', r.id, 'pass_id', r.pass_id, 'unit_id', r.unit_id, 'method', r.method, 'kind', r.kind), 'visitor.arrived.v1:' || r.id);
  perform app.emit_event(p_tenant, 'visitor.authorized.v1', 'visitor_pass', coalesce(r.pass_id, r.id),
    jsonb_build_object('visit_id', r.id, 'unit_id', r.unit_id, 'by', r.method), 'visitor.authorized.v1:' || r.id);
  perform app.audit(p_tenant, 'visitor.checked_in', 'visitor_visit', r.id::text, jsonb_build_object('method', r.method, 'kind', r.kind));
  if cfg.notify_resident_on_arrival and r.kind <> 'entrega' then
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    select p_tenant, um.user_id, 'visitor_arrived', 'Visitante na portaria', r.visitor_name || ' entrou às ' ||
           to_char(r.checked_in_at at time zone coalesce((select timezone from public.tenants where id = p_tenant), 'America/Sao_Paulo'), 'HH24:MI') || '.'
      from public.unit_memberships um where um.tenant_id = p_tenant and um.unit_id = r.unit_id and um.status = 'active';
  end if;
  return jsonb_build_object('id', r.id, 'replayed', false, 'denied', false, 'unit_id', r.unit_id, 'visitor_name', r.visitor_name,
    'method', r.method, 'profile_id', pr.id);
end $$;

-- Assinatura do P0 preservada: delega para a versão completa (clientes antigos continuam funcionando).
create or replace function public.visitor_check_in(p_tenant uuid, p_idempotency_key text, p_qr text default null, p_unit uuid default null,
  p_name text default null, p_kind text default 'visita', p_authorized_by text default null, p_reason text default null) returns jsonb
language sql security definer set search_path = '' as $$
  select public.visitor_entry(p_tenant, p_idempotency_key, p_qr, p_unit, p_name, p_kind, p_authorized_by, p_reason)
$$;

-- Convite respeitando a configuração do condomínio (validade padrão/máxima, entradas, morador pode convidar).
create or replace function public.visitor_pass_create(p_tenant uuid, p_unit uuid, p_name text, p_kind text default 'visita',
  p_valid_from timestamptz default null, p_valid_until timestamptz default null, p_max_uses int default 1,
  p_document_last4 text default null, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tok text := app.random_token(); v public.visitor_passes; v_from timestamptz := coalesce(p_valid_from, app.now());
        cfg public.concierge_settings := app.concierge_cfg(p_tenant); v_until timestamptz; v_staff boolean;
begin
  perform app.require_module(p_tenant, 'visitors');
  v_staff := app.is_staff(p_tenant);
  perform app.require(app.is_unit_member(p_tenant, p_unit) or v_staff, 'Sem permissão para convidar para esta unidade.');
  perform app.require(v_staff or cfg.residents_can_invite, 'Neste condomínio, convites são feitos pela portaria.');
  perform app.require(app.can_operate(p_tenant), 'Condomínio com acesso restrito: novos convites indisponíveis.');
  if not exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active) then
    raise exception 'Unidade não encontrada.' using errcode = 'P0002';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o nome do visitante.' using errcode = '22023'; end if;
  if cfg.require_document and nullif(btrim(p_document_last4), '') is null then
    raise exception 'Este condomínio exige os 4 últimos dígitos do documento do visitante.' using errcode = '22023';
  end if;
  v_until := coalesce(p_valid_until, v_from + make_interval(hours => cfg.pass_default_hours));
  if v_until > v_from + make_interval(days => cfg.pass_max_days) then
    raise exception 'Validade máxima neste condomínio: % dia(s).', cfg.pass_max_days using errcode = '22023';
  end if;
  if coalesce(p_max_uses, 1) > cfg.pass_max_uses then
    raise exception 'Máximo de % entrada(s) por convite neste condomínio.', cfg.pass_max_uses using errcode = '22023';
  end if;
  if (select count(*) from public.visitor_passes where tenant_id = p_tenant and unit_id = p_unit and status = 'active' and valid_until > app.now()) >= 50 then
    raise exception 'Limite de 50 convites ativos por unidade.' using errcode = 'P0001';
  end if;
  insert into public.visitor_passes (tenant_id, unit_id, visitor_name, kind, document_last4, notes, valid_from, valid_until, max_uses, token_hash, created_by)
  values (p_tenant, p_unit, regexp_replace(btrim(p_name), '\s+', ' ', 'g'), coalesce(p_kind, 'visita'), nullif(btrim(p_document_last4), ''),
          nullif(btrim(p_notes), ''), v_from, v_until, coalesce(p_max_uses, 1), app.sha256_hex(v_tok), auth.uid())
  returning * into v;
  perform app.emit_event(p_tenant, 'visitor.invited.v1', 'visitor_pass', v.id,
    jsonb_build_object('pass_id', v.id, 'unit_id', v.unit_id, 'kind', v.kind, 'valid_until', v.valid_until), 'visitor.invited.v1:' || v.id);
  perform app.audit(p_tenant, 'visitor.pass_created', 'visitor_pass', v.id::text, jsonb_build_object('kind', v.kind, 'max_uses', v.max_uses));
  return jsonb_build_object('id', v.id, 'qr', 'PV1.' || v_tok, 'valid_from', v.valid_from, 'valid_until', v.valid_until);
end $$;

create or replace function public.visitor_list(p_tenant uuid, p_unit uuid default null) returns jsonb
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
        'authorized_by_name', v.authorized_by_name, 'denied', case when v_staff then v.denied end) order by v.checked_in_at desc), '[]'::jsonb)
      from (select * from public.visitor_visits x where x.tenant_id = p_tenant and (p_unit is null or x.unit_id = p_unit)
              and (v_staff or (app.is_unit_member(p_tenant, x.unit_id) and not x.denied))
              and (x.checked_out_at is null or x.checked_in_at > app.now() - interval '30 days') order by x.checked_in_at desc limit 200) v
      join public.units u on u.id = v.unit_id));
end $$;

-- -----------------------------------------------------------------------------
-- 4) Encomendas × Portaria sem duplicar: a visita de entrega aponta para as encomendas que o entregador trouxe.
-- -----------------------------------------------------------------------------
create table public.visit_parcels (
  tenant_id uuid not null,
  visit_id uuid not null,
  package_id uuid not null,
  linked_at timestamptz not null default now(),
  primary key (visit_id, package_id),
  foreign key (tenant_id, visit_id) references public.visitor_visits (tenant_id, id) on delete cascade,
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id) on delete cascade
);
create unique index visit_parcels_package_uq on public.visit_parcels (tenant_id, package_id);
alter table public.visit_parcels enable row level security;
revoke all on public.visit_parcels from public, anon, authenticated;
grant all on public.visit_parcels to service_role;

-- Vincula encomendas JÁ registradas (pelas RPCs de Encomendas) à visita de entrega. Não cria encomenda.
create function public.visit_link_parcels(p_tenant uuid, p_visit uuid, p_packages uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.visitor_visits; n int;
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.is_staff(p_tenant));
  select * into r from public.visitor_visits where tenant_id = p_tenant and id = p_visit;
  if not found or r.kind <> 'entrega' then raise exception 'Visita de entrega não encontrada.' using errcode = 'P0002'; end if;
  if cardinality(coalesce(p_packages, '{}')) > 100 then raise exception 'Máximo de 100 encomendas por entrega.' using errcode = '22023'; end if;
  insert into public.visit_parcels (tenant_id, visit_id, package_id)
  select p_tenant, p_visit, p.id from public.packages p
   where p.tenant_id = p_tenant and p.id = any (p_packages) and p.received_at >= r.checked_in_at - interval '2 hours'
     and p.received_at <= coalesce(r.checked_out_at, app.now()) + interval '10 minutes'
  on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('linked', n);
end $$;

-- Encomendas recebidas na janela da visita de entrega (para o porteiro marcar), sem dados pessoais do morador.
create function public.visit_parcel_candidates(p_tenant uuid, p_visit uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.visitor_visits;
begin
  perform app.require_module(p_tenant, 'visitors');
  perform app.require(app.is_staff(p_tenant));
  select * into r from public.visitor_visits where tenant_id = p_tenant and id = p_visit;
  if not found then raise exception 'Visita não encontrada.' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'carrier', p.carrier, 'tracking_code', p.tracking_code, 'received_at', p.received_at,
      'unit', app.unit_display(p_tenant, u.block, u.label), 'linked', exists (select 1 from public.visit_parcels vp where vp.package_id = p.id and vp.visit_id = p_visit))
      order by p.received_at desc)
    from public.packages p left join public.units u on u.id = p.unit_id
   where p.tenant_id = p_tenant and p.received_at between r.checked_in_at - interval '2 hours' and coalesce(r.checked_out_at, app.now()) + interval '10 minutes'
     and not exists (select 1 from public.visit_parcels vp where vp.package_id = p.id and vp.visit_id <> p_visit)
   limit 100), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- 3) Ocorrências
-- -----------------------------------------------------------------------------
create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid,
  visit_id uuid,
  category text not null check (category in ('seguranca', 'manutencao', 'convivencia', 'acesso', 'encomenda', 'recado', 'outro')),
  severity text not null default 'baixa' check (severity in ('baixa', 'media', 'alta')),
  title text not null check (length(btrim(title)) between 3 and 120),
  description text check (description is null or length(description) <= 2000),
  status text not null default 'aberta' check (status in ('aberta', 'encerrada')),
  resolution text check (resolution is null or length(resolution) <= 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz,
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id) on delete set null (unit_id),
  foreign key (tenant_id, visit_id) references public.visitor_visits (tenant_id, id) on delete set null (visit_id),
  unique (tenant_id, idempotency_key),
  check (status = 'aberta' or (closed_at is not null and resolution is not null))
);
create index incidents_tenant_idx on public.incidents (tenant_id, created_at desc);
create index incidents_open_idx on public.incidents (tenant_id) where status = 'aberta';
alter table public.incidents enable row level security;
revoke all on public.incidents from public, anon, authenticated;
grant all on public.incidents to service_role;

update public.module_catalog set available = true, phase = 'P1' where key = 'incident';

create function public.incident_create(p_tenant uuid, p_idempotency_key text, p_category text, p_title text, p_description text default null,
  p_severity text default 'baixa', p_unit uuid default null, p_visit uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.incidents;
begin
  perform app.require_module(p_tenant, 'incident');
  perform app.require(app.is_staff(p_tenant));
  select * into i from public.incidents where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('id', i.id, 'replayed', true); end if;
  if p_unit is not null and not exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit) then
    raise exception 'Unidade não encontrada.' using errcode = 'P0002';
  end if;
  if p_visit is not null and not exists (select 1 from public.visitor_visits where tenant_id = p_tenant and id = p_visit) then
    raise exception 'Visita não encontrada.' using errcode = 'P0002';
  end if;
  insert into public.incidents (tenant_id, unit_id, visit_id, category, severity, title, description, created_by, idempotency_key)
  values (p_tenant, p_unit, p_visit, p_category, coalesce(p_severity, 'baixa'), btrim(p_title), nullif(btrim(p_description), ''), auth.uid(), p_idempotency_key)
  returning * into i;
  perform app.audit(p_tenant, 'incident.created', 'incident', i.id::text, jsonb_build_object('category', i.category, 'severity', i.severity));
  -- Gravidade alta avisa a administração pela caixa interna existente.
  if i.severity = 'alta' then
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    select p_tenant, m.user_id, 'incident', 'Ocorrência de gravidade alta', i.title
      from public.tenant_memberships m where m.tenant_id = p_tenant and m.role = 'admin' and m.status = 'active' and m.user_id <> coalesce(auth.uid(), m.user_id);
  end if;
  return jsonb_build_object('id', i.id, 'replayed', false);
exception when check_violation then raise exception 'Categoria, gravidade ou título inválidos.' using errcode = '22023';
end $$;

create function public.incident_close(p_tenant uuid, p_incident uuid, p_resolution text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.incidents;
begin
  perform app.require_module(p_tenant, 'incident');
  perform app.require(app.is_staff(p_tenant));
  if length(btrim(coalesce(p_resolution, ''))) < 3 then raise exception 'Descreva como foi resolvida.' using errcode = '22023'; end if;
  update public.incidents set status = 'encerrada', resolution = btrim(p_resolution), closed_by = auth.uid(), closed_at = now()
   where tenant_id = p_tenant and id = p_incident and status = 'aberta' returning * into i;
  if not found then raise exception 'Ocorrência não encontrada ou já encerrada.' using errcode = 'P0001'; end if;
  perform app.audit(p_tenant, 'incident.closed', 'incident', i.id::text);
  return jsonb_build_object('id', i.id, 'status', i.status);
end $$;

create function public.incident_list(p_tenant uuid, p_status text default null, p_limit int default 50, p_before timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_module(p_tenant, 'incident');
  perform app.require(app.is_staff(p_tenant));
  return coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'category', i.category, 'severity', i.severity, 'title', i.title,
      'description', i.description, 'status', i.status, 'resolution', i.resolution, 'created_at', i.created_at, 'closed_at', i.closed_at,
      'unit', app.unit_display(p_tenant, u.block, u.label), 'unit_id', i.unit_id,
      'created_by_name', (select full_name from public.profiles where id = i.created_by)) order by i.created_at desc)
    from (select * from public.incidents x where x.tenant_id = p_tenant and (p_status is null or x.status = p_status)
            and (p_before is null or x.created_at < p_before) order by x.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) i
    left join public.units u on u.id = i.unit_id), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- 5) Histórico unificado (portaria): visitas, encomendas e ocorrências por período/unidade, paginado.
-- -----------------------------------------------------------------------------
create function public.portaria_timeline(p_tenant uuid, p_unit uuid default null, p_from timestamptz default null,
  p_to timestamptz default null, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := coalesce(p_from, app.now() - interval '7 days'); v_to timestamptz := coalesce(p_to, app.now());
        v_lim int := least(greatest(coalesce(p_limit, 100), 1), 500); v_vis boolean := app.module_enabled(p_tenant, 'visitors');
        v_inc boolean := app.module_enabled(p_tenant, 'incident');
begin
  perform app.require(app.is_staff(p_tenant));
  perform app.require_module(p_tenant, 'concierge');
  if v_to - v_from > interval '93 days' then raise exception 'Período máximo de 93 dias.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(e order by (e->>'at') desc) from (
    select x.e from (
      select jsonb_build_object('type', 'parcel_received', 'at', p.received_at, 'id', p.id, 'unit', app.unit_display(p_tenant, u.block, u.label),
               'title', p.carrier || coalesce(' · ' || p.tracking_code, ''), 'detail', p.courier_name) e, p.received_at at
        from public.packages p left join public.units u on u.id = p.unit_id
       where p.tenant_id = p_tenant and p.received_at between v_from and v_to and (p_unit is null or p.unit_id = p_unit)
      union all
      select jsonb_build_object('type', 'parcel_picked_up', 'at', p.picked_up_at, 'id', p.id, 'unit', app.unit_display(p_tenant, u.block, u.label),
               'title', p.carrier, 'detail', p.picked_up_by_name), p.picked_up_at
        from public.packages p left join public.units u on u.id = p.unit_id
       where p.tenant_id = p_tenant and p.picked_up_at between v_from and v_to and (p_unit is null or p.unit_id = p_unit)
      union all
      select jsonb_build_object('type', case when v.denied then 'visit_denied' else 'visit_in' end, 'at', v.checked_in_at, 'id', v.id,
               'unit', app.unit_display(p_tenant, u.block, u.label), 'title', v.visitor_name, 'detail', v.kind || ' · ' || v.method ||
               coalesce(' · autorizado por ' || v.authorized_by_name, '') || coalesce(' · ' || v.company, ''),
               'parcels', (select count(*) from public.visit_parcels vp where vp.visit_id = v.id)), v.checked_in_at
        from public.visitor_visits v join public.units u on u.id = v.unit_id
       where v_vis and v.tenant_id = p_tenant and v.checked_in_at between v_from and v_to and (p_unit is null or v.unit_id = p_unit)
      union all
      select jsonb_build_object('type', 'visit_out', 'at', v.checked_out_at, 'id', v.id, 'unit', app.unit_display(p_tenant, u.block, u.label),
               'title', v.visitor_name, 'detail', v.kind), v.checked_out_at
        from public.visitor_visits v join public.units u on u.id = v.unit_id
       where v_vis and not v.denied and v.tenant_id = p_tenant and v.checked_out_at between v_from and v_to and (p_unit is null or v.unit_id = p_unit)
      union all
      select jsonb_build_object('type', 'incident', 'at', i.created_at, 'id', i.id, 'unit', app.unit_display(p_tenant, u.block, u.label),
               'title', i.title, 'detail', i.category || ' · ' || i.severity || ' · ' || i.status), i.created_at
        from public.incidents i left join public.units u on u.id = i.unit_id
       where v_inc and i.tenant_id = p_tenant and i.created_at between v_from and v_to and (p_unit is null or i.unit_id = p_unit)
    ) x order by x.at desc limit v_lim) t(e)), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- 6) Pontos de acesso declarativos (interface futura: câmera, interfone, portão). Sem comando.
-- -----------------------------------------------------------------------------
create table public.access_points (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 60),
  kind text not null check (kind in ('portao_pedestre', 'portao_veiculos', 'porta', 'cancela', 'camera', 'interfone')),
  location text check (location is null or length(location) <= 80),
  device_id uuid,
  status text not null default 'not_installed' check (status in ('not_installed', 'simulated', 'pending_hardware', 'homologated', 'offline')),
  sort int not null default 100,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, device_id) references public.gateway_devices (tenant_id, id) on delete set null (device_id)
);
alter table public.access_points enable row level security;
revoke all on public.access_points from public, anon, authenticated;
grant all on public.access_points to service_role;

create function public.access_points_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_staff(p_tenant));
  perform app.require_module(p_tenant, 'concierge');
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'location', a.location,
      -- Estado real: sem dispositivo = não instalado; com dispositivo, o estado e a homologação dele (nunca "online" inventado).
      'status', case when a.device_id is null then a.status
                     when d.homologation_status = 'simulated' then 'simulated'
                     when d.homologation_status in ('tested_lab', 'tested_field') and d.state = 'online' then 'homologated'
                     when d.state = 'offline' then 'offline' else 'pending_hardware' end,
      'device_state', d.state, 'homologation', d.homologation_status) order by a.sort, a.name)
    from public.access_points a left join public.gateway_devices d on d.id = a.device_id where a.tenant_id = p_tenant), '[]'::jsonb);
end $$;

create function public.access_point_save(p_tenant uuid, p_id uuid, p_name text, p_kind text, p_location text default null, p_sort int default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.access_points;
begin
  perform app.require_module(p_tenant, 'concierge');
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Requer permissão de configurações.');
  if p_id is null then
    if (select count(*) from public.access_points where tenant_id = p_tenant) >= 50 then raise exception 'Limite de 50 pontos de acesso.' using errcode = 'P0001'; end if;
    insert into public.access_points (tenant_id, name, kind, location, sort) values (p_tenant, btrim(p_name), p_kind, nullif(btrim(p_location), ''), coalesce(p_sort, 100))
    returning * into a;
  else
    update public.access_points set name = btrim(p_name), kind = p_kind, location = nullif(btrim(p_location), ''), sort = coalesce(p_sort, sort)
     where tenant_id = p_tenant and id = p_id returning * into a;
    if not found then raise exception 'Ponto de acesso não encontrado.' using errcode = 'P0002'; end if;
  end if;
  perform app.audit(p_tenant, 'access_point.saved', 'access_point', a.id::text, jsonb_build_object('kind', a.kind));
  return jsonb_build_object('id', a.id);
exception when check_violation then raise exception 'Nome ou tipo inválidos.' using errcode = '22023';
end $$;

create function public.access_point_delete(p_tenant uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_module(p_tenant, 'concierge');
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Requer permissão de configurações.');
  delete from public.access_points where tenant_id = p_tenant and id = p_id;
  if not found then raise exception 'Ponto de acesso não encontrado.' using errcode = 'P0002'; end if;
  perform app.audit(p_tenant, 'access_point.deleted', 'access_point', p_id::text);
end $$;

-- -----------------------------------------------------------------------------
-- Painel do síndico: indicadores da portaria (por período), sem dados pessoais.
-- -----------------------------------------------------------------------------
create function public.concierge_kpis(p_tenant uuid, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_from timestamptz := app.now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
begin
  perform app.require(app.is_admin(p_tenant));
  perform app.require_module(p_tenant, 'visitors');
  return jsonb_build_object(
    'visits', (select count(*) from public.visitor_visits where tenant_id = p_tenant and not denied and checked_in_at >= v_from),
    'denied', (select count(*) from public.visitor_visits where tenant_id = p_tenant and denied and checked_in_at >= v_from),
    'by_kind', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) n from public.visitor_visits
                 where tenant_id = p_tenant and not denied and checked_in_at >= v_from group by 1) k),
    'by_method', (select coalesce(jsonb_object_agg(method, n), '{}'::jsonb) from (select method, count(*) n from public.visitor_visits
                 where tenant_id = p_tenant and not denied and checked_in_at >= v_from group by 1) m),
    'passes_created', (select count(*) from public.visitor_passes where tenant_id = p_tenant and created_at >= v_from),
    'open_incidents', case when app.module_enabled(p_tenant, 'incident') then (select count(*) from public.incidents where tenant_id = p_tenant and status = 'aberta') end,
    'avg_stay_minutes', (select round(avg(extract(epoch from (checked_out_at - checked_in_at)) / 60)) from public.visitor_visits
                          where tenant_id = p_tenant and not denied and checked_out_at is not null and checked_in_at >= v_from));
end $$;

revoke all on function app.concierge_cfg(uuid), app.visitor_profile_upsert(uuid, text, text, text, text, uuid),
  public.concierge_settings_get(uuid), public.concierge_settings_save(uuid, jsonb), public.visitor_profile_search(uuid, text),
  public.visitor_profile_block(uuid, uuid, boolean, text),
  public.visitor_entry(uuid, text, text, uuid, text, text, text, text, uuid, text, text, text, uuid, boolean),
  public.visit_link_parcels(uuid, uuid, uuid[]), public.visit_parcel_candidates(uuid, uuid),
  public.incident_create(uuid, text, text, text, text, text, uuid, uuid), public.incident_close(uuid, uuid, text),
  public.incident_list(uuid, text, int, timestamptz), public.portaria_timeline(uuid, uuid, timestamptz, timestamptz, int),
  public.access_points_list(uuid), public.access_point_save(uuid, uuid, text, text, text, int), public.access_point_delete(uuid, uuid),
  public.concierge_kpis(uuid, int) from public, anon;
grant execute on function public.concierge_settings_get(uuid), public.concierge_settings_save(uuid, jsonb), public.visitor_profile_search(uuid, text),
  public.visitor_profile_block(uuid, uuid, boolean, text),
  public.visitor_entry(uuid, text, text, uuid, text, text, text, text, uuid, text, text, text, uuid, boolean),
  public.visit_link_parcels(uuid, uuid, uuid[]), public.visit_parcel_candidates(uuid, uuid),
  public.incident_create(uuid, text, text, text, text, text, uuid, uuid), public.incident_close(uuid, uuid, text),
  public.incident_list(uuid, text, int, timestamptz), public.portaria_timeline(uuid, uuid, timestamptz, timestamptz, int),
  public.access_points_list(uuid), public.access_point_save(uuid, uuid, text, text, text, int), public.access_point_delete(uuid, uuid),
  public.concierge_kpis(uuid, int) to authenticated, service_role;
revoke all on function app.concierge_cfg(uuid), app.visitor_profile_upsert(uuid, text, text, text, text, uuid) from authenticated;
