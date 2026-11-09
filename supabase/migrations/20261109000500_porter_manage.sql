-- Gestão do porteiro pelo síndico: editar dados, excluir e trocar senha (inclusive do porteiro com biometria).
-- Só quem tem 'team', com login recente, e só contas que são exclusivamente porteiro deste condomínio
-- (um síndico nunca mexe em conta usada em outro condomínio ou com outro papel).
create function app.porter_manage_check(p_tenant uuid, p_user uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'team'), 'Somente quem gerencia a equipe pode alterar porteiros.');
  perform app.mdm_require_recent_auth();
  perform app.require(p_user is distinct from auth.uid(), 'Você não pode alterar o próprio acesso por aqui.');
  perform app.require(exists (select 1 from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role = 'porteiro'),
    'Porteiro não encontrado neste condomínio.');
  perform app.require(not exists (select 1 from public.tenant_memberships where user_id = p_user and (tenant_id <> p_tenant or role <> 'porteiro')),
    'Esta conta tem outro vínculo (outro condomínio ou outro papel) e não pode ser alterada por aqui.');
end $$;

-- Dados cadastrais dos porteiros com biometria (documento só mascarado).
create function public.porter_team_list(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'team') then coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'full_name', full_name,
    'phone', phone, 'document_type', document_type, 'document_masked', document_masked)), '[]'::jsonb) end
  from public.porter_identities where tenant_id = p_tenant
$$;

-- Nome e telefone de qualquer porteiro; documento só de quem tem biometria (é o login dele).
-- Documento: mesmo hash do servidor (tenant:tipo:número). Encomendas antigas mantêm o nome registrado na época.
create function public.porter_update(p_tenant uuid, p_user uuid, p_full_name text, p_phone text default null,
  p_document_type text default null, p_document text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.porter_identities; v_name text := btrim(coalesce(p_full_name, '')); v_phone text := app.digits(p_phone);
  v_doc text := upper(regexp_replace(coalesce(p_document, ''), '[.[:space:]/-]', '', 'g')); v_hash text; v_changed text[] := '{}';
begin
  perform app.porter_manage_check(p_tenant, p_user);
  perform app.require(length(v_name) between 2 and 120, 'Informe o nome completo (2 a 120 caracteres).');
  perform app.require(v_phone is null or length(v_phone) between 10 and 13, 'Telefone inválido.');
  select * into i from public.porter_identities where tenant_id = p_tenant and user_id = p_user for update;
  if v_doc <> '' then
    perform app.require(i.user_id is not null, 'Documento só existe para porteiro com cadastro biométrico.');
    perform app.require(case p_document_type when 'CPF' then app.cpf_valid(v_doc) when 'CNH' then app.cnh_valid(v_doc)
      when 'RG' then v_doc ~ '^[A-Z0-9]{5,20}$' else false end, 'Documento inválido.');
    v_hash := app.sha256_hex(p_tenant::text || ':' || p_document_type || ':' || v_doc);
    if v_hash <> i.document_hash then
      perform app.require(not exists (select 1 from public.porter_identities where tenant_id = p_tenant and document_hash = v_hash),
        'Já existe porteiro com este documento.');
      update public.porter_identities set document_type = p_document_type, document_hash = v_hash,
        document_masked = p_document_type || ' •••' || right(v_doc, 4) where tenant_id = p_tenant and user_id = p_user;
      v_changed := v_changed || 'document'::text;
    end if;
  end if;
  if i.user_id is not null then
    if i.full_name <> v_name then v_changed := v_changed || 'name'::text; end if;
    if v_phone is not null and i.phone <> v_phone then v_changed := v_changed || 'phone'::text; end if;
    update public.porter_identities set full_name = v_name, phone = coalesce(v_phone, phone) where tenant_id = p_tenant and user_id = p_user;
  end if;
  update public.profiles set full_name = v_name, phone = coalesce(v_phone, phone) where id = p_user;
  perform app.audit(p_tenant, 'porter.updated', 'user', p_user::text, jsonb_build_object('changed', v_changed));
  return jsonb_build_object('user_id', p_user, 'full_name', v_name);
end $$;

-- Exclusão: some da equipe e perde o acesso na hora. O trigger porter_remove_face já agenda a eliminação da
-- referência facial e encerra turnos. Tentativas de login e auditoria ficam (retenção de 90 dias das fotos).
-- A conta Auth não é apagada: encomendas antigas continuam apontando para quem as recebeu.
create function public.porter_delete(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.porter_identities; v_name text;
begin
  perform app.porter_manage_check(p_tenant, p_user);
  select * into i from public.porter_identities where tenant_id = p_tenant and user_id = p_user;
  select coalesce(i.full_name, p.full_name) into v_name from public.profiles p where p.id = p_user;
  delete from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role = 'porteiro';
  delete from public.porter_identities where tenant_id = p_tenant and user_id = p_user;
  delete from public.staff_login_accounts where tenant_id = p_tenant and user_id = p_user;
  delete from public.push_subscriptions where tenant_id = p_tenant and user_id = p_user;
  -- Sem outro vínculo (garantido acima): derruba sessões abertas.
  if to_regclass('auth.sessions') is not null then execute 'delete from auth.sessions where user_id = $1' using p_user; end if;
  if to_regclass('auth.refresh_tokens') is not null then execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user; end if;
  perform app.audit(p_tenant, 'porter.deleted', 'user', p_user::text,
    jsonb_build_object('name', v_name, 'document', i.document_masked, 'biometric', i.user_id is not null));
  return jsonb_build_object('deleted', true);
end $$;

-- Troca de senha pelo síndico: além dos acessos criados pelo condomínio, vale para o porteiro com biometria
-- (a conta dele também nasceu pelo link do condomínio). Resto idêntico a 20261104000100.
create or replace function public.app_staff_password_check(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.tenant_memberships;
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  perform app.mdm_require_recent_auth();
  if p_user = auth.uid() then raise exception 'Para trocar a própria senha, use "Esqueci minha senha" ou Minha conta.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.staff_login_accounts where user_id = p_user and tenant_id = p_tenant)
     and not exists (select 1 from public.porter_identities where user_id = p_user and tenant_id = p_tenant) then
    raise exception 'Só é possível redefinir a senha de acessos criados pelo condomínio.' using errcode = '42501';
  end if;
  -- A conta não pode ter vínculo com outro condomínio (senão um síndico mexeria em acesso alheio).
  if exists (select 1 from public.tenant_memberships where user_id = p_user and tenant_id <> p_tenant) then
    raise exception 'Esta conta também é usada em outro condomínio; a senha não pode ser trocada por aqui.' using errcode = '42501';
  end if;
  select * into m from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role <> 'morador' order by role limit 1;
  if not found or not app.can_grant_invitation(p_tenant, auth.uid(), m.role, m.permissions) then
    raise exception 'Sem permissão para alterar este acesso.' using errcode = '42501';
  end if;
  return jsonb_build_object('user_id', p_user);
end $$;

revoke all on function app.porter_manage_check(uuid, uuid) from public, anon, authenticated;
revoke all on function public.porter_team_list(uuid), public.porter_update(uuid, uuid, text, text, text, text),
  public.porter_delete(uuid, uuid) from public, anon;
grant execute on function public.porter_team_list(uuid), public.porter_update(uuid, uuid, text, text, text, text),
  public.porter_delete(uuid, uuid) to authenticated;
