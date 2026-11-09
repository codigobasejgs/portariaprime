-- Cadastro de entregadores a partir da CNH (OCR revisado pelo porteiro). Aditiva: receive_and_store (11 parâmetros) e
-- confirm_preregistered (8) não mudam; courier_name continua obrigatório e gravado como antes. O vínculo
-- encomenda→entregador é feito depois, por package_set_courier (opcional; sem ele tudo segue só com o nome).
-- Totem (device_receive) continua só com o nome digitado: não há leitura de CNH sem operador humano revisando.
--
-- Privacidade (LGPD): tabela sem acesso direto (só RPC). Equipe vê nome e transportadora; documento sai mascarado.
--   - Busca (porteiro e síndico): por nome ou pelos 3 PRIMEIROS dígitos do CPF; o resultado mostra só esses 3
--     (mostrar o miolo junto deixaria deduzir o CPF inteiro pelos dígitos verificadores).
--   - Lista do síndico: ***.456.789-**. CPF/CNH completos só via courier_reveal_document (síndico com 'approve' ou
--     'team', justificativa obrigatória, audit_logs com o motivo, nunca com o dado).
--   - Foto da CNH: só com opt-in, enviada pelo servidor; nenhum papel lê pelo Storage (ver can_read_package_file).

create table if not exists public.couriers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null check (length(btrim(full_name)) between 2 and 80),
  document_number text check (document_number is null or document_number ~ '^[0-9]{11}$'),
  cnh_number text check (cnh_number is null or cnh_number ~ '^[0-9]{11}$'),
  cnh_category text check (cnh_category is null or cnh_category in ('A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE')),
  carrier_default text check (carrier_default is null or length(carrier_default) <= 40),
  cnh_photo_path text check (cnh_photo_path is null or length(cnh_photo_path) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_visit_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  unique (tenant_id, id)
);
create unique index if not exists couriers_tenant_document_uq on public.couriers (tenant_id, document_number) where document_number is not null;
create unique index if not exists couriers_tenant_cnh_uq on public.couriers (tenant_id, cnh_number) where cnh_number is not null;
create index if not exists couriers_tenant_visit_idx on public.couriers (tenant_id, last_visit_at desc nulls last);

alter table public.couriers enable row level security;
revoke all on public.couriers from public, anon, authenticated;
grant all on public.couriers to service_role;

alter table public.packages add column if not exists courier_id uuid;
do $$ begin
  alter table public.packages add constraint packages_courier_fk foreign key (tenant_id, courier_id) references public.couriers (tenant_id, id);
exception when duplicate_object then null;
end $$;
create index if not exists packages_tenant_courier_id_idx on public.packages (tenant_id, courier_id, received_at desc, id desc) where courier_id is not null;

-- CPF: 11 dígitos, não repetidos, dígitos verificadores (módulo 11).
create or replace function app.cpf_valid(p text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare s int; r int; i int;
begin
  if p is null or p !~ '^[0-9]{11}$' or p = repeat(left(p, 1), 11) then return false; end if;
  for k in 10..11 loop
    s := 0;
    for i in 1..k - 1 loop s := s + substr(p, i, 1)::int * (k + 1 - i); end loop;
    r := (s * 10) % 11;
    if r = 10 then r := 0; end if;
    if r <> substr(p, k, 1)::int then return false; end if;
  end loop;
  return true;
end $$;

-- CNH: só formato (11 dígitos, não repetidos). O DV oficial tem variantes divulgadas; validar errado recusaria CNH real.
create or replace function app.cnh_valid(p text) returns boolean
language sql immutable set search_path = '' as $$
  select p ~ '^[0-9]{11}$' and p <> repeat(left(p, 1), 11)
$$;

create or replace function app.mask_cpf(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '^[0-9]{11}$' then '***.' || substr(p, 4, 3) || '.' || substr(p, 7, 3) || '-**' end
$$;

-- Busca: só os 3 primeiros dígitos (o que o porteiro digitou).
create or replace function app.cpf_prefix(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '^[0-9]{11}$' then left(p, 3) || '.***.***-**' end
$$;

revoke all on function app.cpf_valid(text), app.cnh_valid(text), app.mask_cpf(text), app.cpf_prefix(text) from public, anon, authenticated;

-- Foto da CNH (caminho <tenant>/couriers/...): ninguém lê pelo Storage com a sessão; o restante não muda.
create or replace function app.can_read_package_file(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select split_part(p_name, '/', 2) not in ('couriers', 'staff-face') and (app.is_staff(app.path_tenant(p_name)) or exists (
    select 1 from public.packages p
    where p.tenant_id = app.path_tenant(p_name) and p.id = app.path_package(p_name)
      and p.status <> 'PRE_REGISTRADA' and app.is_unit_member(p.tenant_id, p.unit_id)))
$$;

-- Cria ou atualiza (dedupe por CPF ou CNH no condomínio) depois que o porteiro revisou a leitura.
create or replace function public.courier_upsert_from_ocr(p_tenant uuid, p_full_name text, p_cpf text, p_cnh text,
  p_category text default null, p_carrier text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_cpf text := nullif(regexp_replace(coalesce(p_cpf, ''), '[^0-9]', '', 'g'), '');
  v_cnh text := nullif(regexp_replace(coalesce(p_cnh, ''), '[^0-9]', '', 'g'), '');
  v_cat text := upper(btrim(coalesce(p_category, '')));
  v_carrier text := nullif(left(btrim(coalesce(p_carrier, '')), 40), '');
  c public.couriers; o public.couriers; v_new boolean := false;
begin
  perform app.require(app.is_staff(p_tenant));
  perform app.require(app.can_operate(p_tenant), 'Assinatura inativa: novos recebimentos estão bloqueados.');
  if length(v_name) not between 2 and 80 then raise exception 'Nome do entregador: 2 a 80 caracteres.' using errcode = '22023'; end if;
  if v_cpf is not null and not app.cpf_valid(v_cpf) then raise exception 'CPF inválido. Confira os números.' using errcode = '22023'; end if;
  if v_cnh is not null and not app.cnh_valid(v_cnh) then raise exception 'Número da CNH inválido (11 dígitos).' using errcode = '22023'; end if;
  if v_cpf is null and v_cnh is null then raise exception 'Informe o CPF ou o número da CNH.' using errcode = '22023'; end if;
  if v_cat not in ('A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE') then v_cat := null; end if;

  -- Dois porteiros confirmando o mesmo entregador ao mesmo tempo: um espera o outro (sem erro de duplicidade).
  perform pg_advisory_xact_lock(hashtextextended('courier:' || p_tenant::text, 0));
  select * into c from public.couriers where tenant_id = p_tenant and document_number = v_cpf;
  select * into o from public.couriers where tenant_id = p_tenant and cnh_number = v_cnh;
  if c.id is not null and o.id is not null and c.id <> o.id then
    raise exception 'CPF e CNH pertencem a entregadores diferentes já cadastrados. Confira a leitura.' using errcode = '22023';
  end if;
  if c.id is null then c := o; end if;
  if c.id is not null and v_cpf is not null and c.document_number is not null and c.document_number <> v_cpf then
    raise exception 'O CPF lido não confere com o cadastro desta CNH. Confira a leitura.' using errcode = '22023';
  end if;

  if c.id is null then
    insert into public.couriers (tenant_id, full_name, document_number, cnh_number, cnh_category, carrier_default, last_visit_at, created_by)
    values (p_tenant, v_name, v_cpf, v_cnh, v_cat, v_carrier, app.now(), auth.uid()) returning * into c;
    v_new := true;
  else
    update public.couriers set full_name = v_name, document_number = coalesce(document_number, v_cpf),
      cnh_number = coalesce(v_cnh, cnh_number), cnh_category = coalesce(v_cat, cnh_category),
      carrier_default = coalesce(v_carrier, carrier_default), last_visit_at = app.now(), updated_at = app.now()
     where id = c.id returning * into c;
  end if;
  perform app.audit(p_tenant, case when v_new then 'courier.create' else 'courier.update' end, 'courier', c.id::text,
    jsonb_build_object('source', 'ocr_reviewed', 'has_cpf', c.document_number is not null, 'has_cnh', c.cnh_number is not null));
  return jsonb_build_object('id', c.id, 'full_name', c.full_name, 'carrier_default', c.carrier_default, 'cnh_category', c.cnh_category,
    'document_hint', app.cpf_prefix(c.document_number), 'created', v_new);
end $$;

-- Autocomplete da portaria: nome (sem acento) ou 3 primeiros dígitos do CPF. Dígitos além do 3º são ignorados
-- (busca não serve de oráculo para confirmar um CPF inteiro).
create or replace function public.courier_search(p_tenant uuid, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_q text := btrim(coalesce(p_query, '')); v_d text; v_n text;
begin
  perform app.require(app.is_staff(p_tenant));
  v_d := regexp_replace(v_q, '[^0-9]', '', 'g');
  if v_q ~ '^[0-9.\s-]+$' and length(v_d) >= 3 then
    return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'full_name', c.full_name, 'carrier_default', c.carrier_default,
        'document_hint', app.cpf_prefix(c.document_number)) order by c.last_visit_at desc nulls last, c.full_name)
      from (select * from public.couriers where tenant_id = p_tenant and document_number like left(v_d, 3) || '%'
             order by last_visit_at desc nulls last, full_name limit 8) c), '[]'::jsonb);
  end if;
  v_n := app.norm_text(v_q);
  if v_n is null or length(v_n) < 2 then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'full_name', c.full_name, 'carrier_default', c.carrier_default,
      'document_hint', app.cpf_prefix(c.document_number)) order by c.last_visit_at desc nulls last, c.full_name)
    from (select * from public.couriers where tenant_id = p_tenant
            and not exists (select 1 from unnest(string_to_array(v_n, ' ')) w where strpos(app.norm_text(full_name), w) = 0)
           order by last_visit_at desc nulls last, full_name limit 8) c), '[]'::jsonb);
end $$;

-- Documento completo: síndico com 'approve' ou 'team', com justificativa; auditoria guarda o motivo, nunca o dado.
create or replace function public.courier_reveal_document(p_tenant uuid, p_courier uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.couriers;
begin
  perform app.require(app.is_admin(p_tenant) and (app.has_perm(p_tenant, 'approve') or app.has_perm(p_tenant, 'team')),
    'Somente quem aprova moradores ou gerencia a equipe vê o documento completo.');
  if p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then
    raise exception 'Justificativa obrigatória (10 a 1000 caracteres).' using errcode = '22023';
  end if;
  select * into c from public.couriers where tenant_id = p_tenant and id = p_courier;
  if not found then raise exception 'Entregador não encontrado.' using errcode = 'P0002'; end if;
  perform app.audit(p_tenant, 'courier.document_reveal', 'courier', c.id::text,
    jsonb_build_object('reason', btrim(p_reason), 'fields', jsonb_build_array('document_number', 'cnh_number')));
  return jsonb_build_object('id', c.id, 'full_name', c.full_name, 'cnh_category', c.cnh_category,
    'document_number', case when c.document_number is not null then
      substr(c.document_number, 1, 3) || '.' || substr(c.document_number, 4, 3) || '.' || substr(c.document_number, 7, 3) || '-' || substr(c.document_number, 10, 2) end,
    'cnh_number', c.cnh_number);
end $$;

-- Painel do síndico.
create or replace function public.couriers_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_admin(p_tenant), 'Somente a administração do condomínio.');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.last_delivery desc nulls last, x.full_name) from (
    select c.id, c.full_name, app.mask_cpf(c.document_number) document_masked, c.cnh_number is not null has_cnh,
           c.cnh_category, c.cnh_photo_path is not null has_photo, c.created_at, c.last_visit_at,
           coalesce((select jsonb_agg(distinct v order by v) from (
              select p.carrier v from public.packages p where p.tenant_id = c.tenant_id and p.courier_id = c.id
              union select c.carrier_default) s where v is not null), '[]'::jsonb) carriers,
           (select count(*) from public.packages p where p.tenant_id = c.tenant_id and p.courier_id = c.id)::int deliveries,
           (select max(p.received_at) from public.packages p where p.tenant_id = c.tenant_id and p.courier_id = c.id) last_delivery
      from public.couriers c where c.tenant_id = p_tenant
      order by c.last_visit_at desc nulls last limit 500) x), '[]'::jsonb);
end $$;

create or replace function public.courier_deliveries(p_tenant uuid, p_courier uuid, p_limit int default 100,
  p_cursor_at timestamptz default null, p_cursor_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_admin(p_tenant), 'Somente a administração do condomínio.');
  if not exists (select 1 from public.couriers where tenant_id = p_tenant and id = p_courier) then
    raise exception 'Entregador não encontrado.' using errcode = 'P0002';
  end if;
  if (p_cursor_at is null) <> (p_cursor_id is null) then raise exception 'Cursor inválido.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.received_at desc, x.package_id desc) from (
    select p.id package_id, p.received_at, p.carrier, p.status, p.courier_name, p.received_by_name, u.block unit_block, u.label unit_label
      from public.packages p left join public.units u on u.tenant_id = p.tenant_id and u.id = p.unit_id
     where p.tenant_id = p_tenant and p.courier_id = p_courier
       and (p_cursor_at is null or (p.received_at, p.id) < (p_cursor_at, p_cursor_id))
     order by p.received_at desc, p.id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb);
end $$;

-- Vínculo inicial apenas enquanto aguardando, com nome igual ao snapshot. Nunca troca nem altera courier_name/comprovante.
create or replace function public.package_set_courier(p_tenant uuid, p_package uuid, p_courier uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.packages; c public.couriers;
begin
  perform app.require(app.is_staff(p_tenant));
  select * into p from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda inválida.' using errcode = '22023'; end if;
  select * into c from public.couriers where tenant_id = p_tenant and id = p_courier;
  if not found then raise exception 'Entregador inválido.' using errcode = '22023'; end if;
  if p.courier_id = p_courier then return jsonb_build_object('package_id', p.id, 'courier_id', p_courier, 'replayed', true); end if;
  perform app.require(p.courier_id is null, 'Encomenda já vinculada a outro entregador.');
  perform app.require(p.status in ('RECEBIDA', 'ARMAZENADA') and p.picked_up_at is null and p.resolved_at is null
    and not exists (select 1 from public.receipts r where r.tenant_id = p_tenant and r.package_id = p.id),
    'Histórico encerrado: vínculo do entregador não pode ser alterado.');
  perform app.require(app.norm_text(p.courier_name) in (app.norm_text(c.full_name),
    app.norm_text(left(c.full_name || ' - ' || coalesce(c.carrier_default, ''), 80))),
    'Nome do entregador não confere com o snapshot do recebimento.');
  update public.packages set courier_id = p_courier where id = p.id;
  update public.couriers set last_visit_at = greatest(coalesce(last_visit_at, p.received_at), p.received_at)
   where tenant_id = p_tenant and id = p_courier;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, p.id, 'courier_linked', auth.uid(), jsonb_build_object('courier_id', p_courier, 'previous', p.courier_id));
  return jsonb_build_object('package_id', p.id, 'courier_id', p_courier, 'replayed', false);
end $$;

-- Autorização pela sessão ANTES de qualquer acesso service-role ao Storage.
create or replace function public.courier_photo_authorize(p_tenant uuid, p_courier uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.couriers;
begin
  perform app.require(app.is_staff(p_tenant));
  select * into c from public.couriers where tenant_id = p_tenant and id = p_courier;
  if not found then raise exception 'Entregador inválido.' using errcode = '22023'; end if;
  return jsonb_build_object('actor_id', auth.uid(), 'has_photo', c.cnh_photo_path is not null);
end $$;

-- Interna: objeto existente, autor novamente autorizado, ponteiro imutável. Retry não apaga a foto atual.
-- ponytail: primeira foto apenas; substituição futura exige versionamento e retenção explícitos.
create or replace function public.courier_attach_photo(p_tenant uuid, p_courier uuid, p_path text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.couriers;
begin
  perform app.require(exists (select 1 from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant and m.user_id = p_actor and m.status = 'active' and m.role in ('admin','porteiro') and t.status = 'active'));
  select * into c from public.couriers where tenant_id = p_tenant and id = p_courier for update;
  if not found then raise exception 'Entregador inválido.' using errcode = '22023'; end if;
  if p_path is null or p_path !~ ('^' || p_tenant::text || '/couriers/' || p_courier::text || '/cnh-[A-Za-z0-9]{16,64}\.jpg$') then
    raise exception 'Arquivo inválido.' using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = p_path) then
    raise exception 'Arquivo não encontrado.' using errcode = '22023';
  end if;
  if c.cnh_photo_path = p_path then return jsonb_build_object('id', c.id, 'replayed', true); end if;
  perform app.require(c.cnh_photo_path is null, 'Foto já guardada; substituição não permitida.');
  update public.couriers set cnh_photo_path = p_path, updated_at = app.now() where id = c.id;
  perform app.audit(p_tenant, 'courier.photo_attach', 'courier', c.id::text, jsonb_build_object('actor_id', p_actor));
  return jsonb_build_object('id', c.id, 'replayed', false);
end $$;

create or replace function public.courier_photo_reveal(p_tenant uuid, p_courier uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.couriers;
begin
  perform app.require(app.is_admin(p_tenant) and (app.has_perm(p_tenant, 'approve') or app.has_perm(p_tenant, 'team')));
  if p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then
    raise exception 'Justificativa obrigatória (10 a 1000 caracteres).' using errcode = '22023';
  end if;
  select * into c from public.couriers where tenant_id = p_tenant and id = p_courier;
  if not found or c.cnh_photo_path is null then raise exception 'Foto não encontrada.' using errcode = 'P0002'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = c.cnh_photo_path) then
    raise exception 'Foto não encontrada no armazenamento.' using errcode = 'P0002';
  end if;
  perform app.audit(p_tenant, 'courier.photo_reveal', 'courier', c.id::text, jsonb_build_object('reason', btrim(p_reason)));
  return jsonb_build_object('path', c.cnh_photo_path);
end $$;
revoke all on function public.courier_attach_photo(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.courier_attach_photo(uuid, uuid, text, uuid) to service_role;

revoke all on function
  public.courier_upsert_from_ocr(uuid, text, text, text, text, text), public.courier_search(uuid, text),
  public.courier_reveal_document(uuid, uuid, text), public.couriers_list(uuid),
  public.courier_deliveries(uuid, uuid, int, timestamptz, uuid), public.package_set_courier(uuid, uuid, uuid),
  public.courier_photo_authorize(uuid, uuid), public.courier_photo_reveal(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.courier_upsert_from_ocr(uuid, text, text, text, text, text), public.courier_search(uuid, text),
  public.courier_reveal_document(uuid, uuid, text), public.couriers_list(uuid),
  public.courier_deliveries(uuid, uuid, int, timestamptz, uuid), public.package_set_courier(uuid, uuid, uuid),
  public.courier_photo_authorize(uuid, uuid), public.courier_photo_reveal(uuid, uuid, text)
  to authenticated, service_role;
