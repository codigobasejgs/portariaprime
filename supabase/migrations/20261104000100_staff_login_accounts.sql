-- Acessos da equipe com e-mail e senha definidos pelo síndico (sem convite por e-mail).
-- Para porteiros/administradores com e-mail só de login (sem caixa de entrada): a conta nasce confirmada
-- pelo backend e já com o vínculo. Quem cria precisa de 'team' e só delega permissões que possui
-- (mesma regra do convite). Nada aqui envia e-mail; recuperação de senha fica com o síndico.
--
-- Fluxo (api/team/[action].ts):
--   1. app_staff_account_check  (como o síndico): valida permissão, papel, e-mail e conflito; registra a intenção.
--   2. Auth Admin API (service role): cria o usuário confirmado com a senha informada.
--   3. app_staff_account_link   (service role): cria o vínculo da intenção para esse usuário, uma única vez.

create table public.staff_account_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254),
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  role text not null check (role in ('admin', 'porteiro')),
  permissions text[] not null default '{}',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  user_id uuid references auth.users(id) on delete set null,
  linked_at timestamptz
);
alter table public.staff_account_requests enable row level security;
revoke all on public.staff_account_requests from public, anon, authenticated;
grant all on public.staff_account_requests to service_role;

-- Contas criadas assim (o síndico redefine a senha; não há e-mail de recuperação).
create table public.staff_login_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  password_changed_at timestamptz,
  password_changed_by uuid references auth.users(id) on delete set null
);
alter table public.staff_login_accounts enable row level security;
revoke all on public.staff_login_accounts from public, anon, authenticated;
grant all on public.staff_login_accounts to service_role;

-- Passo 1 (como o síndico). Conta existente com esse e-mail: recusa (use o convite, que exige o dono do e-mail).
create or replace function public.app_staff_account_check(p_tenant uuid, p_email text, p_full_name text, p_role text, p_permissions text[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_id uuid; v_perms text[] := coalesce(p_permissions, '{}');
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  perform app.mdm_require_recent_auth();
  if p_role not in ('admin', 'porteiro') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
  if p_role = 'porteiro' and coalesce(array_length(v_perms, 1), 0) > 0 then
    raise exception 'Permissões só se aplicam a administradores.' using errcode = '22023';
  end if;
  if not v_perms <@ array['team', 'approve', 'settings', 'billing'] then raise exception 'Permissão desconhecida.' using errcode = '22023'; end if;
  if not app.can_grant_invitation(p_tenant, auth.uid(), p_role, v_perms) then
    raise exception 'Sem permissão para criar este acesso. Você só pode delegar permissões que possui.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tenants where id = p_tenant and status = 'active') then
    raise exception 'Condomínio indisponível.' using errcode = 'P0001';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'Informe o nome de quem vai usar o acesso.' using errcode = '22023'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'Já existe uma conta com este e-mail. Para uma pessoa que já tem conta, use "Convidar por e-mail".' using errcode = '23505';
  end if;
  -- Limite de abuso: 30 acessos criados por condomínio por dia.
  if (select count(*) from public.staff_account_requests where tenant_id = p_tenant and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Muitos acessos criados hoje. Tente novamente amanhã.' using errcode = 'P0001';
  end if;
  insert into public.staff_account_requests (tenant_id, email, full_name, role, permissions, created_by)
  values (p_tenant, v_email, left(btrim(p_full_name), 120), p_role, v_perms, auth.uid()) returning id into v_id;
  return jsonb_build_object('request_id', v_id, 'email', v_email);
end $$;

-- Passo 3 (service role, chamado pelo backend logo após criar o usuário). Uso único e com prazo.
create or replace function public.app_staff_account_link(p_request uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.staff_account_requests; v_email text;
begin
  select * into r from public.staff_account_requests where id = p_request for update;
  if not found then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  if r.linked_at is not null then raise exception 'Solicitação já utilizada.' using errcode = 'P0001'; end if;
  if r.expires_at <= now() then raise exception 'Solicitação expirada. Tente novamente.' using errcode = 'P0001'; end if;
  select lower(email) into v_email from auth.users where id = p_user;
  if v_email is distinct from r.email then raise exception 'Conta não corresponde à solicitação.' using errcode = '42501'; end if;
  -- Revalida quem pediu no momento do vínculo (pode ter perdido a permissão nesse intervalo).
  if not app.can_grant_invitation(r.tenant_id, r.created_by, r.role, r.permissions) then
    raise exception 'Quem criou o acesso não tem mais permissão para concedê-lo.' using errcode = '42501';
  end if;
  insert into public.tenant_memberships (tenant_id, user_id, role, permissions, status)
  values (r.tenant_id, p_user, r.role, r.permissions, 'active')
  on conflict (tenant_id, user_id, role) do update set status = 'active', permissions = excluded.permissions, updated_at = now();
  update public.profiles set full_name = r.full_name where id = p_user;
  insert into public.staff_login_accounts (user_id, tenant_id, created_by) values (p_user, r.tenant_id, r.created_by)
  on conflict (user_id) do nothing;
  update public.staff_account_requests set user_id = p_user, linked_at = now() where id = r.id;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (r.tenant_id, r.created_by, 'staff_account.created', 'membership', p_user::text, jsonb_build_object('role', r.role, 'permissions', r.permissions));
  return jsonb_build_object('user_id', p_user, 'role', r.role, 'tenant_id', r.tenant_id);
end $$;

-- Redefinir senha de um acesso criado pelo síndico (como o síndico): só contas deste tipo, deste condomínio,
-- e sem escalar: quem redefine precisa poder conceder o papel/permissões que a conta tem.
create or replace function public.app_staff_password_check(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.tenant_memberships;
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  perform app.mdm_require_recent_auth();
  if p_user = auth.uid() then raise exception 'Para trocar a própria senha, use "Esqueci minha senha" ou Minha conta.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.staff_login_accounts where user_id = p_user and tenant_id = p_tenant) then
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

-- Registro da troca (service role, depois da troca no Auth).
create or replace function public.app_staff_password_changed(p_tenant uuid, p_user uuid, p_by uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.staff_login_accounts set password_changed_at = now(), password_changed_by = p_by where user_id = p_user and tenant_id = p_tenant;
  -- Senha nova derruba as sessões abertas (refresh token antigo deixa de valer).
  if to_regclass('auth.sessions') is not null then execute 'delete from auth.sessions where user_id = $1' using p_user; end if;
  if to_regclass('auth.refresh_tokens') is not null then execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user; end if;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (p_tenant, p_by, 'staff_account.password_reset', 'membership', p_user::text, '{}'::jsonb);
end $$;

-- Lista da equipe: indica quais são acessos criados pelo condomínio (sem e-mail ativo).
create or replace function public.staff_login_accounts_list(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'team') then coalesce(jsonb_agg(jsonb_build_object('user_id', s.user_id,
    'created_at', s.created_at, 'password_changed_at', s.password_changed_at)), '[]'::jsonb) end
  from public.staff_login_accounts s where s.tenant_id = p_tenant
$$;

revoke all on function public.app_staff_account_check(uuid, text, text, text, text[]), public.app_staff_account_link(uuid, uuid),
  public.app_staff_password_check(uuid, uuid), public.app_staff_password_changed(uuid, uuid, uuid),
  public.staff_login_accounts_list(uuid) from public, anon;
grant execute on function public.app_staff_account_check(uuid, text, text, text, text[]), public.app_staff_password_check(uuid, uuid),
  public.staff_login_accounts_list(uuid) to authenticated;
revoke all on function public.app_staff_account_link(uuid, uuid), public.app_staff_password_changed(uuid, uuid, uuid) from authenticated;
grant execute on function public.app_staff_account_link(uuid, uuid), public.app_staff_password_changed(uuid, uuid, uuid) to service_role;
