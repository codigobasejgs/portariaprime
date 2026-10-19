-- =============================================================================
-- PORTARIA PRIME — 0500: RPCs de provisionamento, convites, equipe e unidades
-- Funções expostas ficam em public (PostgREST); helpers internos em app.
-- Toda função valida auth.uid(), vínculo ativo e tenant explicitamente.
-- =============================================================================

alter default privileges in schema public revoke execute on functions from public;

create or replace function app.email_verified() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null)
$$;

create or replace function app.current_email() returns text
language sql stable security definer set search_path = '' as $$
  select lower(email) from auth.users where id = auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- Provisionamento: condomínio + assinatura em teste de 1 mês de calendário.
-- Idempotente por p_request_id (duplo clique / retry devolvem o mesmo condomínio).
-- -----------------------------------------------------------------------------
create or replace function public.provision_tenant(
  p_request_id uuid, p_name text, p_slug text, p_document text, p_timezone text,
  p_plan_code text, p_cycle text, p_contact_phone text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tenant public.tenants;
  v_plan public.plans;
  v_price public.plan_prices;
  v_doc text := app.digits(p_document);
  v_tz text := coalesce(nullif(btrim(p_timezone), ''), 'America/Sao_Paulo');
  v_now timestamptz := app.now();
  v_end timestamptz;
begin
  perform app.require(v_uid is not null, 'Faça login para continuar.');
  perform app.require(app.email_verified(), 'Confirme seu e-mail antes de cadastrar o condomínio.');
  if p_request_id is null then raise exception 'Requisição inválida.' using errcode = '22023'; end if;

  select * into v_tenant from public.tenants where provision_request_id = p_request_id;
  if found then
    perform app.require(v_tenant.created_by = v_uid);
    return jsonb_build_object('tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'replayed', true);
  end if;

  if v_doc is null or length(v_doc) not in (11, 14) then
    raise exception 'Informe o CNPJ do condomínio (14 dígitos) ou CPF do responsável (11 dígitos).' using errcode = '22023';
  end if;
  if not app.valid_timezone(v_tz) then raise exception 'Fuso horário inválido.' using errcode = '22023'; end if;

  select * into v_plan from public.plans where code = p_plan_code and published and not is_custom;
  if not found then raise exception 'Plano indisponível.' using errcode = '22023'; end if;
  select * into v_price from public.plan_prices where plan_id = v_plan.id and cycle = p_cycle and active;
  if not found then raise exception 'Ciclo indisponível para este plano.' using errcode = '22023'; end if;

  -- Um mês grátis por condomínio (documento), mesmo após excluir e recriar.
  begin
    insert into public.trial_eligibility (key) values ('doc:' || v_doc);
  exception when unique_violation then
    raise exception 'Este condomínio já utilizou o mês gratuito. Fale com o suporte para contratar.' using errcode = 'P0001';
  end;

  begin
    insert into public.tenants (slug, name, document, contact_email, contact_phone, timezone, provision_request_id, created_by)
    values (lower(btrim(p_slug)), btrim(p_name), v_doc, app.current_email(), nullif(btrim(p_contact_phone), ''), v_tz, p_request_id, v_uid)
    returning * into v_tenant;
  exception when unique_violation then
    raise exception 'Este endereço (%) já está em uso. Escolha outro.', p_slug using errcode = 'P0001';
  end;
  update public.trial_eligibility set tenant_id = v_tenant.id where key = 'doc:' || v_doc;

  v_end := app.add_months(v_now, v_tz, 1);
  insert into public.subscriptions (tenant_id, status, plan_id, cycle, price_id, price_cents_snapshot, trial_started_at, trial_ends_at)
  values (v_tenant.id, 'trialing', v_plan.id, p_cycle, v_price.id, v_price.amount_cents, v_now, v_end);

  insert into public.tenant_memberships (tenant_id, user_id, role, permissions)
  values (v_tenant.id, v_uid, 'admin', array['team', 'approve', 'billing', 'settings']);
  insert into public.tenant_branding (tenant_id, display_name) values (v_tenant.id, v_tenant.name);
  insert into public.tenant_settings (tenant_id) values (v_tenant.id);
  insert into public.concierge_locations (tenant_id, name) values (v_tenant.id, 'Portaria principal');

  perform app.audit(v_tenant.id, 'tenant.provisioned', 'tenant', v_tenant.id::text,
    jsonb_build_object('plan', v_plan.code, 'cycle', p_cycle, 'trial_ends_at', v_end));
  return jsonb_build_object('tenant_id', v_tenant.id, 'slug', v_tenant.slug, 'trial_ends_at', v_end, 'replayed', false);
end $$;

-- Contexto do usuário: condomínios e papéis ativos (para o seletor de condomínio).
create or replace function public.my_context() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'email', app.current_email(),
    'email_verified', app.email_verified(),
    'platform_admin', app.is_platform_admin(),
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenant_id', t.id, 'slug', t.slug, 'name', t.name, 'tenant_status', t.status,
        'role', m.role, 'permissions', m.permissions, 'commercial_state', app.commercial_state(t.id))
        order by t.name)
      from public.tenant_memberships m join public.tenants t on t.id = m.tenant_id
      where m.user_id = auth.uid() and m.status = 'active'), '[]'::jsonb))
$$;

-- -----------------------------------------------------------------------------
-- Convites (uso único, expiração, vinculado ao e-mail e, para morador, à unidade)
-- O token cru só é devolvido uma vez; o banco guarda apenas o hash.
-- -----------------------------------------------------------------------------
create or replace function public.create_invitation(
  p_tenant uuid, p_email text, p_role text, p_unit uuid default null, p_permissions text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_token text := app.random_token(); v_inv public.invitations; v_email text := lower(btrim(p_email));
begin
  if p_role = 'morador' then
    perform app.require(app.has_perm(p_tenant, 'approve'));
    perform app.require(exists (select 1 from public.units where tenant_id = p_tenant and id = p_unit and active), 'Unidade inválida.');
  else
    perform app.require(app.has_perm(p_tenant, 'team'));
  end if;
  if p_role <> 'admin' and coalesce(array_length(p_permissions, 1), 0) > 0 then
    raise exception 'Permissões só se aplicam a administradores.' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;

  -- Revoga convites pendentes idênticos (reenvio gera novo token).
  update public.invitations set revoked_at = now()
   where tenant_id = p_tenant and email = v_email and role = p_role and unit_id is not distinct from p_unit
     and accepted_at is null and revoked_at is null;

  insert into public.invitations (tenant_id, email, role, permissions, unit_id, token_hash, expires_at, created_by)
  values (p_tenant, v_email, p_role, coalesce(p_permissions, '{}'), case when p_role = 'morador' then p_unit end,
          app.sha256_hex(v_token), app.now() + interval '7 days', auth.uid())
  returning * into v_inv;
  perform app.audit(p_tenant, 'invitation.created', 'invitation', v_inv.id::text, jsonb_build_object('role', p_role));
  return jsonb_build_object('invitation_id', v_inv.id, 'token', v_token, 'expires_at', v_inv.expires_at);
end $$;

create or replace function public.revoke_invitation(p_invitation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.invitations;
begin
  select * into v from public.invitations where id = p_invitation;
  perform app.require(found and (app.has_perm(v.tenant_id, 'team') or app.has_perm(v.tenant_id, 'approve')));
  update public.invitations set revoked_at = now() where id = p_invitation and accepted_at is null;
  perform app.audit(v.tenant_id, 'invitation.revoked', 'invitation', p_invitation::text);
end $$;

-- Prévia pública mínima do convite (nome do condomínio e papel), sem dados pessoais.
create or replace function public.invitation_preview(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('tenant_name', t.name, 'role', i.role,
    'valid', i.accepted_at is null and i.revoked_at is null and i.expires_at > app.now())
  from public.invitations i join public.tenants t on t.id = i.tenant_id
  where i.token_hash = app.sha256_hex(coalesce(p_token, ''))
$$;

create or replace function public.accept_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.invitations; v_uid uuid := auth.uid(); v_max int; v_count int; v_name text;
begin
  perform app.require(v_uid is not null, 'Faça login para aceitar o convite.');
  perform app.require(app.email_verified(), 'Confirme seu e-mail antes de aceitar o convite.');
  select * into v from public.invitations where token_hash = app.sha256_hex(coalesce(p_token, '')) for update;
  if not found or v.revoked_at is not null then raise exception 'Convite inválido ou revogado.' using errcode = 'P0001'; end if;
  if v.accepted_at is not null then raise exception 'Este convite já foi utilizado.' using errcode = 'P0001'; end if;
  if v.expires_at <= app.now() then raise exception 'Convite expirado. Peça um novo ao síndico.' using errcode = 'P0001'; end if;
  if v.email <> app.current_email() then
    raise exception 'Este convite foi enviado para outro e-mail. Entre com a conta de %.', v.email using errcode = '42501';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
  values (v.tenant_id, v_uid, v.role, v.permissions, 'active')
  on conflict (tenant_id, user_id, role) do update set status = 'active', permissions = excluded.permissions, updated_at = now();

  if v.role = 'morador' then
    perform 1 from public.units where id = v.unit_id and tenant_id = v.tenant_id and active for update;
    if not found then raise exception 'A unidade deste convite não está mais ativa.' using errcode = 'P0001'; end if;
    select max_residents_per_unit into v_max from public.tenant_settings where tenant_id = v.tenant_id;
    select count(*) into v_count from public.unit_memberships
     where unit_id = v.unit_id and status = 'active' and user_id <> v_uid;
    if v_count >= coalesce(v_max, 10) then
      raise exception 'A unidade já atingiu o limite de % moradores.', v_max using errcode = 'P0001';
    end if;
    insert into public.unit_memberships (tenant_id, unit_id, user_id)
    values (v.tenant_id, v.unit_id, v_uid)
    on conflict (unit_id, user_id) do update set status = 'active';
    select coalesce(full_name, split_part(v.email, '@', 1)) into v_name from public.profiles where id = v_uid;
    if not exists (select 1 from public.resident_contacts where unit_id = v.unit_id and user_id = v_uid) then
      insert into public.resident_contacts (tenant_id, unit_id, user_id, name, email)
      values (v.tenant_id, v.unit_id, v_uid, coalesce(v_name, 'Morador'), v.email);
    end if;
  end if;

  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v.id;
  perform app.audit(v.tenant_id, 'invitation.accepted', 'invitation', v.id::text, jsonb_build_object('role', v.role));
  return jsonb_build_object('tenant_id', v.tenant_id, 'role', v.role,
    'slug', (select slug from public.tenants where id = v.tenant_id));
end $$;

-- Revogar/reativar membro da equipe ou morador (vale imediatamente na RLS).
create or replace function public.set_membership_status(p_membership uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.tenant_memberships;
begin
  select * into m from public.tenant_memberships where id = p_membership for update;
  if not found then raise exception 'Vínculo não encontrado.' using errcode = 'P0002'; end if;
  perform app.require(case when m.role = 'morador' then app.has_perm(m.tenant_id, 'approve') else app.has_perm(m.tenant_id, 'team') end);
  if p_status not in ('active', 'revoked') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if m.user_id = auth.uid() and p_status = 'revoked' then raise exception 'Você não pode revogar o próprio acesso.' using errcode = 'P0001'; end if;
  if m.role = 'admin' and p_status = 'revoked' and not exists (
    select 1 from public.tenant_memberships where tenant_id = m.tenant_id and role = 'admin' and status = 'active'
      and id <> m.id and 'team' = any (permissions)) then
    raise exception 'O condomínio precisa de ao menos um administrador com gestão de equipe.' using errcode = 'P0001';
  end if;
  update public.tenant_memberships set status = p_status, updated_at = now() where id = m.id;
  if m.role = 'morador' and p_status = 'revoked' then
    update public.unit_memberships set status = 'revoked' where tenant_id = m.tenant_id and user_id = m.user_id;
    delete from public.push_subscriptions where tenant_id = m.tenant_id and user_id = m.user_id;
  end if;
  perform app.audit(m.tenant_id, 'membership.' || p_status, 'membership', m.id::text, jsonb_build_object('role', m.role));
end $$;

-- Morador que se mudou: remove o vínculo com a unidade específica.
create or replace function public.revoke_unit_member(p_unit_membership uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare um public.unit_memberships;
begin
  select * into um from public.unit_memberships where id = p_unit_membership for update;
  perform app.require(found and app.has_perm(um.tenant_id, 'approve'));
  update public.unit_memberships set status = 'revoked' where id = um.id;
  update public.resident_contacts set active = false where unit_id = um.unit_id and user_id = um.user_id;
  perform app.audit(um.tenant_id, 'unit_member.revoked', 'unit_membership', um.id::text);
end $$;

-- Equipe e moradores com nome/e-mail (somente para quem administra).
create or replace function public.list_members(p_tenant uuid) returns table (
  membership_id uuid, user_id uuid, role text, permissions text[], status text, full_name text, email text, units jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'team') or app.has_perm(p_tenant, 'approve'));
  return query
  select m.id, m.user_id, m.role, m.permissions, m.status, p.full_name, u.email::text,
    coalesce((select jsonb_agg(jsonb_build_object('unit_membership_id', um.id, 'unit_id', un.id, 'block', un.block, 'label', un.label, 'status', um.status))
       from public.unit_memberships um join public.units un on un.id = um.unit_id
      where um.tenant_id = m.tenant_id and um.user_id = m.user_id), '[]'::jsonb)
  from public.tenant_memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  where m.tenant_id = p_tenant
  order by m.role, p.full_name;
end $$;

-- -----------------------------------------------------------------------------
-- Importação de unidades (CSV já convertido em JSON pelo navegador).
-- p_dry_run = true: só valida e devolve erros por linha. Gravação é tudo-ou-nada.
-- -----------------------------------------------------------------------------
create or replace function public.import_units(p_tenant uuid, p_rows jsonb, p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb; i int := 0; v_block text; v_label text; v_key text;
  v_errors jsonb := '[]'::jsonb; v_seen text[] := '{}'; v_ok int := 0;
begin
  perform app.require(app.is_admin(p_tenant));
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Envie até 2000 linhas.' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    v_block := nullif(btrim(coalesce(r ->> 'block', '')), '');
    v_label := nullif(btrim(coalesce(r ->> 'label', '')), '');
    v_key := upper(coalesce(v_block, '')) || '|' || upper(coalesce(v_label, ''));
    if v_label is null then
      v_errors := v_errors || jsonb_build_object('line', i, 'error', 'Unidade vazia');
    elsif length(v_label) > 30 or length(coalesce(v_block, '')) > 30 then
      v_errors := v_errors || jsonb_build_object('line', i, 'error', 'Texto longo demais (máx. 30)');
    elsif v_key = any (v_seen) then
      v_errors := v_errors || jsonb_build_object('line', i, 'error', 'Duplicada no arquivo');
    elsif exists (select 1 from public.units where tenant_id = p_tenant
        and upper(btrim(coalesce(block, ''))) = upper(coalesce(v_block, '')) and upper(btrim(label)) = upper(v_label)) then
      v_errors := v_errors || jsonb_build_object('line', i, 'error', 'Já cadastrada');
    else
      v_ok := v_ok + 1;
    end if;
    v_seen := v_seen || v_key;
  end loop;

  if p_dry_run or jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('valid', v_ok, 'errors', v_errors, 'written', 0);
  end if;

  insert into public.units (tenant_id, block, label)
  select p_tenant, nullif(btrim(e ->> 'block'), ''), btrim(e ->> 'label') from jsonb_array_elements(p_rows) e;
  perform app.audit(p_tenant, 'units.imported', 'unit', null, jsonb_build_object('count', v_ok));
  return jsonb_build_object('valid', v_ok, 'errors', '[]'::jsonb, 'written', v_ok);
end $$;
