-- =============================================================================
-- Melhorias da portaria (estritamente aditivo; nenhuma assinatura existente muda).
--  (4) Morador não identificado: packages.unidentified_reason + RPCs próprias.
--      receive_and_store (11 parâmetros) NÃO muda: totens/clientes antigos chamam por
--      nome; acrescentar parâmetro exigiria drop/recreate (nova sobrecarga = ambiguidade
--      no PostgREST). A marcação é uma segunda chamada idempotente
--      (package_mark_unidentified) logo após o registro.
--  (3a) Recusa pelo morador: colunas rejected_* (status não muda). QR deixa de valer
--      (tokens revogados + issue/lookup recusam). A portaria resolve como DEVOLVIDA
--      pelo resolve_package existente.
--  (3b) Palavra-chave de entrega: tabela delivery_keywords; leitura por RLS só do
--      morador ativo da PRÓPRIA unidade e da equipe do condomínio; escrita só por RPC.
-- =============================================================================

alter table public.packages
  add column if not exists unidentified_reason text
    check (unidentified_reason is null or unidentified_reason in ('unregistered_resident', 'incomplete_or_unknown_name')),
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists rejection_reason text
    check (rejection_reason is null or rejection_reason in ('wrong_unit', 'cancelled', 'other')),
  add column if not exists rejection_note text check (rejection_note is null or length(rejection_note) <= 300);
create index if not exists packages_unidentified_idx on public.packages (tenant_id) where unidentified_reason is not null;
create index if not exists packages_rejected_idx on public.packages (tenant_id) where rejected_at is not null;

-- Moradores de uma unidade (nome + situação) para a portaria escolher/conferir.
-- Sem telefone nem e-mail: contato é do síndico (list_unidentified_packages).
create or replace function app.unit_people(p_tenant uuid, p_unit uuid, p_contacts boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'user_id', x.user_id, 'name', x.name, 'status', x.status,
      'phone', case when p_contacts then x.phone end, 'email', case when p_contacts then x.email end))
      order by x.status, x.name), '[]'::jsonb)
  from (
    select um.user_id, coalesce(case when rc.active then rc.name end, pr.full_name, 'Morador') name,
           case when um.status = 'active' and m.status = 'active' then 'active' when m.status = 'pending' then 'pending' else 'revoked' end status,
           rc.phone, coalesce(case when rc.active then rc.email end, au.email::text) email
      from public.unit_memberships um
      join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador'
      join auth.users au on au.id = um.user_id
      left join public.profiles pr on pr.id = um.user_id
      left join lateral (select c.name, c.email, c.phone, c.active from public.resident_contacts c
                          where c.tenant_id = um.tenant_id and c.unit_id = um.unit_id and c.user_id = um.user_id
                          order by c.active desc, c.created_at desc limit 1) rc on true
     where um.tenant_id = p_tenant and um.unit_id = p_unit
    union all
    select r.user_id, r.full_name, 'pending', r.phone, null
      from public.access_requests r
     where r.tenant_id = p_tenant and r.unit_id = p_unit and r.status = 'pending'
       and not exists (select 1 from public.unit_memberships um where um.tenant_id = r.tenant_id and um.unit_id = r.unit_id and um.user_id = r.user_id)
  ) x
$$;
revoke all on function app.unit_people(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function public.unit_residents_for_staff(p_tenant uuid, p_unit uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_staff(p_tenant));
  if not exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit) then
    raise exception 'Unidade inválida.' using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(e - 'user_id') from jsonb_array_elements(app.unit_people(p_tenant, p_unit, false)) e), '[]'::jsonb);
end $$;

-- Marca (ou desmarca, p_reason null) a encomenda como de morador não identificado. Idempotente.
create or replace function public.package_mark_unidentified(p_tenant uuid, p_package uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages;
begin
  perform app.require(app.is_staff(p_tenant));
  if p_reason is not null and p_reason not in ('unregistered_resident', 'incomplete_or_unknown_name') then
    raise exception 'Motivo inválido.' using errcode = '22023';
  end if;
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda não encontrada.' using errcode = 'P0002'; end if;
  if not app.occupies_space(v.status) then
    raise exception 'Esta encomenda não está aguardando retirada.' using errcode = 'P0001';
  end if;
  if v.unidentified_reason is not distinct from p_reason then return app.package_json(v); end if;
  update public.packages set unidentified_reason = p_reason, updated_at = now() where id = v.id returning * into v;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, case when p_reason is null then 'unidentified_cleared' else 'marked_unidentified' end, auth.uid(),
          jsonb_build_object('reason', p_reason));
  perform app.audit(p_tenant, 'package.unidentified', 'package', v.id::text, jsonb_build_object('reason', p_reason));
  return app.package_json(v);
end $$;

-- Aba "Morador não identificado" do síndico (permissão approve): tudo que precisa para destinar.
create or replace function public.list_unidentified_packages(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova moradores pode destinar encomendas.');
  return coalesce((select jsonb_agg(app.package_json(p) || jsonb_build_object(
      'label_photo_path', (select a.object_path from public.package_attachments a
                            where a.tenant_id = p.tenant_id and a.package_id = p.id and a.kind = 'label_photo' order by a.created_at desc limit 1),
      'residents', app.unit_people(p.tenant_id, p.unit_id, true)) order by p.received_at)
    from public.packages p
   where p.tenant_id = p_tenant and p.unidentified_reason is not null and app.occupies_space(p.status)), '[]'::jsonb);
end $$;

-- Corrigir / destinar: unidade, destinatário e (opcional) morador ativo daquela unidade.
-- Limpa a marcação; se a unidade mudou, avisa os moradores da nova (dedupe por encomenda+tipo).
create or replace function public.package_destinate(
  p_tenant uuid, p_package uuid, p_unit uuid, p_recipient text, p_resident_user uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_old public.packages; v_name text := nullif(btrim(coalesce(p_recipient, '')), '');
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova moradores pode destinar encomendas.');
  select * into v_old from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda não encontrada.' using errcode = 'P0002'; end if;
  if not app.occupies_space(v_old.status) then
    raise exception 'Esta encomenda não está aguardando retirada.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active) then
    raise exception 'Unidade inválida ou desativada.' using errcode = '22023';
  end if;
  if p_resident_user is not null then
    select x->>'name' into v_name from jsonb_array_elements(app.unit_people(p_tenant, p_unit, false)) x
     where (x->>'user_id')::uuid = p_resident_user and x->>'status' = 'active';
    if v_name is null then raise exception 'Morador não está ativo nesta unidade.' using errcode = '22023'; end if;
  end if;
  if v_name is not null and length(v_name) > 120 then raise exception 'Nome do destinatário muito longo.' using errcode = '22023'; end if;
  update public.packages set unit_id = p_unit, recipient_name = coalesce(v_name, recipient_name),
    unidentified_reason = null, updated_at = now()
   where id = p_package returning * into v;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, 'destinated', auth.uid(), jsonb_build_object(
    'from_unit', v_old.unit_id, 'to_unit', v.unit_id, 'from_recipient', v_old.recipient_name, 'to_recipient', v.recipient_name,
    'resident_user', p_resident_user, 'previous_reason', v_old.unidentified_reason));
  perform app.audit(p_tenant, 'package.destinated', 'package', v.id::text,
    jsonb_build_object('from_unit', v_old.unit_id, 'to_unit', v.unit_id, 'resident_user', p_resident_user));
  if v.unit_id is distinct from v_old.unit_id then
    -- QR emitido para a unidade anterior deixa de valer.
    update public.pickup_tokens set revoked_at = now()
     where tenant_id = p_tenant and package_id = v.id and consumed_at is null and revoked_at is null;
    perform app.enqueue_package_notifications(v, 'package_received');
  end if;
  return app.package_json(v);
end $$;

-- -----------------------------------------------------------------------------
-- (3a) Recusa pelo morador
-- -----------------------------------------------------------------------------
-- Amplia o CHECK existente sem remover eventos de outras frentes.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid = 'public.notification_jobs'::regclass and conname = 'notification_jobs_event_check';
  if def is null then raise exception 'CHECK de eventos não encontrado'; end if;
  if position('package_rejected' in def) = 0 then
    alter table public.notification_jobs drop constraint notification_jobs_event_check;
    execute 'alter table public.notification_jobs add constraint notification_jobs_event_check CHECK (event = ''package_rejected'' OR (' || substr(def, 7) || '))';
  end if;
end $$;

create or replace function app.package_rejected_notification_allowed(j public.notification_jobs) returns boolean
language sql stable security definer set search_path = '' as $$
  select j.channel = 'push'
    and exists(select 1 from public.tenants where id = j.tenant_id and status = 'active')
    and exists(select 1 from public.tenant_memberships m where m.tenant_id = j.tenant_id
      and m.user_id::text = j.recipient and m.role in ('admin', 'porteiro') and m.status = 'active')
    and exists(select 1 from public.packages p where p.tenant_id = j.tenant_id and p.id::text = j.ref_id
      and p.rejected_at is not null and app.occupies_space(p.status))
$$;
revoke all on function app.package_rejected_notification_allowed(public.notification_jobs) from public, anon, authenticated;

-- Revalida ao inserir e ao enviar; mantém todas as regras existentes.
do $$
declare src text;
begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if position('package_rejected_notification_allowed' in src) = 0 then
    src := regexp_replace(src, E'begin\\r?\\n', E'begin\n  if j.event = ''package_rejected'' then return app.package_rejected_notification_allowed(j); end if;\n', 'i');
    if position('package_rejected_notification_allowed' in src) = 0 then raise exception 'Não foi possível encadear autorização de recusa'; end if;
    execute src;
  end if;
end $$;

create or replace function public.resident_reject_package(p_tenant uuid, p_package uuid, p_reason text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_unit text;
begin
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  perform app.require(found and app.is_unit_member(p_tenant, v.unit_id), 'Encomenda não encontrada ou sem acesso.');
  if v.rejected_at is not null then return app.resident_package_json(v); end if;
  if not app.occupies_space(v.status) then
    raise exception 'Esta encomenda não está aguardando retirada.' using errcode = 'P0001';
  end if;
  if coalesce(p_reason, '') not in ('wrong_unit', 'cancelled', 'other') then raise exception 'Motivo inválido.' using errcode = '22023'; end if;
  if p_reason = 'other' and length(coalesce(v_note, '')) < 3 then
    raise exception 'Descreva o motivo da recusa.' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 300 then raise exception 'Observação muito longa (máx. 300).' using errcode = '22023'; end if;
  update public.packages set rejected_at = app.now(), rejected_by = auth.uid(), rejection_reason = p_reason,
    rejection_note = v_note, updated_at = now()
   where id = v.id returning * into v;
  update public.pickup_tokens set revoked_at = now()
   where tenant_id = p_tenant and package_id = v.id and consumed_at is null and revoked_at is null;
  insert into public.package_events (tenant_id, package_id, type, actor_id, data)
  values (p_tenant, v.id, 'rejected_by_resident', auth.uid(), jsonb_build_object('reason', p_reason, 'note', v_note));
  perform app.audit(p_tenant, 'package.rejected_by_resident', 'package', v.id::text, jsonb_build_object('reason', p_reason));
  select app.unit_display(p_tenant, u.block, u.label) into v_unit from public.units u where u.id = v.unit_id;
  -- Push discreto via outbox existente: destinatários exclusivamente staff deste tenant.
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  select distinct p_tenant, 'package_rejected', 'push', m.user_id::text, v.id::text, '{}'::jsonb
    from public.tenant_memberships m
   where m.tenant_id = p_tenant and m.role in ('admin', 'porteiro') and m.status = 'active'
     and coalesce((select s.notify_push from public.tenant_settings s where s.tenant_id = p_tenant), true)
  on conflict do nothing;
  -- Aviso interno à equipe.
  insert into public.notifications (tenant_id, user_id, kind, title, body, package_id)
  select distinct p_tenant, m.user_id, 'package_rejected', 'Encomenda recusada pelo morador',
         left(coalesce(v_unit, 'Unidade') || ' · ' || v.carrier || ' · ' ||
           case p_reason when 'wrong_unit' then 'Não é desta unidade' when 'cancelled' then 'Compra cancelada' else 'Outro' end ||
           coalesce(': ' || v_note, '') || '. Devolva pela portaria.', 500), v.id
    from public.tenant_memberships m
   where m.tenant_id = p_tenant and m.role in ('admin', 'porteiro') and m.status = 'active';
  return app.resident_package_json(v);
end $$;

-- Igual à 20261019000600, recusando encomenda recusada pelo morador.
create or replace function public.issue_pickup_token(p_tenant uuid, p_package uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_token text := app.random_token(); v_ttl int; v_exp timestamptz;
begin
  select * into v from public.packages where tenant_id = p_tenant and id = p_package;
  perform app.require(found and (app.is_staff(p_tenant) or app.is_unit_member(p_tenant, v.unit_id)));
  if not app.occupies_space(v.status) then raise exception 'Esta encomenda não está disponível para retirada.' using errcode = 'P0001'; end if;
  if v.rejected_at is not null then raise exception 'Encomenda recusada pelo morador: não está disponível para retirada.' using errcode = 'P0001'; end if;
  select qr_ttl_hours into v_ttl from public.tenant_settings where tenant_id = p_tenant;
  v_exp := app.now() + make_interval(hours => coalesce(v_ttl, 72));
  update public.pickup_tokens set revoked_at = now()
   where tenant_id = p_tenant and package_id = p_package and consumed_at is null and revoked_at is null;
  insert into public.pickup_tokens (tenant_id, package_id, token_hash, expires_at, created_by)
  values (p_tenant, p_package, app.sha256_hex(v_token), v_exp, auth.uid());
  return jsonb_build_object('token', 'PP1.' || v_token, 'expires_at', v_exp);
end $$;

-- Igual à 20261022000100, recusando encomenda recusada pelo morador (o QR já foi revogado; defesa extra).
create or replace function public.lookup_pickup_token(p_tenant uuid, p_qr text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.pickup_tokens; v public.packages;
begin
  perform app.require(app.is_staff(p_tenant));
  if coalesce(p_qr, '') !~ '^PP1\.[0-9a-f]{20,128}$' then
    raise exception 'Este não é um QR de retirada da Portaria Prime.' using errcode = 'P0001';
  end if;
  select * into t from public.pickup_tokens where token_hash = app.token_hash_from_qr(p_qr);
  if not found or t.tenant_id <> p_tenant then raise exception 'QR Code não reconhecido neste condomínio.' using errcode = 'P0001'; end if;
  if t.consumed_at is not null then raise exception 'QR Code já utilizado.' using errcode = 'P0001'; end if;
  if t.revoked_at is not null then raise exception 'QR Code substituído por um mais novo. Peça ao morador para atualizar o app.' using errcode = 'P0001'; end if;
  if t.expires_at <= app.now() then raise exception 'QR Code expirado. Peça ao morador para gerar um novo.' using errcode = 'P0001'; end if;
  select * into v from public.packages where tenant_id = p_tenant and id = t.package_id;
  if not app.occupies_space(v.status) then raise exception 'Encomenda indisponível para entrega (%).', v.status using errcode = 'P0001'; end if;
  if v.rejected_at is not null then raise exception 'Encomenda recusada pelo morador: devolva pela portaria.' using errcode = 'P0001'; end if;
  return app.package_json(v) || jsonb_build_object(
    'label_photo_path', (select object_path from public.package_attachments
                          where tenant_id = p_tenant and package_id = v.id and kind = 'label_photo' order by created_at desc limit 1),
    'moved', exists(select 1 from public.package_events where tenant_id = p_tenant and package_id = v.id and type = 'moved'));
end $$;

-- Igual à 20261106000100 + dados da recusa.
create or replace function app.resident_package_json(p public.packages) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'ref', app.package_ref(p.id), 'status', p.status, 'carrier', p.carrier, 'tracking_code', p.tracking_code,
    'recipient_name', p.recipient_name, 'unit_id', p.unit_id, 'unit_block', u.block, 'unit_label', u.label,
    'received_at', p.received_at, 'stored_at', p.stored_at, 'picked_up_at', p.picked_up_at,
    'picked_up_by_name', p.picked_up_by_name, 'resolved_at', p.resolved_at, 'concierge_name', c.name,
    'courier_name', p.courier_name, 'received_by_name', p.received_by_name,
    'rejected_at', p.rejected_at, 'rejection_reason', p.rejection_reason, 'rejection_note', p.rejection_note,
    'receipt', (select jsonb_build_object('protocol', r.protocol, 'pdf_status', r.pdf_status)
                  from public.receipts r where r.tenant_id = p.tenant_id and r.package_id = p.id
                   and app.can_see_receipt(p.tenant_id, p.unit_id, r.issued_at)))
  from (select 1) x
  left join public.units u on u.id = p.unit_id
  left join public.concierge_locations c on c.id = p.concierge_location_id
$$;

-- Destaques da lista da portaria / painel (list_packages não muda: RETURNS TABLE exigiria drop).
create or replace function public.staff_package_flags(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_staff(p_tenant));
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'rejected_at', p.rejected_at, 'rejection_reason', p.rejection_reason,
      'rejection_note', p.rejection_note, 'unidentified_reason', p.unidentified_reason) order by p.received_at)
    from public.packages p
   where p.tenant_id = p_tenant and app.occupies_space(p.status)
     and (p.rejected_at is not null or p.unidentified_reason is not null)), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- (3b) Palavra-chave de entrega
-- -----------------------------------------------------------------------------
-- (backup: scripts/backup-prime.mjs descobre tabelas pelo texto abaixo)
-- create table public.delivery_keywords
create table if not exists public.delivery_keywords (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  keyword text not null check (length(btrim(keyword)) between 2 and 60),
  carrier text check (carrier is null or length(carrier) <= 40),
  recipient_name text check (recipient_name is null or length(recipient_name) <= 120),
  note text check (note is null or length(note) <= 300),
  valid_until date,
  status text not null default 'active' check (status in ('active', 'used', 'cancelled')),
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id) on delete cascade
);
alter table public.delivery_keywords add column if not exists expires_at timestamptz;
create index if not exists delivery_keywords_unit_idx on public.delivery_keywords (tenant_id, unit_id, status);
alter table public.delivery_keywords enable row level security;
revoke all on public.delivery_keywords from public, anon, authenticated;
grant select on public.delivery_keywords to authenticated;
grant all on public.delivery_keywords to service_role;
drop policy if exists delivery_keywords_select on public.delivery_keywords;
create policy delivery_keywords_select on public.delivery_keywords for select to authenticated
  using (app.is_staff(tenant_id) or (created_by = auth.uid() and app.is_unit_member(tenant_id, unit_id)));

create or replace function app.delivery_keyword_json(k public.delivery_keywords) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(k) || jsonb_build_object('unit_block', u.block, 'unit_label', u.label,
    'created_by_name', coalesce((select c.name from public.resident_contacts c where c.tenant_id = k.tenant_id and c.unit_id = k.unit_id
                                   and c.user_id = k.created_by and c.active order by c.created_at desc limit 1),
                                (select p.full_name from public.profiles p where p.id = k.created_by)))
  from public.units u where u.id = k.unit_id
$$;
revoke all on function app.delivery_keyword_json(public.delivery_keywords) from public, anon, authenticated;

-- Criar (p_id null) ou editar: só morador ativo da PRÓPRIA unidade.
create or replace function public.delivery_keyword_save(
  p_tenant uuid, p_id uuid, p_unit uuid, p_keyword text, p_carrier text default null, p_recipient text default null,
  p_note text default null, p_valid_until date default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.delivery_keywords; v_kw text := btrim(coalesce(p_keyword, ''));
begin
  if p_id is not null then
    select * into k from public.delivery_keywords where tenant_id = p_tenant and id = p_id for update;
    perform app.require(found and (app.is_staff(p_tenant) or (k.created_by = auth.uid() and app.is_unit_member(p_tenant, k.unit_id))), 'Palavra-chave não encontrada.');
    if k.status <> 'active' then raise exception 'Palavra-chave já utilizada ou cancelada.' using errcode = 'P0001'; end if;
  else
    perform app.require(app.is_unit_member(p_tenant, p_unit), 'Somente moradores da unidade podem informar palavra-chave.');
  end if;
  if length(v_kw) not between 2 and 60 then raise exception 'Palavra-chave deve ter de 2 a 60 caracteres.' using errcode = '22023'; end if;
  if length(coalesce(p_carrier, '')) > 40 or length(coalesce(p_recipient, '')) > 120 or length(coalesce(p_note, '')) > 300 then
    raise exception 'Texto muito longo.' using errcode = '22023';
  end if;
  if p_valid_until is not null and p_valid_until < (app.now() at time zone coalesce((select timezone from public.tenants where id = p_tenant), 'America/Sao_Paulo'))::date then
    raise exception 'A validade não pode estar no passado.' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.delivery_keywords (tenant_id, unit_id, created_by, keyword, carrier, recipient_name, note, valid_until)
    values (p_tenant, p_unit, auth.uid(), v_kw, nullif(btrim(coalesce(p_carrier, '')), ''), nullif(btrim(coalesce(p_recipient, '')), ''),
            nullif(btrim(coalesce(p_note, '')), ''), p_valid_until)
    returning * into k;
  else
    update public.delivery_keywords set keyword = v_kw, carrier = nullif(btrim(coalesce(p_carrier, '')), ''),
      recipient_name = nullif(btrim(coalesce(p_recipient, '')), ''), note = nullif(btrim(coalesce(p_note, '')), ''),
      valid_until = p_valid_until, updated_at = now()
     where id = k.id returning * into k;
  end if;
  perform app.audit(p_tenant, case when p_id is null then 'delivery_keyword.created' else 'delivery_keyword.updated' end,
    'delivery_keyword', k.id::text, jsonb_build_object('unit_id', k.unit_id));
  return app.delivery_keyword_json(k);
end $$;

-- RPC nova preserva a assinatura antiga; validade com hora é absoluta (timestamptz).
create or replace function public.delivery_keyword_save_v2(
  p_tenant uuid, p_id uuid, p_unit uuid, p_keyword text, p_carrier text default null, p_recipient text default null,
  p_note text default null, p_expires_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb; k public.delivery_keywords;
begin
  if p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at <= app.now()) then
    raise exception 'A validade deve estar no futuro.' using errcode = '22023';
  end if;
  result := public.delivery_keyword_save(p_tenant, p_id, p_unit, p_keyword, p_carrier, p_recipient, p_note, null);
  update public.delivery_keywords set expires_at = p_expires_at where id = (result->>'id')::uuid returning * into k;
  return app.delivery_keyword_json(k);
end $$;
revoke all on function public.delivery_keyword_save_v2(uuid, uuid, uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.delivery_keyword_save_v2(uuid, uuid, uuid, text, text, text, text, timestamptz) to authenticated, service_role;

create or replace function public.delivery_keyword_cancel(p_tenant uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.delivery_keywords;
begin
  select * into k from public.delivery_keywords where tenant_id = p_tenant and id = p_id for update;
  perform app.require(found and (app.is_staff(p_tenant) or (k.created_by = auth.uid() and app.is_unit_member(p_tenant, k.unit_id))), 'Palavra-chave não encontrada.');
  if k.status = 'cancelled' then return app.delivery_keyword_json(k); end if;
  if k.status <> 'active' then raise exception 'Palavra-chave já utilizada.' using errcode = 'P0001'; end if;
  update public.delivery_keywords set status = 'cancelled', updated_at = now() where id = k.id returning * into k;
  perform app.audit(p_tenant, 'delivery_keyword.cancelled', 'delivery_keyword', k.id::text, jsonb_build_object('unit_id', k.unit_id));
  return app.delivery_keyword_json(k);
end $$;

create or replace function public.delivery_keyword_mark_used(p_tenant uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k public.delivery_keywords;
begin
  select * into k from public.delivery_keywords where tenant_id = p_tenant and id = p_id for update;
  perform app.require(found and (app.is_staff(p_tenant) or (k.created_by = auth.uid() and app.is_unit_member(p_tenant, k.unit_id))), 'Palavra-chave não encontrada.');
  if k.status = 'used' then return app.delivery_keyword_json(k); end if;
  if k.expires_at <= app.now() or k.valid_until < (app.now() at time zone (select timezone from public.tenants where id = p_tenant))::date then
    raise exception 'Palavra-chave expirada.' using errcode = 'P0001';
  end if;
  if k.status <> 'active' then raise exception 'Palavra-chave cancelada pelo morador.' using errcode = 'P0001'; end if;
  update public.delivery_keywords set status = 'used', used_at = app.now(), used_by = auth.uid(), updated_at = now()
   where id = k.id returning * into k;
  perform app.audit(p_tenant, 'delivery_keyword.used', 'delivery_keyword', k.id::text, jsonb_build_object('unit_id', k.unit_id));
  return app.delivery_keyword_json(k);
end $$;

-- Equipe: ativas e válidas do condomínio (opcionalmente de uma unidade). Morador: as das próprias unidades.
create or replace function public.list_delivery_keywords(p_tenant uuid, p_unit uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_staff boolean := app.is_staff(p_tenant); v_today date;
begin
  perform app.require(v_staff or app.has_role(p_tenant, array['morador']));
  v_today := (app.now() at time zone coalesce((select timezone from public.tenants where id = p_tenant), 'America/Sao_Paulo'))::date;
  return coalesce((select jsonb_agg(app.delivery_keyword_json(k) order by k.created_at desc)
    from public.delivery_keywords k
   where k.tenant_id = p_tenant and (p_unit is null or k.unit_id = p_unit)
     and (k.status <> 'active' or ((k.expires_at is null or k.expires_at > app.now()) and (k.valid_until is null or k.valid_until >= v_today)))
     and case when v_staff then k.status = 'active'
              else k.created_by = auth.uid() and app.is_unit_member(p_tenant, k.unit_id) and k.created_at > app.now() - interval '90 days' end), '[]'::jsonb);
end $$;

-- Cópia fiel de 20261022000100_totem_flows.sql + recusa de encomenda recusada pelo morador (QR e manual),
-- depois do replay por p_request (idempotência) e antes de confirm_pickup. Mesma assinatura e grants.
create or replace function public.deliver_package(
  p_tenant uuid, p_package uuid, p_request uuid, p_qr text, p_picked_up_by text, p_recipient_kind text,
  p_signature_path text, p_item_photo_path text, p_manual_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; r jsonb;
begin
  perform app.require(app.is_staff(p_tenant));
  if p_request is null then raise exception 'Identificador da operação obrigatório.' using errcode = '22023'; end if;
  if coalesce(p_recipient_kind, '') not in ('morador', 'autorizado') then
    raise exception 'Informe se quem retira é o morador ou um recebedor autorizado.' using errcode = '22023';
  end if;
  select * into v from public.packages where tenant_id = p_tenant and id = p_package for update;
  if not found then raise exception 'Encomenda não encontrada.' using errcode = 'P0002'; end if;
  if v.pickup_request_id = p_request then
    return app.package_json(v) || jsonb_build_object('replayed', true,
      'protocol', (select protocol from public.receipts where tenant_id = p_tenant and package_id = v.id));
  end if;
  if v.status = 'RETIRADA' then raise exception 'Esta encomenda já foi retirada.' using errcode = 'P0001'; end if;
  if v.rejected_at is not null then raise exception 'Encomenda recusada pelo morador: devolva pela portaria.' using errcode = 'P0001'; end if;
  if not app.proof_ok(p_tenant, p_package, p_signature_path, 'signature', 'png') then
    raise exception 'Assinatura não recebida pelo servidor. Colete a assinatura e tente novamente.' using errcode = '22023';
  end if;
  if not app.proof_ok(p_tenant, p_package, p_item_photo_path, 'handover', 'jpg|png|webp') then
    raise exception 'Foto do item entregue é obrigatória. Fotografe e tente novamente.' using errcode = '22023';
  end if;
  update public.packages set picked_up_relation = p_recipient_kind where id = p_package;
  r := public.confirm_pickup(p_tenant, p_package, case when p_qr is null then 'manual' else 'qr' end, p_qr,
    p_picked_up_by, p_signature_path, p_item_photo_path, p_manual_reason);
  update public.packages set pickup_request_id = p_request where id = p_package;
  return r || jsonb_build_object('replayed', false, 'pickup_request_id', p_request);
end $$;
revoke all on function public.deliver_package(uuid, uuid, uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.deliver_package(uuid, uuid, uuid, text, text, text, text, text, text) to authenticated, service_role;

revoke all on function public.unit_residents_for_staff(uuid, uuid), public.package_mark_unidentified(uuid, uuid, text),
  public.list_unidentified_packages(uuid), public.package_destinate(uuid, uuid, uuid, text, uuid),
  public.resident_reject_package(uuid, uuid, text, text), public.staff_package_flags(uuid),
  public.delivery_keyword_save(uuid, uuid, uuid, text, text, text, text, date), public.delivery_keyword_cancel(uuid, uuid),
  public.delivery_keyword_mark_used(uuid, uuid), public.list_delivery_keywords(uuid, uuid) from public, anon;
grant execute on function public.unit_residents_for_staff(uuid, uuid), public.package_mark_unidentified(uuid, uuid, text),
  public.list_unidentified_packages(uuid), public.package_destinate(uuid, uuid, uuid, text, uuid),
  public.resident_reject_package(uuid, uuid, text, text), public.staff_package_flags(uuid),
  public.delivery_keyword_save(uuid, uuid, uuid, text, text, text, text, date), public.delivery_keyword_cancel(uuid, uuid),
  public.delivery_keyword_mark_used(uuid, uuid), public.list_delivery_keywords(uuid, uuid) to authenticated, service_role;
