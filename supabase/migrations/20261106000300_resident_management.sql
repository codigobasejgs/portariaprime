-- Gestão de moradores pelo síndico (permissão "approve"): consultar, editar e excluir cadastro do condomínio,
-- editar/cancelar solicitações pendentes e trocar a unidade de convites pendentes.
--
-- Regras:
-- * Identidade global (auth.users, profiles, e-mail de login) nunca é alterada aqui: o síndico edita só o
--   contato do morador NESTE condomínio (resident_contacts). O e-mail de login é exibido apenas para leitura.
-- * Troca de unidade cria um vínculo NOVO (created_at = agora): comprovantes antigos da nova unidade não ficam
--   visíveis (app.can_see_receipt exige vínculo anterior à emissão). Reativação também reinicia o vínculo.
-- * Limite de moradores por unidade vale na troca de unidade e na reativação.
-- * Excluir remove o cadastro deste condomínio (vínculos, contatos, avisos, push) e cancela solicitações,
--   convites e rascunhos deste condomínio. Encomendas, comprovantes, auditoria e aceites (append-only) ficam.

-- Telefone do contato: celular BR (DDD) ou internacional com "+DDI" (10 a 15 dígitos). Nulo se vazio.
create or replace function app.contact_phone(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text := app.digits(p);
begin
  if d is null then return null; end if;
  if btrim(p) like '+%' and left(d, 2) <> '55' then
    if length(d) between 10 and 15 then return '+' || d; end if;
    raise exception 'Telefone internacional inválido: use + DDI e o número (10 a 15 dígitos).' using errcode = '22023';
  end if;
  return app.phone_e164(p);
end $$;

create or replace function public.resident_admin_get(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m public.tenant_memberships; c public.resident_contacts;
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova moradores pode gerenciar cadastros.');
  select * into m from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role = 'morador';
  if not found then raise exception 'Morador não encontrado neste condomínio.' using errcode = 'P0002'; end if;
  select * into c from public.resident_contacts where tenant_id = p_tenant and user_id = p_user
   order by active desc, created_at desc limit 1;
  return jsonb_build_object(
    'user_id', m.user_id, 'membership_id', m.id, 'status', m.status,
    'full_name', coalesce(c.name, (select full_name from public.profiles where id = p_user)),
    'login_email', (select lower(email) from auth.users where id = p_user),
    'contact_email', c.email, 'contact_phone', c.phone,
    'shared_account', exists (select 1 from public.tenant_memberships x where x.user_id = p_user and (x.tenant_id <> p_tenant or x.role <> 'morador')),
    'units', coalesce((select jsonb_agg(jsonb_build_object('unit_membership_id', um.id, 'unit_id', u.id, 'block', u.block, 'label', u.label,
                'status', um.status, 'relation', um.relation, 'created_at', um.created_at) order by um.created_at)
              from public.unit_memberships um join public.units u on u.id = um.unit_id
             where um.tenant_id = p_tenant and um.user_id = p_user), '[]'::jsonb),
    'pending_request', (select jsonb_build_object('id', r.id, 'block_text', r.block_text, 'unit_text', r.unit_text, 'unit_id', r.unit_id, 'created_at', r.created_at)
              from public.access_requests r where r.tenant_id = p_tenant and r.user_id = p_user and r.status = 'pending'));
end $$;

create or replace function public.resident_update(
  p_tenant uuid, p_user uuid, p_full_name text, p_phone text, p_email text, p_unit uuid,
  p_from_unit uuid default null, p_status text default 'active'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m public.tenant_memberships; v_name text := btrim(coalesce(p_full_name, '')); v_phone text;
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), ''); v_from uuid; v_to uuid; v_n int;
  v_link public.unit_memberships; v_relation text := 'morador'; v_moved boolean := false; v_max int; v_count int; v_contact uuid;
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova moradores pode gerenciar cadastros.');
  -- NULL não pode escapar de "not in".
  if p_status is null or p_status not in ('active', 'pending', 'revoked') then
    raise exception 'Situação inválida.' using errcode = '22023';
  end if;
  if length(v_name) not between 2 and 120 then raise exception 'Informe o nome (2 a 120 caracteres).' using errcode = '22023'; end if;
  v_phone := app.contact_phone(p_phone);
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'E-mail de contato inválido.' using errcode = '22023';
  end if;

  select * into m from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role = 'morador' for update;
  if not found then raise exception 'Morador não encontrado neste condomínio.' using errcode = 'P0002'; end if;
  if p_user = auth.uid() and p_status <> 'active' then
    raise exception 'Você não pode revogar o próprio acesso.' using errcode = 'P0001';
  end if;

  -- Origem: informada (tem de ser um vínculo deste morador neste condomínio) ou o único vínculo existente.
  if p_from_unit is not null then
    select * into v_link from public.unit_memberships where tenant_id = p_tenant and user_id = p_user and unit_id = p_from_unit for update;
    if not found then raise exception 'Vínculo de origem não encontrado para este morador.' using errcode = 'P0002'; end if;
    v_from := p_from_unit;
  else
    select count(*) into v_n from public.unit_memberships where tenant_id = p_tenant and user_id = p_user;
    if v_n > 1 then raise exception 'Este morador tem mais de uma unidade: informe de qual unidade ele sai.' using errcode = '22023'; end if;
    select * into v_link from public.unit_memberships where tenant_id = p_tenant and user_id = p_user for update;
    v_from := v_link.unit_id;
  end if;
  v_relation := coalesce(v_link.relation, 'morador');
  v_to := coalesce(p_unit, v_from);
  if v_to is null then raise exception 'Escolha a unidade.' using errcode = '22023'; end if;
  if v_to is distinct from v_from or p_status = 'active' then
    perform 1 from public.units where tenant_id = p_tenant and id = v_to and active for update;
    if not found then raise exception 'Unidade inválida ou desativada.' using errcode = '22023'; end if;
  elsif not exists (select 1 from public.units where tenant_id = p_tenant and id = v_to) then
    raise exception 'Unidade inválida.' using errcode = '22023';
  end if;
  v_moved := v_to is distinct from v_from;

  -- Limite por unidade: troca de unidade e (re)ativação.
  if p_status = 'active' and (v_moved or v_link.status is distinct from 'active' or m.status <> 'active') then
    select max_residents_per_unit into v_max from public.tenant_settings where tenant_id = p_tenant;
    select count(*) into v_count from public.unit_memberships where unit_id = v_to and status = 'active' and user_id <> p_user;
    if v_count >= coalesce(v_max, 10) then
      raise exception 'A unidade já atingiu o limite de % moradores.', coalesce(v_max, 10) using errcode = 'P0001';
    end if;
  end if;

  if v_moved then
    -- Vínculo novo (created_at = agora): nada retroativo da unidade de destino; a origem deixa de valer.
    if v_from is not null then
      delete from public.unit_memberships where tenant_id = p_tenant and user_id = p_user and unit_id = v_from;
    end if;
    delete from public.unit_memberships where tenant_id = p_tenant and user_id = p_user and unit_id = v_to;
    insert into public.unit_memberships (tenant_id, unit_id, user_id, relation, status)
    values (p_tenant, v_to, p_user, v_relation, case when p_status = 'active' then 'active' else 'revoked' end);
    -- Contato acompanha a pessoa: o da unidade de origem sai (deixa de receber avisos de lá).
    update public.resident_contacts set unit_id = v_to
     where id = (select id from public.resident_contacts where tenant_id = p_tenant and user_id = p_user and unit_id = v_from
                  order by active desc, created_at desc limit 1)
       and not exists (select 1 from public.resident_contacts where tenant_id = p_tenant and user_id = p_user and unit_id = v_to);
    delete from public.resident_contacts where tenant_id = p_tenant and user_id = p_user and unit_id = v_from;
  elsif p_status = 'active' then
    -- Reativação reinicia o vínculo (comprovantes emitidos enquanto estava fora não ficam visíveis).
    update public.unit_memberships set created_at = case when status = 'active' then created_at else now() end, status = 'active'
     where tenant_id = p_tenant and user_id = p_user and unit_id = v_to;
  end if;

  update public.tenant_memberships set status = p_status, updated_at = now() where id = m.id;
  if p_status <> 'active' then
    update public.unit_memberships set status = 'revoked' where tenant_id = p_tenant and user_id = p_user;
    update public.resident_contacts set active = false where tenant_id = p_tenant and user_id = p_user;
    delete from public.push_subscriptions where tenant_id = p_tenant and user_id = p_user
      and not exists (select 1 from public.tenant_memberships x where x.tenant_id = p_tenant and x.user_id = p_user and x.role <> 'morador' and x.status = 'active');
  end if;

  -- Contato do morador neste condomínio (nunca o perfil global nem o e-mail de login).
  select id into v_contact from public.resident_contacts where tenant_id = p_tenant and user_id = p_user and unit_id = v_to
   order by active desc, created_at desc limit 1;
  if v_contact is null then
    insert into public.resident_contacts (tenant_id, unit_id, user_id, name, phone, email, active)
    values (p_tenant, v_to, p_user, v_name, v_phone, v_email, p_status = 'active');
  else
    update public.resident_contacts set name = v_name, phone = v_phone, email = v_email, active = (p_status = 'active') where id = v_contact;
  end if;

  perform app.audit(p_tenant, 'resident.updated', 'membership', m.id::text,
    jsonb_build_object('status', p_status, 'previous_status', m.status, 'unit_changed', v_moved, 'from_unit', v_from, 'to_unit', v_to));
  return public.resident_admin_get(p_tenant, p_user);
end $$;

create or replace function public.resident_delete(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.tenant_memberships; v_email text; v_phones text[]; v_staff boolean; v_req int; v_inv int; v_jobs int;
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova moradores pode gerenciar cadastros.');
  if p_user = auth.uid() then raise exception 'Você não pode excluir o próprio cadastro.' using errcode = 'P0001'; end if;
  select * into m from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role = 'morador' for update;
  if not found then raise exception 'Morador não encontrado neste condomínio.' using errcode = 'P0002'; end if;
  select lower(email) into v_email from auth.users where id = p_user;
  v_staff := exists (select 1 from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role <> 'morador');
  select coalesce(array_agg(distinct x.phone) filter (where x.phone is not null), '{}') into v_phones from (
    select phone from public.resident_contacts where tenant_id = p_tenant and user_id = p_user
    union all select phone from public.access_requests where tenant_id = p_tenant and user_id = p_user) x;

  -- Avisos ainda não enviados a este morador neste condomínio (não alcança destinatário de outra pessoa ativa).
  update public.notification_jobs j set status = 'disabled', updated_at = now()
   where j.tenant_id = p_tenant and j.status = 'queued'
     and j.event in ('package_received', 'package_picked_up', 'package_reminder', 'access_received', 'access_decision', 'portal_welcome', 'invitation')
     and (j.recipient = p_user::text or j.recipient = v_email or j.recipient = any (v_phones))
     and not exists (select 1 from public.resident_contacts c where c.tenant_id = p_tenant and c.active
                      and c.user_id is distinct from p_user and (c.phone = j.recipient or c.email = j.recipient));
  get diagnostics v_jobs = row_count;

  if v_staff then
    delete from public.notifications where tenant_id = p_tenant and user_id = p_user and package_id is not null;
  else
    delete from public.notifications where tenant_id = p_tenant and user_id = p_user;
    delete from public.push_subscriptions where tenant_id = p_tenant and user_id = p_user;
  end if;
  delete from public.unit_memberships where tenant_id = p_tenant and user_id = p_user;
  delete from public.resident_contacts where tenant_id = p_tenant and user_id = p_user;

  -- Sem reentrada involuntária: pedido pendente cancelado (não apagado: os aceites apontam para ele),
  -- convites e rascunho deste condomínio invalidados.
  update public.access_requests set status = 'cancelled', decided_by = auth.uid(), decided_at = now(), reason = 'Cadastro excluído pela administração.'
   where tenant_id = p_tenant and user_id = p_user and status = 'pending';
  get diagnostics v_req = row_count;
  update public.invitations set revoked_at = now()
   where tenant_id = p_tenant and role = 'morador' and email = v_email and accepted_at is null and revoked_at is null;
  get diagnostics v_inv = row_count;
  delete from public.resident_signup_drafts where user_id = p_user and tenant_id = p_tenant;

  delete from public.tenant_memberships where id = m.id;
  perform app.audit(p_tenant, 'resident.deleted', 'membership', m.id::text,
    jsonb_build_object('user_id', p_user, 'cancelled_requests', v_req, 'revoked_invitations', v_inv, 'disabled_jobs', v_jobs));
  return jsonb_build_object('deleted', true, 'cancelled_requests', v_req, 'revoked_invitations', v_inv);
end $$;

-- Solicitação pendente: corrigir nome, celular, bloco/unidade informados e a unidade encontrada.
-- Não mexe no aceite do termo nem na confirmação de e-mail; aprovar continua sendo decide_access_request.
create or replace function public.access_request_admin_update(
  p_request uuid, p_full_name text, p_phone text, p_block text, p_unit_text text, p_unit uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.access_requests; v_name text := btrim(coalesce(p_full_name, '')); v_phone text;
  v_block text := nullif(btrim(coalesce(p_block, '')), ''); v_unit text := btrim(coalesce(p_unit_text, ''));
begin
  select * into r from public.access_requests where id = p_request for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  perform app.require(app.has_perm(r.tenant_id, 'approve'), 'Somente quem aprova moradores pode gerenciar cadastros.');
  if r.status <> 'pending' then raise exception 'Só solicitações pendentes podem ser editadas.' using errcode = 'P0001'; end if;
  if length(v_name) not between 2 and 120 then raise exception 'Informe o nome (2 a 120 caracteres).' using errcode = '22023'; end if;
  if length(v_unit) not between 1 and 30 or length(coalesce(v_block, '')) > 30 then
    raise exception 'Bloco e unidade: até 30 caracteres (unidade obrigatória).' using errcode = '22023';
  end if;
  v_phone := app.contact_phone(p_phone);
  if p_unit is not null and not exists (select 1 from public.units where tenant_id = r.tenant_id and id = p_unit and active) then
    raise exception 'Unidade inválida ou desativada.' using errcode = '22023';
  end if;
  update public.access_requests set full_name = v_name, phone = v_phone, block_text = v_block, unit_text = v_unit, unit_id = p_unit where id = r.id;
  perform app.audit(r.tenant_id, 'access_request.edited', 'access_request', r.id::text, jsonb_build_object('unit_id', p_unit));
  return jsonb_build_object('id', r.id, 'status', 'pending');
end $$;

-- Cancelar solicitação pendente (sem notificar; o rascunho do cadastro deste condomínio também sai).
create or replace function public.access_request_cancel(p_request uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.access_requests; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into r from public.access_requests where id = p_request for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  perform app.require(app.has_perm(r.tenant_id, 'approve'), 'Somente quem aprova moradores pode gerenciar cadastros.');
  if r.status <> 'pending' then raise exception 'Só solicitações pendentes podem ser canceladas.' using errcode = 'P0001'; end if;
  if length(coalesce(v_reason, '')) > 300 then raise exception 'Motivo: até 300 caracteres.' using errcode = '22023'; end if;
  update public.access_requests set status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
    reason = coalesce(v_reason, 'Cancelada pela administração.') where id = r.id;
  delete from public.resident_signup_drafts where user_id = r.user_id and tenant_id = r.tenant_id;
  perform app.audit(r.tenant_id, 'access_request.cancelled', 'access_request', r.id::text);
  return jsonb_build_object('id', r.id, 'status', 'cancelled');
end $$;

-- Convite de morador pendente: trocar a unidade (e-mail diferente = revogar e enviar novo convite).
create or replace function public.invitation_update(p_invitation uuid, p_unit uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invitations;
begin
  select * into v from public.invitations where id = p_invitation for update;
  if not found then raise exception 'Convite não encontrado.' using errcode = 'P0002'; end if;
  perform app.require(app.has_perm(v.tenant_id, 'approve'), 'Somente quem aprova moradores pode gerenciar cadastros.');
  if v.role <> 'morador' then raise exception 'Só convites de morador.' using errcode = '22023'; end if;
  if v.accepted_at is not null or v.revoked_at is not null or v.expires_at <= app.now() then
    raise exception 'Convite já usado, revogado ou expirado.' using errcode = 'P0001';
  end if;
  if p_unit is null or not exists (select 1 from public.units where tenant_id = v.tenant_id and id = p_unit and active) then
    raise exception 'Unidade inválida ou desativada.' using errcode = '22023';
  end if;
  update public.invitations set unit_id = p_unit where id = v.id;
  perform app.audit(v.tenant_id, 'invitation.updated', 'invitation', v.id::text, jsonb_build_object('unit_id', p_unit));
  return jsonb_build_object('id', v.id, 'unit_id', p_unit);
end $$;

revoke all on function app.contact_phone(text) from public, anon, authenticated;
revoke all on function public.resident_admin_get(uuid, uuid), public.resident_update(uuid, uuid, text, text, text, uuid, uuid, text),
  public.resident_delete(uuid, uuid), public.access_request_admin_update(uuid, text, text, text, text, uuid),
  public.access_request_cancel(uuid, text), public.invitation_update(uuid, uuid) from public, anon;
grant execute on function public.resident_admin_get(uuid, uuid), public.resident_update(uuid, uuid, text, text, text, uuid, uuid, text),
  public.resident_delete(uuid, uuid), public.access_request_admin_update(uuid, text, text, text, text, uuid),
  public.access_request_cancel(uuid, text), public.invitation_update(uuid, uuid) to authenticated;
