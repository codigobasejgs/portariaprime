-- Três evoluções, só aditivas (nada é apagado; registros antigos continuam válidos):
-- 1) Nomenclatura de endereço por condomínio (Bloco/Apartamento, Torre/Unidade, Rua/Casa, Quadra/Lote, livre).
-- 2) Gestão de moradores pelo síndico: em 20261106000300_resident_management.
-- 3) Nome do entregador e do porteiro obrigatórios em todo recebimento novo (colunas aceitam NULL nos antigos).

-- Ambiente de demonstração (/demonstracao e /c/demonstracao): nenhum condomínio real pode usar o slug.
-- Mesma lista de 20261022000600 + 'demonstracao' e 'demo'. A restrição da tabela já usa esta função.
create or replace function app.reserved_slug(p text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(p) in ('admin','api','app','c','entrar','cadastro','convite','onboarding','checkout','totem','assets','brand',
    'screens','sw','manifest','termos','privacidade','recuperar-senha','nova-senha','portaria','morador','suporte','ajuda',
    'portariaprime','www','login','logout','static','public','demonstracao','demo')
$$;

-- -----------------------------------------------------------------------------
-- 1) Rótulos de endereço
-- -----------------------------------------------------------------------------
alter table public.tenant_settings add column if not exists unit_group_label text not null default 'Bloco'
  check (length(btrim(unit_group_label)) between 1 and 20);
alter table public.tenant_settings add column if not exists unit_number_label text not null default 'Apartamento'
  check (length(btrim(unit_number_label)) between 1 and 20);
alter table public.tenant_settings add column if not exists condo_type text not null default 'vertical'
  check (condo_type in ('vertical', 'vertical_torre', 'horizontal_casas', 'horizontal_lotes', 'personalizado'));
-- Mesma política settings_update (permissão "settings"); colunas liberadas explicitamente.
grant update (unit_group_label, unit_number_label, condo_type) on public.tenant_settings to authenticated;

-- "Bloco A · 101" (padrão, igual ao de antes), "Quadra B · Lote 15", "Rua das Palmeiras · Casa 12".
-- Número da unidade só ganha prefixo quando o rótulo não é o padrão "Apartamento" (nada muda para quem já usa).
create or replace function app.unit_display(p_tenant uuid, p_block text, p_label text) returns text
language sql stable security definer set search_path = '' as $$
  with l as (select coalesce(s.unit_group_label, 'Bloco') g, coalesce(s.unit_number_label, 'Apartamento') n
               from (select 1) x left join public.tenant_settings s on s.tenant_id = p_tenant),
       v as (select nullif(btrim(p_block), '') b, nullif(btrim(p_label), '') u)
  select nullif(concat_ws(' · ',
    case when v.b is null then null when upper(v.b) like upper(l.g) || '%' then v.b else l.g || ' ' || v.b end,
    case when v.u is null then null when l.n = 'Apartamento' or upper(v.u) like upper(l.n) || '%' then v.u else l.n || ' ' || v.u end), '')
  from l, v
$$;

-- Prefixos horizontais (Quadra, Rua, Lote, Casa…) além dos verticais já aceitos. Os antigos mantêm o
-- comportamento; os novos exigem espaço ou dígito em seguida (não cortam palavras como "Norte").
create or replace function app.norm_unit(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(replace(regexp_replace(regexp_replace(coalesce(app.norm_text(p), ''),
    '^(APARTAMENTO|APTO|APT|AP|UNIDADE|UN|SALA|CASA|LOJA) ?', ''),
    '^(LOTE|LT|CS|CHACARA|NUMERO|NUM|N)( |(?=[0-9]))', ''), ' ', ''), '')
$$;
create or replace function app.norm_block(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(replace(regexp_replace(regexp_replace(coalesce(app.norm_text(p), ''),
    '^(BLOCO|BL|TORRE|TR|EDIFICIO|ED) ?', ''),
    '^(QUADRA|QD|RUA|ALAMEDA|AL|AVENIDA|AV|SETOR|MODULO|VILA)( |(?=[0-9]))', ''), ' ', ''), '')
$$;

-- Portal público (cadastro do morador): rótulos junto das unidades. Mesma assinatura e grants.
create or replace function public.portal_units(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('has_blocks', coalesce(bool_or(nullif(btrim(u.block), '') is not null), false),
    'units', coalesce(jsonb_agg(jsonb_build_object('block', nullif(btrim(u.block), ''), 'label', u.label)
      order by nullif(btrim(u.block), '') nulls first, length(u.label), u.label) filter (where u.id is not null), '[]'::jsonb),
    'group_label', coalesce(max(s.unit_group_label), 'Bloco'), 'number_label', coalesce(max(s.unit_number_label), 'Apartamento'))
    from public.tenants t left join public.units u on u.tenant_id = t.id and u.active
    left join public.tenant_settings s on s.tenant_id = t.id
   where t.slug = lower(btrim(p_slug)) and t.status = 'active'
   group by t.id
$$;

-- Totem pareado: rótulos junto das unidades. Mesma assinatura e grants.
create or replace function public.device_context(p_secret_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.device_enrollments;
begin
  select * into d from public.device_enrollments where secret_hash = p_secret_hash and status = 'active';
  if not found then raise exception 'Totem não pareado ou revogado.' using errcode = '42501'; end if;
  if not app.has_feature(d.tenant_id, 'totem') then raise exception 'Totem indisponível no plano atual.' using errcode = '42501'; end if;
  update public.device_enrollments set last_seen_at = now() where id = d.id;
  return jsonb_build_object('device_id', d.id, 'tenant_id', d.tenant_id, 'device_name', d.name,
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'block', block, 'label', label) order by block nulls first, label)
                       from public.units where tenant_id = d.tenant_id and active), '[]'::jsonb),
    'group_label', coalesce((select unit_group_label from public.tenant_settings where tenant_id = d.tenant_id), 'Bloco'),
    'number_label', coalesce((select unit_number_label from public.tenant_settings where tenant_id = d.tenant_id), 'Apartamento'));
end $$;

-- Avisos (WhatsApp/e-mail/push): unidade com os rótulos do condomínio. Encadeia a versão vigente.
do $$
begin
  if to_regprocedure('app.notification_context_before_units(uuid)') is null then
    alter function public.notification_context(uuid) rename to notification_context_before_units;
    alter function public.notification_context_before_units(uuid) set schema app;
  end if;
end $$;
create or replace function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := app.notification_context_before_units(p_job); u text;
begin
  if v ? 'package' and jsonb_typeof(v->'package') = 'object' then
    select app.unit_display(p.tenant_id, un.block, un.label) into u
      from public.packages p left join public.units un on un.id = p.unit_id where p.id = (v->'package'->>'id')::uuid;
    if u is not null then v := jsonb_set(v, '{package,unit}', to_jsonb(u)); end if;
  end if;
  return v;
end $$;
revoke all on function app.notification_context_before_units(uuid), app.unit_display(uuid, text, text) from public, anon, authenticated;
revoke all on function public.notification_context(uuid) from public, anon, authenticated;
grant execute on function public.notification_context(uuid), app.notification_context_before_units(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 3) Entregador e porteiro no recebimento
-- -----------------------------------------------------------------------------
alter table public.packages add column if not exists received_by_name text
  check (received_by_name is null or length(received_by_name) <= 120);

-- Porteiro: o nome digitado; vazio = nome do operador logado. Sem nenhum dos dois, recusa.
create or replace function app.receiver_name(p text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  v := coalesce(v, (select nullif(btrim(full_name), '') from public.profiles where id = auth.uid()));
  if v is null then raise exception 'Informe o nome do porteiro que está recebendo.' using errcode = '22023'; end if;
  if length(v) > 120 then raise exception 'Nome do porteiro muito longo (máx. 120).' using errcode = '22023'; end if;
  return v;
end $$;
create or replace function app.courier_required(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  if v is null or length(v) < 2 then raise exception 'Informe o nome do entregador.' using errcode = '22023'; end if;
  if length(v) > 80 then raise exception 'Nome do entregador muito longo (máx. 80).' using errcode = '22023'; end if;
  return v;
end $$;

-- Mesma lógica de 20261019000600, com entregador e porteiro. Assinatura nova: a antiga sai para não haver ambiguidade.
drop function if exists public.receive_and_store(uuid, text, uuid, text, text, text, text, uuid, text);
drop function if exists public.receive_package(uuid, text, uuid, text, text, text, text, uuid, uuid);
create function public.receive_package(
  p_tenant uuid, p_idempotency_key text, p_unit uuid, p_tracking text, p_carrier text,
  p_recipient text default null, p_notes text default null,
  p_concierge uuid default null, p_storage_location uuid default null,
  p_courier text default null, p_received_by_name text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_conc uuid; v_loc uuid; v_jobs int; v_courier text; v_receiver text;
begin
  perform app.require(app.is_staff(p_tenant));
  select * into v from public.packages where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then return app.package_json(v) || jsonb_build_object('replayed', true); end if;

  perform app.require(app.can_operate(p_tenant),
    'Assinatura inativa: novos recebimentos estão bloqueados. Regularize em Assinatura. Retiradas continuam liberadas.');
  perform app.require(exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active), 'Unidade inválida.');
  v_courier := app.courier_required(p_courier);
  v_receiver := app.receiver_name(p_received_by_name);

  if nullif(btrim(p_tracking), '') is not null and exists (select 1 from public.packages
      where tenant_id = p_tenant and upper(tracking_code) = upper(btrim(p_tracking)) and app.is_pending(status)) then
    raise exception 'Já existe uma encomenda pendente com o rastreio %. Verifique antes de registrar de novo.', upper(btrim(p_tracking))
      using errcode = 'P0001';
  end if;
  v_conc := coalesce(p_concierge, app.default_concierge(p_tenant));
  perform app.require(exists (select 1 from public.concierge_locations where tenant_id = p_tenant and id = v_conc and active), 'Portaria inválida.');
  v_loc := app.pick_storage(p_tenant, v_conc, p_storage_location);

  begin
    insert into public.packages (tenant_id, unit_id, concierge_location_id, storage_location_id, status,
      tracking_code, carrier, recipient_name, notes, registered_via, idempotency_key, received_at, received_by, stored_at,
      courier_name, received_by_name)
    values (p_tenant, p_unit, v_conc, v_loc, case when v_loc is null then 'RECEBIDA' else 'ARMAZENADA' end,
      nullif(upper(btrim(p_tracking)), ''), coalesce(nullif(btrim(p_carrier), ''), 'Outra'),
      nullif(btrim(p_recipient), ''), nullif(btrim(p_notes), ''), 'portaria', p_idempotency_key,
      app.now(), auth.uid(), case when v_loc is null then null else app.now() end, v_courier, v_receiver)
    returning * into v;
  exception when unique_violation then
    if exists (select 1 from public.packages where tenant_id = p_tenant and idempotency_key = p_idempotency_key) then
      select * into v from public.packages where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
      return app.package_json(v) || jsonb_build_object('replayed', true);
    end if;
    raise exception 'Já existe uma encomenda pendente com o rastreio %. Verifique antes de registrar de novo.', upper(btrim(p_tracking))
      using errcode = 'P0001';
  end;

  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, 'received', auth.uid(), jsonb_build_object('storage_location_id', v_loc, 'courier_name', v_courier, 'received_by_name', v_receiver));
  v_jobs := app.enqueue_package_notifications(v, 'package_received');
  return app.package_json(v) || jsonb_build_object('replayed', false, 'notifications_queued', v_jobs);
end $$;

-- Mesma lógica de 20261022000100, repassando entregador e porteiro.
create function public.receive_and_store(
  p_tenant uuid, p_idempotency_key text, p_unit uuid, p_tracking text, p_carrier text,
  p_recipient text, p_notes text, p_storage_location uuid, p_label_sha256 text default null,
  p_courier text default null, p_received_by_name text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; v_other uuid;
begin
  perform app.require(app.is_staff(p_tenant));
  if p_storage_location is null and exists(select 1 from public.storage_locations where tenant_id = p_tenant and active) then
    raise exception 'Escolha o local e confirme a guarda física antes de registrar.' using errcode = '22023';
  end if;
  if p_label_sha256 is not null and p_label_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Identificador da foto inválido.' using errcode = '22023';
  end if;
  select id into v_other from public.packages where tenant_id = p_tenant and label_sha256 = p_label_sha256
     and app.occupies_space(status) and idempotency_key <> p_idempotency_key;
  if found then raise exception 'Esta mesma foto já registrou uma encomenda que aguarda retirada.' using errcode = 'P0001'; end if;
  r := public.receive_package(p_tenant, p_idempotency_key, p_unit, p_tracking, p_carrier, p_recipient, p_notes, null, p_storage_location,
    p_courier, p_received_by_name);
  if not (r->>'replayed')::boolean then
    update public.packages set storage_confirmed_at = app.now(), label_sha256 = p_label_sha256
     where tenant_id = p_tenant and id = (r->>'id')::uuid;
    insert into public.package_events (tenant_id, package_id, type, actor_id, data)
    values (p_tenant, (r->>'id')::uuid, 'storage_confirmed', auth.uid(), jsonb_build_object('storage_location_id', p_storage_location));
  end if;
  return r || jsonb_build_object('storage_confirmed', true);
exception when unique_violation then
  raise exception 'Esta mesma foto já registrou uma encomenda que aguarda retirada.' using errcode = 'P0001';
end $$;

-- Conferência do pré-registro (totem antigo): entregador do totem vale se já veio; porteiro sempre.
drop function if exists public.confirm_preregistered(uuid, uuid, uuid, text, text, uuid);
create function public.confirm_preregistered(
  p_tenant uuid, p_package uuid, p_unit uuid, p_tracking text default null,
  p_carrier text default null, p_storage_location uuid default null,
  p_courier text default null, p_received_by_name text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_loc uuid; v_courier text; v_receiver text;
begin
  perform app.require(app.is_staff(p_tenant));
  perform app.require(app.can_operate(p_tenant), 'Assinatura inativa: novos recebimentos estão bloqueados.');
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found or v.status <> 'PRE_REGISTRADA' then raise exception 'Pré-registro não encontrado ou já conferido.' using errcode = 'P0001'; end if;
  perform app.require(exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active), 'Unidade inválida.');
  v_courier := app.courier_required(coalesce(nullif(btrim(p_courier), ''), v.courier_name));
  v_receiver := app.receiver_name(p_received_by_name);
  v_loc := app.pick_storage(p_tenant, coalesce(v.concierge_location_id, app.default_concierge(p_tenant)), p_storage_location);
  update public.packages set unit_id = p_unit,
    tracking_code = coalesce(nullif(upper(btrim(p_tracking)), ''), tracking_code),
    carrier = coalesce(nullif(btrim(p_carrier), ''), carrier),
    concierge_location_id = coalesce(concierge_location_id, app.default_concierge(p_tenant)),
    storage_location_id = v_loc, status = case when v_loc is null then 'RECEBIDA' else 'ARMAZENADA' end,
    received_by = auth.uid(), stored_at = case when v_loc is null then null else app.now() end, updated_at = now(),
    courier_name = v_courier, received_by_name = v_receiver
  where id = v.id returning * into v;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, 'preregistration_confirmed', auth.uid(), jsonb_build_object('courier_name', v_courier, 'received_by_name', v_receiver));
  perform app.enqueue_package_notifications(v, 'package_received');
  return app.package_json(v);
end $$;

revoke all on function public.receive_package(uuid, text, uuid, text, text, text, text, uuid, uuid, text, text),
  public.receive_and_store(uuid, text, uuid, text, text, text, text, uuid, text, text, text),
  public.confirm_preregistered(uuid, uuid, uuid, text, text, uuid, text, text) from public, anon;
grant execute on function public.receive_package(uuid, text, uuid, text, text, text, text, uuid, uuid, text, text),
  public.receive_and_store(uuid, text, uuid, text, text, text, text, uuid, text, text, text),
  public.confirm_preregistered(uuid, uuid, uuid, text, text, uuid, text, text) to authenticated, service_role;
revoke all on function app.receiver_name(text), app.courier_required(text) from public, anon, authenticated;

-- Totem pareado (entregador se identifica): entregador obrigatório; "recebido por" = o totem. Mesma assinatura e grants.
create or replace function public.device_receive(
  p_secret_hash text, p_idempotency_key text, p_unit uuid, p_carrier text, p_tracking text, p_courier text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.device_enrollments; v public.packages; v_conc uuid; v_loc uuid; v_replayed boolean := false;
  v_tracking text := nullif(upper(btrim(p_tracking)), '');
  v_carrier text := coalesce(nullif(btrim(p_carrier), ''), 'Outra');
  v_courier text := nullif(btrim(p_courier), '');
begin
  -- Serializa retries do mesmo dispositivo e impede revogação no meio da gravação.
  select * into d from public.device_enrollments where secret_hash = p_secret_hash and status = 'active' for update;
  if not found then raise exception 'Totem não pareado ou revogado.' using errcode = '42501'; end if;
  perform app.require(app.can_operate(d.tenant_id) and app.has_feature(d.tenant_id, 'totem'),
    'Totem indisponível. Procure a portaria.');
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9-]{8,80}$'
     or length(v_tracking) > 80 or length(v_carrier) > 40 or length(v_courier) > 80 then
    raise exception 'Dados de recebimento inválidos.' using errcode = '22023';
  end if;
  perform app.require(exists(select 1 from public.units where tenant_id = d.tenant_id and id = p_unit and active), 'Unidade inválida.');

  select * into v from public.packages where tenant_id = d.tenant_id and idempotency_key = p_idempotency_key;
  if found then
    if v.received_device_id is distinct from d.id or v.unit_id is distinct from p_unit
       or v.tracking_code is distinct from v_tracking or v.carrier is distinct from v_carrier
       or v.courier_name is distinct from v_courier then
      raise exception 'Identificador de operação já utilizado. Inicie um novo recebimento.' using errcode = '22023';
    end if;
    v_replayed := true;
  else
    v_courier := app.courier_required(v_courier);
    v_conc := coalesce(d.concierge_location_id, app.default_concierge(d.tenant_id));
    perform app.require(exists(select 1 from public.concierge_locations where tenant_id = d.tenant_id and id = v_conc and active), 'Portaria inválida.');
    -- Usa somente locais cadastrados; sem mapa de guarda o recebimento não é gravado.
    v_loc := app.pick_storage(d.tenant_id, v_conc, null);
    if v_loc is null then
      raise exception 'Cadastre um local de guarda ativo nesta portaria antes de receber encomendas.' using errcode = 'P0001';
    end if;
    begin
      insert into public.packages (tenant_id, unit_id, concierge_location_id, storage_location_id, status,
        tracking_code, carrier, registered_via, courier_name, idempotency_key, received_at, stored_at, received_device_id, received_by_name)
      values (d.tenant_id, p_unit, v_conc, v_loc, 'ARMAZENADA', v_tracking, v_carrier, 'totem', v_courier,
        p_idempotency_key, app.now(), app.now(), d.id, left('Totem: ' || d.name, 120))
      returning * into v;
    exception when unique_violation then
      -- Outro dispositivo/funcionário pode disputar a mesma chave ou rastreio.
      -- Não retorna o registro alheio nem transforma colisão em replay.
      raise exception 'Operação ou rastreio já registrado. Confira antes de receber novamente.' using errcode = 'P0001';
    end;
    insert into public.package_events (tenant_id, package_id, type, data)
    values (d.tenant_id, v.id, 'received', jsonb_build_object('device_id', d.id, 'storage_location_id', v_loc, 'automatic', true));
    insert into public.audit_logs (tenant_id, action, target_type, target_id, data)
    values (d.tenant_id, 'device.package_received', 'package', v.id::text, jsonb_build_object('device_id', d.id));
    perform app.enqueue_package_notifications(v, 'package_received');
  end if;
  return jsonb_build_object('ok', true, 'replayed', v_replayed,
    'storage_code', (select code from public.storage_locations where id = v.storage_location_id),
    'storage_rack', (select rack from public.storage_locations where id = v.storage_location_id),
    'storage_shelf', (select shelf from public.storage_locations where id = v.storage_location_id),
    'concierge_name', (select name from public.concierge_locations where id = v.concierge_location_id));
end $$;

-- Lista da portaria: + porteiro e unidade formatada (colunas novas no fim; mesma assinatura de entrada).
drop function if exists public.list_packages(uuid, text, date, date, text, int, timestamptz, uuid);
create function public.list_packages(
  p_tenant uuid, p_status text default null, p_from date default null, p_to date default null,
  p_search text default null, p_limit int default 50,
  p_cursor_at timestamptz default null, p_cursor_id uuid default null
) returns table (
  id uuid, status text, tracking_code text, carrier text, recipient_name text, notes text, registered_via text,
  unit_id uuid, unit_block text, unit_label text, storage_location_id uuid, storage_code text,
  received_at timestamptz, stored_at timestamptz, notified_at timestamptz, picked_up_at timestamptz,
  picked_up_by_name text, pickup_method text, resolution_reason text, courier_name text, received_by_name text
)
language sql stable set search_path = '' as $$
  with tz as (select timezone from public.tenants where id = p_tenant)
  select p.id, p.status, p.tracking_code, p.carrier, p.recipient_name, p.notes, p.registered_via,
         p.unit_id, u.block, u.label, p.storage_location_id, sl.code,
         p.received_at, p.stored_at, p.notified_at, p.picked_up_at, p.picked_up_by_name, p.pickup_method,
         p.resolution_reason, p.courier_name, p.received_by_name
  from public.packages p
  cross join tz
  left join public.units u on u.id = p.unit_id
  left join public.storage_locations sl on sl.id = p.storage_location_id
  where p.tenant_id = p_tenant
    and (p_status is null
      or (p_status = 'PENDENTES' and p.status in ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA'))
      or p.status = p_status)
    and (p_from is null or p.received_at >= (p_from::timestamp at time zone tz.timezone))
    and (p_to is null or p.received_at < ((p_to + 1)::timestamp at time zone tz.timezone))
    and (p_search is null or p_search = '' or p.tracking_code ilike '%' || p_search || '%'
         or p.recipient_name ilike '%' || p_search || '%' or u.label ilike p_search || '%'
         or (coalesce(u.block, '') || ' ' || u.label) ilike '%' || p_search || '%')
    and (p_cursor_at is null or (p.received_at, p.id) < (p_cursor_at, p_cursor_id))
  order by p.received_at desc, p.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
revoke all on function public.list_packages(uuid, text, date, date, text, int, timestamptz, uuid) from public, anon;
grant execute on function public.list_packages(uuid, text, date, date, text, int, timestamptz, uuid) to authenticated;

-- App do morador: quem entregou na portaria e quem recebeu. Mesma assinatura.
create or replace function app.resident_package_json(p public.packages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'ref', app.package_ref(p.id), 'status', p.status, 'carrier', p.carrier, 'tracking_code', p.tracking_code,
    'recipient_name', p.recipient_name, 'unit_id', p.unit_id, 'unit_block', u.block, 'unit_label', u.label,
    'received_at', p.received_at, 'stored_at', p.stored_at, 'picked_up_at', p.picked_up_at,
    'picked_up_by_name', p.picked_up_by_name, 'resolved_at', p.resolved_at, 'concierge_name', c.name,
    'courier_name', p.courier_name, 'received_by_name', p.received_by_name,
    'receipt', (select jsonb_build_object('protocol', r.protocol, 'pdf_status', r.pdf_status)
                  from public.receipts r where r.tenant_id = p.tenant_id and r.package_id = p.id
                   and app.can_see_receipt(p.tenant_id, p.unit_id, r.issued_at)))
  from (select 1) x
  left join public.units u on u.id = p.unit_id
  left join public.concierge_locations c on c.id = p.concierge_location_id
$$;

-- Comprovante: snapshot imutável ganha entregador, porteiro do recebimento e unidade formatada.
create or replace function app.receipt_snapshot_reception() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select new.snapshot || jsonb_strip_nulls(jsonb_build_object('courier_name', p.courier_name,
      'received_by_name', coalesce(p.received_by_name, (select full_name from public.profiles where id = p.received_by)),
      'unit_text', app.unit_display(p.tenant_id, u.block, u.label)))
    into new.snapshot
    from public.packages p left join public.units u on u.id = p.unit_id where p.id = new.package_id;
  return new;
end $$;
drop trigger if exists receipts_snapshot_reception on public.receipts;
create trigger receipts_snapshot_reception before insert on public.receipts
  for each row execute function app.receipt_snapshot_reception();
revoke all on function app.receipt_snapshot_reception() from public, anon, authenticated;

-- Relatório: porteiro gravado no recebimento (antigos: nome do perfil) e entregador. Mesma assinatura e grants.
create or replace function public.report_packages(p_tenant uuid, p_filters jsonb default '{}'::jsonb, p_limit int default 100,
  p_cursor_at timestamptz default null, p_cursor_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb; tz text; v jsonb;
begin
  perform app.require(app.is_admin(p_tenant), 'Somente a administração do condomínio acessa relatórios.');
  f := app.report_package_filters(p_filters);
  select timezone into tz from public.tenants where id = p_tenant;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc, x.id desc), '[]'::jsonb) into v from (
    select p.id, p.status, p.carrier, p.tracking_code, p.recipient_name, p.registered_via, p.pickup_method, p.resolution_reason,
           p.received_at, p.picked_up_at, p.picked_up_by_name, u.block unit_block, u.label unit_label,
           (select r.protocol from public.receipts r where r.tenant_id = p.tenant_id and r.package_id = p.id) protocol,
           coalesce(p.received_by_name, rp.full_name, 'Equipe') received_by_name, coalesce(dp.full_name, case when p.delivered_by is null then null else 'Equipe' end) delivered_by_name,
           p.courier_name,
           round(extract(epoch from (coalesce(p.picked_up_at, app.now()) - p.received_at)) / 3600.0, 1) hours_waiting
      from public.packages p
      left join public.units u on u.id = p.unit_id
      left join public.profiles rp on rp.id = p.received_by
      left join public.profiles dp on dp.id = p.delivered_by
     where p.tenant_id = p_tenant
       and (nullif(f->>'block', '') is null or upper(btrim(coalesce(u.block, ''))) = upper(btrim(f->>'block')))
       and (nullif(f->>'unit', '') is null or p.unit_id = (f->>'unit')::uuid)
       and (nullif(f->>'carrier', '') is null or p.carrier = f->>'carrier')
       and (nullif(f->>'status', '') is null
            or (f->>'status' = 'PENDENTES' and p.status in ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA'))
            or p.status = f->>'status')
       and (nullif(f->>'received_from', '') is null or p.received_at >= ((f->>'received_from')::date::timestamp at time zone tz))
       and (nullif(f->>'received_to', '') is null or p.received_at < (((f->>'received_to')::date + 1)::timestamp at time zone tz))
       and (nullif(f->>'picked_from', '') is null or p.picked_up_at >= ((f->>'picked_from')::date::timestamp at time zone tz))
       and (nullif(f->>'picked_to', '') is null or p.picked_up_at < (((f->>'picked_to')::date + 1)::timestamp at time zone tz))
       and (nullif(f->>'operator', '') is null or p.received_by = (f->>'operator')::uuid or p.delivered_by = (f->>'operator')::uuid)
       and (nullif(f->>'recipient', '') is null or p.recipient_name ilike '%' || replace(replace(f->>'recipient', '%', '\%'), '_', '\_') || '%')
       and (nullif(f->>'registered_via', '') is null or p.registered_via = f->>'registered_via')
       and (nullif(f->>'pickup_method', '') is null or p.pickup_method = f->>'pickup_method')
       and (nullif(f->>'search', '') is null or p.tracking_code ilike '%' || replace(replace(f->>'search', '%', '\%'), '_', '\_') || '%'
            or exists (select 1 from public.receipts r where r.tenant_id = p.tenant_id and r.package_id = p.id and r.protocol ilike '%' || replace(replace(f->>'search', '%', '\%'), '_', '\_') || '%'))
       and (p_cursor_at is null or (p.received_at, p.id) < (p_cursor_at, p_cursor_id))
     order by p.received_at desc, p.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 1000)) x;
  return v;
end $$;

