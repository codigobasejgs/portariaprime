-- =============================================================================
-- PORTARIA PRIME — 0600: operação de encomendas (transacional + outbox)
-- =============================================================================

-- Enfileira avisos (outbox) na MESMA transação do evento. Destinatários vêm do
-- banco (contatos/vínculos ativos e preferências), nunca do navegador.
create or replace function app.enqueue_package_notifications(p_pkg public.packages, p_event text)
returns int language plpgsql security definer set search_path = '' as $$
declare s public.tenant_settings; n int := 0; c record; v_title text; v_body text;
begin
  select * into s from public.tenant_settings where tenant_id = p_pkg.tenant_id;
  if p_event = 'package_received' then
    v_title := 'Nova encomenda na portaria';
    v_body := 'Há uma encomenda (' || p_pkg.carrier || ') aguardando retirada. Abra o app para ver o QR Code.';
  else
    v_title := 'Encomenda retirada';
    v_body := 'Uma encomenda da sua unidade foi retirada. O comprovante está disponível no app.';
  end if;

  for c in select * from public.resident_contacts
            where tenant_id = p_pkg.tenant_id and unit_id = p_pkg.unit_id and active loop
    if c.phone is not null and c.notify_whatsapp and coalesce(s.notify_whatsapp, true) and app.has_feature(p_pkg.tenant_id, 'whatsapp') then
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'whatsapp', c.phone, p_pkg.id::text, jsonb_build_object('package_id', p_pkg.id))
      on conflict do nothing;
      n := n + 1;
    end if;
    if c.email is not null and c.notify_email and coalesce(s.notify_email, true) then
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'email', c.email, p_pkg.id::text, jsonb_build_object('package_id', p_pkg.id))
      on conflict do nothing;
      n := n + 1;
    end if;
  end loop;

  for c in select um.user_id from public.unit_memberships um
             join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
            where um.tenant_id = p_pkg.tenant_id and um.unit_id = p_pkg.unit_id and um.status = 'active' loop
    insert into public.notifications (tenant_id, user_id, kind, title, body, package_id)
    values (p_pkg.tenant_id, c.user_id, p_event, v_title, v_body, p_pkg.id);
    if coalesce(s.notify_push, true) then
      insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
      values (p_pkg.tenant_id, p_event, 'push', c.user_id::text, p_pkg.id::text, jsonb_build_object('package_id', p_pkg.id))
      on conflict do nothing;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Escolhe/valida local com bloqueio (serializa a disputa pela última vaga).
-- Nunca devolve um local padrão: se tudo estiver lotado, erro claro.
create or replace function app.pick_storage(p_tenant uuid, p_concierge uuid, p_wanted uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_any boolean; v_id uuid; v_cap int; v_used int;
begin
  perform 1 from public.storage_locations
   where tenant_id = p_tenant and concierge_location_id = p_concierge and active
   order by id for update;
  v_any := found;
  if p_wanted is not null then
    select capacity into v_cap from public.storage_locations
     where tenant_id = p_tenant and id = p_wanted and concierge_location_id = p_concierge and active;
    if not found then raise exception 'Local de armazenamento inválido para esta portaria.' using errcode = '22023'; end if;
    select count(*) into v_used from public.packages
     where tenant_id = p_tenant and storage_location_id = p_wanted and app.occupies_space(status);
    if v_used >= v_cap then raise exception 'Este local está lotado. Escolha outro.' using errcode = 'P0001'; end if;
    return p_wanted;
  end if;
  if not v_any then return null; end if;  -- condomínio sem mapa de locais configurado
  select sl.id into v_id
    from public.storage_locations sl
    left join lateral (select count(*) as used from public.packages p
                        where p.tenant_id = p_tenant and p.storage_location_id = sl.id and app.occupies_space(p.status)) o on true
   where sl.tenant_id = p_tenant and sl.concierge_location_id = p_concierge and sl.active and o.used < sl.capacity
   order by sl.is_contingency, (o.used::numeric / sl.capacity), sl.sort_order, sl.code
   limit 1;
  if v_id is null then
    raise exception 'Todos os locais desta portaria estão lotados. Libere espaço ou cadastre uma área de contingência.' using errcode = 'P0001';
  end if;
  return v_id;
end $$;

create or replace function app.default_concierge(p_tenant uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.concierge_locations where tenant_id = p_tenant and active order by created_at limit 1
$$;

create or replace function app.package_json(p public.packages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(p) || jsonb_build_object(
    'unit_block', u.block, 'unit_label', u.label, 'storage_code', sl.code)
  from (select 1) x
  left join public.units u on u.id = p.unit_id
  left join public.storage_locations sl on sl.id = p.storage_location_id
$$;

-- -----------------------------------------------------------------------------
-- Recebimento pela portaria (idempotente por p_idempotency_key).
-- -----------------------------------------------------------------------------
create or replace function public.receive_package(
  p_tenant uuid, p_idempotency_key text, p_unit uuid, p_tracking text, p_carrier text,
  p_recipient text default null, p_notes text default null,
  p_concierge uuid default null, p_storage_location uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_conc uuid; v_loc uuid; v_jobs int;
begin
  perform app.require(app.is_staff(p_tenant));
  select * into v from public.packages where tenant_id = p_tenant and idempotency_key = p_idempotency_key;
  if found then return app.package_json(v) || jsonb_build_object('replayed', true); end if;

  perform app.require(app.can_operate(p_tenant),
    'Assinatura inativa: novos recebimentos estão bloqueados. Regularize em Assinatura. Retiradas continuam liberadas.');
  perform app.require(exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active), 'Unidade inválida.');

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
      tracking_code, carrier, recipient_name, notes, registered_via, idempotency_key, received_at, received_by, stored_at)
    values (p_tenant, p_unit, v_conc, v_loc, case when v_loc is null then 'RECEBIDA' else 'ARMAZENADA' end,
      nullif(upper(btrim(p_tracking)), ''), coalesce(nullif(btrim(p_carrier), ''), 'Outra'),
      nullif(btrim(p_recipient), ''), nullif(btrim(p_notes), ''), 'portaria', p_idempotency_key,
      app.now(), auth.uid(), case when v_loc is null then null else app.now() end)
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
  values (p_tenant, v.id, 'received', auth.uid(), jsonb_build_object('storage_location_id', v_loc));
  v_jobs := app.enqueue_package_notifications(v, 'package_received');
  return app.package_json(v) || jsonb_build_object('replayed', false, 'notifications_queued', v_jobs);
end $$;

-- Conferência de pré-registro do totem: só aqui o morador é avisado.
create or replace function public.confirm_preregistered(
  p_tenant uuid, p_package uuid, p_unit uuid, p_tracking text default null,
  p_carrier text default null, p_storage_location uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_loc uuid;
begin
  perform app.require(app.is_staff(p_tenant));
  perform app.require(app.can_operate(p_tenant), 'Assinatura inativa: novos recebimentos estão bloqueados.');
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found or v.status <> 'PRE_REGISTRADA' then raise exception 'Pré-registro não encontrado ou já conferido.' using errcode = 'P0001'; end if;
  perform app.require(exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active), 'Unidade inválida.');
  v_loc := app.pick_storage(p_tenant, coalesce(v.concierge_location_id, app.default_concierge(p_tenant)), p_storage_location);
  update public.packages set unit_id = p_unit,
    tracking_code = coalesce(nullif(upper(btrim(p_tracking)), ''), tracking_code),
    carrier = coalesce(nullif(btrim(p_carrier), ''), carrier),
    concierge_location_id = coalesce(concierge_location_id, app.default_concierge(p_tenant)),
    storage_location_id = v_loc, status = case when v_loc is null then 'RECEBIDA' else 'ARMAZENADA' end,
    received_by = auth.uid(), stored_at = case when v_loc is null then null else app.now() end, updated_at = now()
  where id = v.id returning * into v;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, 'preregistration_confirmed', auth.uid(), '{}'::jsonb);
  perform app.enqueue_package_notifications(v, 'package_received');
  return app.package_json(v);
end $$;

-- Vincula foto/assinatura (object key no bucket privado) à encomenda.
create or replace function public.attach_package_file(p_tenant uuid, p_package uuid, p_kind text, p_path text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.require(app.is_staff(p_tenant));
  perform app.require(exists (select 1 from public.packages where tenant_id = p_tenant and id = p_package), 'Encomenda inválida.');
  if p_kind not in ('label_photo', 'signature', 'handover_photo')
     or p_path !~ ('^' || p_tenant::text || '/packages/' || p_package::text || '/[a-z_]+-[A-Za-z0-9-]{8,64}\.(jpg|png|webp)$') then
    raise exception 'Arquivo inválido.' using errcode = '22023';
  end if;
  perform app.require(exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = p_path),
    'O arquivo não foi enviado. Tente novamente.');
  insert into public.package_attachments (tenant_id, package_id, kind, object_path, created_by)
  values (p_tenant, p_package, p_kind, p_path, auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- QR de retirada: aleatório, uso único, com validade; só o hash fica no banco.
-- Emitido pelo servidor para o morador da unidade (ou equipe). Renovar revoga o anterior.
-- -----------------------------------------------------------------------------
create or replace function public.issue_pickup_token(p_tenant uuid, p_package uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_token text := app.random_token(); v_ttl int; v_exp timestamptz;
begin
  select * into v from public.packages where tenant_id = p_tenant and id = p_package;
  perform app.require(found and (app.is_staff(p_tenant) or app.is_unit_member(p_tenant, v.unit_id)));
  if not app.occupies_space(v.status) then raise exception 'Esta encomenda não está disponível para retirada.' using errcode = 'P0001'; end if;
  select qr_ttl_hours into v_ttl from public.tenant_settings where tenant_id = p_tenant;
  v_exp := app.now() + make_interval(hours => coalesce(v_ttl, 72));
  update public.pickup_tokens set revoked_at = now()
   where tenant_id = p_tenant and package_id = p_package and consumed_at is null and revoked_at is null;
  insert into public.pickup_tokens (tenant_id, package_id, token_hash, expires_at, created_by)
  values (p_tenant, p_package, app.sha256_hex(v_token), v_exp, auth.uid());
  return jsonb_build_object('token', 'PP1.' || v_token, 'expires_at', v_exp);
end $$;

create or replace function app.token_hash_from_qr(p_qr text) returns text
language sql immutable set search_path = '' as $$
  select app.sha256_hex(regexp_replace(btrim(coalesce(p_qr, '')), '^PP1\.', ''))
$$;

-- Porteiro lê o QR: devolve a encomenda correspondente (só do próprio condomínio).
create or replace function public.lookup_pickup_token(p_tenant uuid, p_qr text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.pickup_tokens; v public.packages;
begin
  perform app.require(app.is_staff(p_tenant));
  select * into t from public.pickup_tokens where token_hash = app.token_hash_from_qr(p_qr);
  if not found or t.tenant_id <> p_tenant then raise exception 'QR Code não reconhecido neste condomínio.' using errcode = 'P0001'; end if;
  if t.consumed_at is not null then raise exception 'QR Code já utilizado.' using errcode = 'P0001'; end if;
  if t.revoked_at is not null then raise exception 'QR Code substituído por um mais novo. Peça ao morador para atualizar o app.' using errcode = 'P0001'; end if;
  if t.expires_at <= app.now() then raise exception 'QR Code expirado. Peça ao morador para gerar um novo.' using errcode = 'P0001'; end if;
  select * into v from public.packages where id = t.package_id;
  return app.package_json(v);
end $$;

-- -----------------------------------------------------------------------------
-- Retirada: bloqueio de linha, QR de uso único ou modo manual justificado,
-- assinatura obrigatória (arquivo já enviado), comprovante e outbox na mesma transação.
-- Permitida mesmo com assinatura comercial restrita (pacote já guardado).
-- -----------------------------------------------------------------------------
create or replace function public.confirm_pickup(
  p_tenant uuid, p_package uuid, p_method text, p_qr text, p_picked_up_by text,
  p_signature_path text, p_handover_path text default null, p_manual_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v public.packages; t public.pickup_tokens; v_now timestamptz := app.now(); v_tz text;
  v_protocol text; v_receipt public.receipts; v_unit public.units; v_op text;
begin
  perform app.require(app.is_staff(p_tenant));
  if length(btrim(coalesce(p_picked_up_by, ''))) < 2 then
    raise exception 'Informe o nome de quem está retirando.' using errcode = '22023';
  end if;
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda não encontrada.' using errcode = 'P0002'; end if;
  if v.status = 'RETIRADA' then raise exception 'Esta encomenda já foi retirada.' using errcode = 'P0001'; end if;
  if not app.occupies_space(v.status) then
    raise exception 'Encomenda com status % não pode ser entregue.', v.status using errcode = 'P0001';
  end if;

  if p_method = 'qr' then
    select * into t from public.pickup_tokens where token_hash = app.token_hash_from_qr(p_qr) for update;
    if not found or t.tenant_id <> p_tenant or t.package_id <> p_package then
      raise exception 'QR Code não corresponde a esta encomenda.' using errcode = 'P0001';
    end if;
    if t.consumed_at is not null then raise exception 'QR Code já utilizado.' using errcode = 'P0001'; end if;
    if t.revoked_at is not null then raise exception 'QR Code substituído por um mais novo.' using errcode = 'P0001'; end if;
    if t.expires_at <= v_now then raise exception 'QR Code expirado.' using errcode = 'P0001'; end if;
    update public.pickup_tokens set consumed_at = v_now where id = t.id;
  elsif p_method = 'manual' then
    if length(btrim(coalesce(p_manual_reason, ''))) < 10 then
      raise exception 'Retirada sem QR exige justificativa (mín. 10 caracteres).' using errcode = '22023';
    end if;
  else
    raise exception 'Método de retirada inválido.' using errcode = '22023';
  end if;

  if p_signature_path is null or p_signature_path !~ ('^' || p_tenant::text || '/packages/' || p_package::text || '/signature-[A-Za-z0-9-]{8,64}\.png$')
     or not exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = p_signature_path) then
    raise exception 'Assinatura não recebida pelo servidor. Colete a assinatura e tente novamente.' using errcode = '22023';
  end if;
  insert into public.package_attachments (tenant_id, package_id, kind, object_path, created_by)
  values (p_tenant, p_package, 'signature', p_signature_path, auth.uid());
  if p_handover_path is not null then
    if p_handover_path !~ ('^' || p_tenant::text || '/packages/' || p_package::text || '/handover-[A-Za-z0-9-]{8,64}\.(jpg|png|webp)$')
       or not exists (select 1 from storage.objects where bucket_id = 'tenant-private' and name = p_handover_path) then
      raise exception 'Foto da entrega inválida.' using errcode = '22023';
    end if;
    insert into public.package_attachments (tenant_id, package_id, kind, object_path, created_by)
    values (p_tenant, p_package, 'handover_photo', p_handover_path, auth.uid());
  end if;

  update public.pickup_tokens set revoked_at = v_now
   where package_id = p_package and consumed_at is null and revoked_at is null;
  update public.packages set status = 'RETIRADA', picked_up_at = v_now, picked_up_by_name = btrim(p_picked_up_by),
    delivered_by = auth.uid(), pickup_method = p_method,
    manual_reason = case when p_method = 'manual' then btrim(p_manual_reason) end, updated_at = now()
  where id = p_package returning * into v;

  select timezone into v_tz from public.tenants where id = p_tenant;
  select * into v_unit from public.units where id = v.unit_id;
  select coalesce(full_name, 'Portaria') into v_op from public.profiles where id = auth.uid();
  v_protocol := 'PP-' || to_char(v_now at time zone v_tz, 'YYYYMMDD') || '-' || upper(substr(app.random_token(), 1, 8));
  insert into public.receipts (tenant_id, package_id, protocol, issued_at, snapshot)
  values (p_tenant, p_package, v_protocol, v_now, jsonb_build_object(
    'tracking_code', v.tracking_code, 'carrier', v.carrier, 'unit_block', v_unit.block, 'unit_label', v_unit.label,
    'received_at', v.received_at, 'picked_up_at', v.picked_up_at, 'picked_up_by', v.picked_up_by_name,
    'operator', coalesce(v_op, 'Portaria'), 'method', p_method, 'manual_reason', v.manual_reason,
    'signature_path', p_signature_path, 'handover_path', p_handover_path))
  returning * into v_receipt;

  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, p_package, 'picked_up', auth.uid(), jsonb_build_object('method', p_method, 'protocol', v_protocol));
  if p_method = 'manual' then
    perform app.audit(p_tenant, 'package.manual_pickup', 'package', p_package::text, jsonb_build_object('reason', v.manual_reason));
  end if;
  perform app.enqueue_package_notifications(v, 'package_picked_up');
  return app.package_json(v) || jsonb_build_object('protocol', v_protocol, 'receipt_id', v_receipt.id);
end $$;

-- Exceções: devolução (equipe); cancelamento/extravio (administrador). Nunca apaga histórico.
create or replace function public.resolve_package(p_tenant uuid, p_package uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_before text;
begin
  if p_status = 'DEVOLVIDA' then perform app.require(app.is_staff(p_tenant));
  elsif p_status in ('CANCELADA', 'EXTRAVIADA') then perform app.require(app.is_admin(p_tenant), 'Somente o administrador pode cancelar ou marcar extravio.');
  else raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Descreva o motivo (mín. 10 caracteres).' using errcode = '22023'; end if;
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda não encontrada.' using errcode = 'P0002'; end if;
  if not app.is_pending(v.status) then raise exception 'Encomenda já finalizada (%).', v.status using errcode = 'P0001'; end if;
  v_before := v.status;
  update public.packages set status = p_status, resolution_reason = btrim(p_reason), resolved_at = app.now(),
    resolved_by = auth.uid(), updated_at = now() where id = v.id returning * into v;
  update public.pickup_tokens set revoked_at = now() where package_id = v.id and consumed_at is null and revoked_at is null;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, 'resolved', auth.uid(), jsonb_build_object('from', v_before, 'to', p_status, 'reason', btrim(p_reason)));
  return app.package_json(v);
end $$;

create or replace function public.move_package(p_tenant uuid, p_package uuid, p_storage_location uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_from uuid;
begin
  perform app.require(app.is_staff(p_tenant));
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found or not app.occupies_space(v.status) then raise exception 'Encomenda não pode ser movida.' using errcode = 'P0001'; end if;
  if v.storage_location_id = p_storage_location then return app.package_json(v); end if;
  v_from := v.storage_location_id;
  perform app.pick_storage(p_tenant, v.concierge_location_id, p_storage_location);
  update public.packages set storage_location_id = p_storage_location, status = 'ARMAZENADA',
    stored_at = coalesce(stored_at, app.now()), updated_at = now() where id = v.id returning * into v;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, 'moved', auth.uid(), jsonb_build_object('from', v_from, 'to', p_storage_location, 'reason', p_reason));
  return app.package_json(v);
end $$;

-- -----------------------------------------------------------------------------
-- Consultas (SECURITY INVOKER: a RLS decide o que cada papel enxerga).
-- Datas interpretadas no fuso do condomínio; paginação por cursor (keyset).
-- -----------------------------------------------------------------------------
create or replace function public.list_packages(
  p_tenant uuid, p_status text default null, p_from date default null, p_to date default null,
  p_search text default null, p_limit int default 50,
  p_cursor_at timestamptz default null, p_cursor_id uuid default null
) returns table (
  id uuid, status text, tracking_code text, carrier text, recipient_name text, notes text, registered_via text,
  unit_id uuid, unit_block text, unit_label text, storage_location_id uuid, storage_code text,
  received_at timestamptz, stored_at timestamptz, notified_at timestamptz, picked_up_at timestamptz,
  picked_up_by_name text, pickup_method text, resolution_reason text, courier_name text
)
language sql stable set search_path = '' as $$
  with tz as (select timezone from public.tenants where id = p_tenant)
  select p.id, p.status, p.tracking_code, p.carrier, p.recipient_name, p.notes, p.registered_via,
         p.unit_id, u.block, u.label, p.storage_location_id, sl.code,
         p.received_at, p.stored_at, p.notified_at, p.picked_up_at, p.picked_up_by_name, p.pickup_method,
         p.resolution_reason, p.courier_name
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

create or replace function public.report_summary(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_a timestamptz; v_b timestamptz;
begin
  perform app.require(app.is_staff(p_tenant));
  select timezone into v_tz from public.tenants where id = p_tenant;
  v_a := p_from::timestamp at time zone v_tz;
  v_b := (p_to + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'entries', (select count(*) from public.packages where tenant_id = p_tenant and received_at >= v_a and received_at < v_b and status <> 'PRE_REGISTRADA'),
    'pickups', (select count(*) from public.packages where tenant_id = p_tenant and picked_up_at >= v_a and picked_up_at < v_b),
    'pending_now', (select count(*) from public.packages where tenant_id = p_tenant and app.occupies_space(status)),
    'preregistered_now', (select count(*) from public.packages where tenant_id = p_tenant and status = 'PRE_REGISTRADA'),
    'avg_dwell_hours', (select round(avg(extract(epoch from picked_up_at - received_at)) / 3600, 1)
                          from public.packages where tenant_id = p_tenant and picked_up_at >= v_a and picked_up_at < v_b),
    'exceptions', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
        select status, count(*) n from public.packages where tenant_id = p_tenant and resolved_at >= v_a and resolved_at < v_b group by status) x),
    'by_carrier', (select coalesce(jsonb_object_agg(carrier, n), '{}'::jsonb) from (
        select carrier, count(*) n from public.packages where tenant_id = p_tenant and received_at >= v_a and received_at < v_b group by carrier) x),
    'occupancy', (select coalesce(jsonb_agg(jsonb_build_object('id', sl.id, 'code', sl.code, 'capacity', sl.capacity,
        'used', (select count(*) from public.packages p where p.storage_location_id = sl.id and app.occupies_space(p.status)),
        'is_contingency', sl.is_contingency) order by sl.sort_order, sl.code), '[]'::jsonb)
        from public.storage_locations sl where sl.tenant_id = p_tenant and sl.active),
    'notification_failures', (select count(*) from public.notification_jobs where tenant_id = p_tenant and status = 'failed' and created_at >= v_a and created_at < v_b)
  );
end $$;

-- -----------------------------------------------------------------------------
-- Totem pareado. Pareamento iniciado pelo administrador; o dispositivo recebe
-- uma credencial própria (hash no banco), revogável. Chamadas do totem passam
-- pela API (service role) — nunca recebem token de usuário.
-- -----------------------------------------------------------------------------
create or replace function public.create_device(p_tenant uuid, p_name text, p_concierge uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(substr(app.random_token(), 1, 8)); v_id uuid;
begin
  perform app.require(app.has_perm(p_tenant, 'settings'));
  perform app.require(app.has_feature(p_tenant, 'totem'), 'O totem não está incluído no plano atual.');
  insert into public.device_enrollments (tenant_id, name, concierge_location_id, pairing_code_hash, pairing_expires_at, created_by)
  values (p_tenant, btrim(p_name), coalesce(p_concierge, app.default_concierge(p_tenant)),
          app.sha256_hex(v_code), app.now() + interval '15 minutes', auth.uid())
  returning id into v_id;
  perform app.audit(p_tenant, 'device.created', 'device', v_id::text);
  return jsonb_build_object('device_id', v_id, 'pairing_code', v_code, 'expires_in_minutes', 15);
end $$;

create or replace function public.revoke_device(p_device uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.device_enrollments where id = p_device;
  perform app.require(v_tenant is not null and app.has_perm(v_tenant, 'settings'));
  update public.device_enrollments set status = 'revoked', secret_hash = null, pairing_code_hash = null where id = p_device;
  perform app.audit(v_tenant, 'device.revoked', 'device', p_device::text);
end $$;

-- Somente service_role (chamadas pela API do totem).
create or replace function public.device_pair(p_code text, p_secret_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.device_enrollments;
begin
  select * into d from public.device_enrollments
   where pairing_code_hash = app.sha256_hex(upper(btrim(coalesce(p_code, '')))) and status = 'pending'
     and pairing_expires_at > app.now() for update;
  if not found then raise exception 'Código de pareamento inválido ou expirado.' using errcode = 'P0001'; end if;
  update public.device_enrollments set status = 'active', secret_hash = p_secret_hash,
    pairing_code_hash = null, pairing_expires_at = null, last_seen_at = now() where id = d.id;
  insert into public.audit_logs (tenant_id, action, target_type, target_id) values (d.tenant_id, 'device.paired', 'device', d.id::text);
  return jsonb_build_object('device_id', d.id, 'tenant_id', d.tenant_id,
    'tenant_slug', (select slug from public.tenants where id = d.tenant_id));
end $$;

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
                       from public.units where tenant_id = d.tenant_id and active), '[]'::jsonb));
end $$;

create or replace function public.device_preregister(
  p_secret_hash text, p_idempotency_key text, p_unit uuid, p_carrier text, p_tracking text, p_courier text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.device_enrollments; v public.packages;
begin
  select * into d from public.device_enrollments where secret_hash = p_secret_hash and status = 'active';
  if not found then raise exception 'Totem não pareado ou revogado.' using errcode = '42501'; end if;
  if not (app.has_feature(d.tenant_id, 'totem') and app.can_operate(d.tenant_id)) then
    raise exception 'Totem indisponível. Procure a portaria.' using errcode = '42501';
  end if;
  select * into v from public.packages where tenant_id = d.tenant_id and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('package_id', v.id, 'replayed', true); end if;
  if p_unit is not null and not exists (select 1 from public.units where tenant_id = d.tenant_id and id = p_unit and active) then
    raise exception 'Unidade inválida.' using errcode = '22023';
  end if;
  begin
    insert into public.packages (tenant_id, unit_id, concierge_location_id, status, tracking_code, carrier,
      registered_via, courier_name, idempotency_key, received_at)
    values (d.tenant_id, p_unit, d.concierge_location_id, 'PRE_REGISTRADA', nullif(upper(btrim(p_tracking)), ''),
      coalesce(nullif(btrim(p_carrier), ''), 'Outra'), 'totem', nullif(btrim(p_courier), ''), p_idempotency_key, app.now())
    returning * into v;
  exception when unique_violation then
    raise exception 'Este rastreio já está registrado na portaria.' using errcode = 'P0001';
  end;
  insert into public.package_events (tenant_id, package_id, type, data)
  values (d.tenant_id, v.id, 'preregistered', jsonb_build_object('device_id', d.id));
  return jsonb_build_object('package_id', v.id, 'replayed', false);
end $$;

-- Franquia de OCR (contador atômico). Esgotada: retorna false (digitação manual).
create or replace function app.consume_usage(p_tenant uuid, p_metric text, p_limit int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_period text := to_char(app.now() at time zone 'UTC', 'YYYY-MM'); v_ok int;
begin
  insert into public.usage_counters (tenant_id, metric, period, used) values (p_tenant, p_metric, v_period, 0)
  on conflict do nothing;
  update public.usage_counters set used = used + 1
   where tenant_id = p_tenant and metric = p_metric and period = v_period and used < p_limit
   returning used into v_ok;
  return v_ok is not null;
end $$;

create or replace function public.consume_ocr(p_tenant uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.is_staff(p_tenant));
  if not app.has_feature(p_tenant, 'ocr') then return false; end if;
  return app.consume_usage(p_tenant, 'ocr', (app.entitlements(p_tenant)).ocr_monthly);
end $$;
