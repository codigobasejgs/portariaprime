-- Relatórios gerenciais com filtros no servidor (encomendas e moradores/unidades).
-- Só administração do condomínio (papel admin). Tudo filtrado pelo tenant informado e autorizado;
-- filtros vêm como jsonb validado (tipos e tamanhos), sem SQL dinâmico. Paginação por cursor.

-- Índice para filtro/ordenação por entrega (picked_up_at já tem índice parcial); bloco via units.
create index if not exists packages_tenant_carrier_idx on public.packages (tenant_id, carrier, received_at desc);

-- Valida e normaliza os filtros de encomendas. Erro claro para tipo inválido.
create or replace function app.report_package_filters(f jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; allowed text[] := array['block', 'unit', 'carrier', 'status', 'received_from', 'received_to', 'picked_from', 'picked_to',
  'operator', 'recipient', 'search', 'registered_via', 'pickup_method'];
begin
  if f is null then return '{}'::jsonb; end if;
  if jsonb_typeof(f) <> 'object' then raise exception 'Filtros inválidos.' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(f) loop
    if not k = any (allowed) then raise exception 'Filtro desconhecido: %.', k using errcode = '22023'; end if;
    if jsonb_typeof(f->k) not in ('string', 'null') or length(coalesce(f->>k, '')) > 80 then
      raise exception 'Filtro inválido: %.', k using errcode = '22023';
    end if;
  end loop;
  perform (f->>'unit')::uuid, (f->>'operator')::uuid,
    (f->>'received_from')::date, (f->>'received_to')::date, (f->>'picked_from')::date, (f->>'picked_to')::date;
  if nullif(f->>'status', '') is not null and f->>'status' not in ('PENDENTES', 'PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA', 'RETIRADA', 'CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA') then
    raise exception 'Situação inválida.' using errcode = '22023';
  end if;
  return f;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  raise exception 'Filtro com valor inválido (data ou identificador).' using errcode = '22023';
end $$;

-- Encomendas do relatório. p_cursor: (received_at, id) da última linha da página anterior.
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
           coalesce(rp.full_name, 'Equipe') received_by_name, coalesce(dp.full_name, case when p.delivered_by is null then null else 'Equipe' end) delivered_by_name,
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

-- Totais do mesmo recorte (para o cabeçalho e o PDF): bate exatamente com as linhas.
create or replace function public.report_packages_summary(p_tenant uuid, p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb; tz text; v jsonb;
begin
  perform app.require(app.is_admin(p_tenant), 'Somente a administração do condomínio acessa relatórios.');
  f := app.report_package_filters(p_filters);
  select timezone into tz from public.tenants where id = p_tenant;
  with base as (
    select p.* , u.block from public.packages p left join public.units u on u.id = p.unit_id
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
            or exists (select 1 from public.receipts r where r.tenant_id = p.tenant_id and r.package_id = p.id and r.protocol ilike '%' || replace(replace(f->>'search', '%', '\%'), '_', '\_') || '%')))
  select jsonb_build_object(
    'total', (select count(*) from base),
    'pending', (select count(*) from base where status in ('PRE_REGISTRADA', 'RECEBIDA', 'ARMAZENADA')),
    'picked', (select count(*) from base where status = 'RETIRADA'),
    'exceptions', (select count(*) from base where status in ('CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA')),
    'avg_pickup_h', (select round(avg(extract(epoch from (picked_up_at - received_at)) / 3600.0)::numeric, 1) from base where picked_up_at is not null),
    'by_carrier', coalesce((select jsonb_agg(jsonb_build_object('carrier', carrier, 'n', n) order by n desc, carrier) from (select carrier, count(*) n from base group by carrier) c), '[]'::jsonb),
    'by_block', coalesce((select jsonb_agg(jsonb_build_object('block', coalesce(block, 'Sem bloco'), 'n', n) order by n desc) from (select block, count(*) n from base group by block) b), '[]'::jsonb),
    'by_month', coalesce((select jsonb_agg(jsonb_build_object('month', m, 'n', n) order by m) from (select to_char(received_at at time zone tz, 'YYYY-MM') m, count(*) n from base group by 1) mm), '[]'::jsonb),
    'top_units', coalesce((select jsonb_agg(jsonb_build_object('unit_id', unit_id, 'unit', concat_ws(' ', block, label), 'n', n) order by n desc, label) from (
        select b.unit_id, b.block, u.label, count(*) n from base b join public.units u on u.id = b.unit_id group by b.unit_id, b.block, u.label order by count(*) desc, u.label limit 10) t), '[]'::jsonb))
  into v;
  return v;
end $$;

-- Opções dos filtros (só do próprio condomínio): blocos, unidades, transportadoras usadas, equipe.
create or replace function public.report_filter_options(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_admin(p_tenant), 'Somente a administração do condomínio acessa relatórios.');
  return jsonb_build_object(
    'blocks', coalesce((select jsonb_agg(b order by b) from (select distinct btrim(block) b from public.units where tenant_id = p_tenant and nullif(btrim(block), '') is not null) x), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'block', block, 'label', label) order by block nulls first, length(label), label) from public.units where tenant_id = p_tenant), '[]'::jsonb),
    'carriers', coalesce((select jsonb_agg(c order by c) from (select distinct carrier c from public.packages where tenant_id = p_tenant) x), '[]'::jsonb),
    'operators', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', coalesce(pr.full_name, 'Sem nome'), 'role', m.role) order by pr.full_name)
      from public.tenant_memberships m left join public.profiles pr on pr.id = m.user_id where m.tenant_id = p_tenant and m.role in ('admin', 'porteiro')), '[]'::jsonb));
end $$;

-- Moradores por unidade: inclui unidades sem morador; status do vínculo ou do pedido mais recente.
create or replace function public.report_residents(p_tenant uuid, p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); k text;
begin
  perform app.require(app.is_admin(p_tenant) and (app.has_perm(p_tenant, 'approve') or app.has_perm(p_tenant, 'team')),
    'Somente quem aprova moradores ou gerencia a equipe acessa este relatório.');
  if jsonb_typeof(f) <> 'object' then raise exception 'Filtros inválidos.' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(f) loop
    if k not in ('block', 'unit', 'status', 'occupancy', 'search') or length(coalesce(f->>k, '')) > 80 then raise exception 'Filtro inválido: %.', k using errcode = '22023'; end if;
  end loop;
  if nullif(f->>'status', '') is not null and f->>'status' not in ('active', 'pending', 'rejected', 'revoked') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if nullif(f->>'occupancy', '') is not null and f->>'occupancy' not in ('with', 'without') then raise exception 'Ocupação inválida.' using errcode = '22023'; end if;
  begin perform (f->>'unit')::uuid; exception when invalid_text_representation then raise exception 'Unidade inválida.' using errcode = '22023'; end;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.block nulls first, length(x.label), x.label, x.full_name) from (
    with people as (
      -- Moradores com vínculo à unidade (ativos ou revogados).
      select um.unit_id, um.user_id, case when um.status = 'active' and m.status = 'active' then 'active' else 'revoked' end status,
             pr.full_name, au.email::text email, rc.phone, um.created_at since
        from public.unit_memberships um
        join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador'
        join auth.users au on au.id = um.user_id
        left join public.profiles pr on pr.id = um.user_id
        left join lateral (select phone from public.resident_contacts c where c.unit_id = um.unit_id and c.user_id = um.user_id limit 1) rc on true
       where um.tenant_id = p_tenant
      union all
      -- Pedidos pendentes/recusados ainda sem vínculo (unidade encontrada ou não).
      select r.unit_id, r.user_id, case r.status when 'pending' then 'pending' else 'rejected' end, r.full_name, au.email::text, r.phone, r.created_at
        from public.access_requests r join auth.users au on au.id = r.user_id
       where r.tenant_id = p_tenant and r.status in ('pending', 'rejected')
         and not exists (select 1 from public.unit_memberships um where um.tenant_id = r.tenant_id and um.user_id = r.user_id and um.status = 'active')
         and r.created_at = (select max(r2.created_at) from public.access_requests r2 where r2.tenant_id = r.tenant_id and r2.user_id = r.user_id)
    )
    select u.id unit_id, u.block, u.label, u.active unit_active, p.user_id, p.status, p.full_name, p.email, p.phone, p.since,
           (select count(*) from people p2 where p2.unit_id = u.id and p2.status = 'active') active_residents
      from public.units u left join people p on p.unit_id = u.id
     where u.tenant_id = p_tenant
       and (nullif(f->>'block', '') is null or upper(btrim(coalesce(u.block, ''))) = upper(btrim(f->>'block')))
       and (nullif(f->>'unit', '') is null or u.id = (f->>'unit')::uuid)
       and (nullif(f->>'status', '') is null or p.status = f->>'status')
       and (nullif(f->>'occupancy', '') is null
            or (f->>'occupancy' = 'with' and exists (select 1 from people p3 where p3.unit_id = u.id and p3.status = 'active'))
            or (f->>'occupancy' = 'without' and not exists (select 1 from people p3 where p3.unit_id = u.id and p3.status = 'active')))
       and (nullif(f->>'search', '') is null or concat_ws(' ', p.full_name, p.email, u.block, u.label) ilike '%' || replace(replace(f->>'search', '%', '\%'), '_', '\_') || '%')
     limit 10000) x), '[]'::jsonb);
end $$;

-- Gerador de unidades: blocos × intervalo por andar (ex.: andares 1–10, 4 aptos por andar → 101..104 … 1001..1004)
-- ou intervalo simples (1–40). Prévia (dry run) e gravação tudo-ou-nada pelo import_units (mesmas regras e limite do plano).
create or replace function public.units_generate(p_tenant uuid, p_spec jsonb, p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare blocks text[]; b text; rows jsonb := '[]'::jsonb; mode text := coalesce(p_spec->>'mode', 'floors');
  f1 int; f2 int; per int; a1 int; a2 int; i int; j int; pfx text := coalesce(p_spec->>'prefix', ''); n int := 0;
begin
  perform app.require(app.is_admin(p_tenant));
  if jsonb_typeof(p_spec->'blocks') <> 'array' then raise exception 'Informe os blocos (ou um único vazio para sem bloco).' using errcode = '22023'; end if;
  select array_agg(nullif(btrim(x), '')) into blocks from jsonb_array_elements_text(p_spec->'blocks') x;
  if coalesce(array_length(blocks, 1), 0) not between 1 and 60 then raise exception 'Use de 1 a 60 blocos.' using errcode = '22023'; end if;
  if length(pfx) > 10 then raise exception 'Prefixo longo demais.' using errcode = '22023'; end if;
  if mode = 'floors' then
    f1 := (p_spec->>'floor_from')::int; f2 := (p_spec->>'floor_to')::int; per := (p_spec->>'per_floor')::int;
    if f1 is null or f2 is null or per is null or f1 < 0 or f2 < f1 or f2 > 200 or per not between 1 and 99 then
      raise exception 'Andares de 0 a 200 e de 1 a 99 apartamentos por andar.' using errcode = '22023';
    end if;
  elsif mode = 'range' then
    a1 := (p_spec->>'from')::int; a2 := (p_spec->>'to')::int;
    if a1 is null or a2 is null or a1 < 0 or a2 < a1 or a2 - a1 > 1999 then raise exception 'Intervalo inválido (até 2000 unidades).' using errcode = '22023'; end if;
  else raise exception 'Modo inválido.' using errcode = '22023';
  end if;
  foreach b in array blocks loop
    if mode = 'floors' then
      for i in f1..f2 loop for j in 1..per loop
        -- Andar × 100 + posição: 1º andar 101..104, 10º andar 1001..1004 (térreo: 1..4).
        rows := rows || jsonb_build_object('block', b, 'label', pfx || (i * 100 + j)::text);
      end loop; end loop;
    else
      for i in a1..a2 loop rows := rows || jsonb_build_object('block', b, 'label', pfx || i::text); end loop;
    end if;
  end loop;
  n := jsonb_array_length(rows);
  if n > 2000 then raise exception 'Isso geraria % unidades; o máximo por vez é 2000.', n using errcode = '22023'; end if;
  return public.import_units(p_tenant, rows, p_dry_run) || jsonb_build_object('preview', (select jsonb_agg(e) from (select e from jsonb_array_elements(rows) e limit 60) z), 'count', n);
exception when invalid_text_representation then raise exception 'Números inválidos.' using errcode = '22023';
end $$;

revoke all on function app.report_package_filters(jsonb) from public, anon, authenticated;
revoke all on function public.report_packages(uuid, jsonb, int, timestamptz, uuid), public.report_packages_summary(uuid, jsonb),
  public.report_filter_options(uuid), public.report_residents(uuid, jsonb), public.units_generate(uuid, jsonb, boolean) from public, anon;
grant execute on function public.report_packages(uuid, jsonb, int, timestamptz, uuid), public.report_packages_summary(uuid, jsonb),
  public.report_filter_options(uuid), public.report_residents(uuid, jsonb), public.units_generate(uuid, jsonb, boolean) to authenticated;
