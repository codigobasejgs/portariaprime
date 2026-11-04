-- Perfil do morador na unidade: proprietário, locatário, dependente, funcionário ou outro.
-- Informado no cadastro (pedido e rascunho), visível na fila e nos relatórios, copiado para o vínculo
-- com a unidade na aprovação (unit_memberships.relation já existe). Sem alterar assinaturas existentes.

alter table public.access_requests add column if not exists relation text
  check (relation is null or relation in ('proprietario', 'locatario', 'dependente', 'funcionario', 'outro'));
alter table public.resident_signup_drafts add column if not exists relation text
  check (relation is null or relation in ('proprietario', 'locatario', 'dependente', 'funcionario', 'outro'));

-- Morador informa o perfil do PRÓPRIO pedido pendente (logo após enviar; ou pelo rascunho do cadastro).
create or replace function public.access_request_set_relation(p_slug text, p_relation text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_req uuid;
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  if p_relation is null or p_relation not in ('proprietario', 'locatario', 'dependente', 'funcionario', 'outro') then
    raise exception 'Escolha o perfil: proprietário, locatário, dependente, funcionário ou outro.' using errcode = '22023';
  end if;
  select r.id into v_req from public.access_requests r join public.tenants t on t.id = r.tenant_id
   where t.slug = lower(btrim(p_slug)) and r.user_id = auth.uid() and r.status = 'pending' for update of r;
  if not found then raise exception 'Nenhuma solicitação pendente para este condomínio.' using errcode = 'P0002'; end if;
  update public.access_requests set relation = p_relation where id = v_req;
end $$;

-- Rascunho (cadastro com confirmação de e-mail): guarda o perfil enviado no signUp.
create or replace function app.resident_signup_capture_relation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v text := new.raw_user_meta_data -> 'pp_signup' ->> 'relation';
begin
  if v in ('proprietario', 'locatario', 'dependente', 'funcionario', 'outro') then
    update public.resident_signup_drafts set relation = v where user_id = new.id;
  end if;
  return new;
exception when others then return new;  -- nunca impede a criação da conta
end $$;
-- Nome posterior a on_auth_user_resident_signup (gatilhos AFTER rodam em ordem alfabética): o rascunho já existe.
create trigger on_auth_user_resident_signup_relation after insert on auth.users
  for each row execute function app.resident_signup_capture_relation();

-- Rascunho → pedido: o perfil acompanha quando o finalize cria o pedido.
create or replace function app.access_request_relation_from_draft() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.relation is null then
    select d.relation into new.relation from public.resident_signup_drafts d where d.user_id = new.user_id and d.tenant_id = new.tenant_id;
  end if;
  return new;
end $$;
create trigger access_request_relation_from_draft before insert on public.access_requests
  for each row execute function app.access_request_relation_from_draft();

-- Aprovação: copia o perfil do pedido para o vínculo com a unidade.
create or replace function app.access_request_relation_to_membership() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status <> 'approved' and new.relation is not null and new.unit_id is not null then
    update public.unit_memberships set relation = new.relation where unit_id = new.unit_id and user_id = new.user_id;
  end if;
  return new;
end $$;
create trigger access_request_relation_to_membership after update of status on public.access_requests
  for each row execute function app.access_request_relation_to_membership();

-- Fila do síndico: inclui o perfil (mesma assinatura e grants).
create or replace function public.list_access_requests(p_tenant uuid, p_status text default 'pending') returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'approve') then coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'full_name', r.full_name, 'email', u.email, 'email_verified', u.email_confirmed_at is not null, 'phone', r.phone,
    'block_text', r.block_text, 'unit_text', r.unit_text, 'unit_id', r.unit_id, 'status', r.status, 'reason', r.reason, 'relation', r.relation,
    'created_at', r.created_at, 'decided_at', r.decided_at,
    'privacy_version', a.term_version, 'privacy_accepted_at', a.accepted_at) order by r.created_at desc), '[]') end
  from public.access_requests r join auth.users u on u.id = r.user_id
  left join lateral (select term_version, accepted_at from public.privacy_acknowledgements x
                      where x.access_request_id = r.id order by x.accepted_at desc limit 1) a on true
  where r.tenant_id = p_tenant and (p_status is null or r.status = p_status)
$$;

-- Relatório de moradores com o perfil (e filtro por perfil); mesma assinatura e grants da 0200.
-- Moradores por unidade: inclui unidades sem morador; status do vínculo ou do pedido mais recente.
create or replace function public.report_residents(p_tenant uuid, p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); k text;
begin
  perform app.require(app.is_admin(p_tenant) and (app.has_perm(p_tenant, 'approve') or app.has_perm(p_tenant, 'team')),
    'Somente quem aprova moradores ou gerencia a equipe acessa este relatório.');
  if jsonb_typeof(f) <> 'object' then raise exception 'Filtros inválidos.' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(f) loop
    if k not in ('block', 'unit', 'status', 'occupancy', 'search', 'relation') or length(coalesce(f->>k, '')) > 80 then raise exception 'Filtro inválido: %.', k using errcode = '22023'; end if;
  end loop;
  if nullif(f->>'status', '') is not null and f->>'status' not in ('active', 'pending', 'rejected', 'revoked') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if nullif(f->>'occupancy', '') is not null and f->>'occupancy' not in ('with', 'without') then raise exception 'Ocupação inválida.' using errcode = '22023'; end if;
  begin perform (f->>'unit')::uuid; exception when invalid_text_representation then raise exception 'Unidade inválida.' using errcode = '22023'; end;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.block nulls first, length(x.label), x.label, x.full_name) from (
    with people as (
      -- Moradores com vínculo à unidade (ativos ou revogados).
      select um.unit_id, um.user_id, case when um.status = 'active' and m.status = 'active' then 'active' else 'revoked' end status,
             pr.full_name, au.email::text email, rc.phone, um.created_at since, nullif(um.relation, 'morador') relation
        from public.unit_memberships um
        join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador'
        join auth.users au on au.id = um.user_id
        left join public.profiles pr on pr.id = um.user_id
        left join lateral (select phone from public.resident_contacts c where c.unit_id = um.unit_id and c.user_id = um.user_id limit 1) rc on true
       where um.tenant_id = p_tenant
      union all
      -- Pedidos pendentes/recusados ainda sem vínculo (unidade encontrada ou não).
      select r.unit_id, r.user_id, case r.status when 'pending' then 'pending' else 'rejected' end, r.full_name, au.email::text, r.phone, r.created_at, r.relation
        from public.access_requests r join auth.users au on au.id = r.user_id
       where r.tenant_id = p_tenant and r.status in ('pending', 'rejected')
         and not exists (select 1 from public.unit_memberships um where um.tenant_id = r.tenant_id and um.user_id = r.user_id and um.status = 'active')
         and r.created_at = (select max(r2.created_at) from public.access_requests r2 where r2.tenant_id = r.tenant_id and r2.user_id = r.user_id)
    )
    select u.id unit_id, u.block, u.label, u.active unit_active, p.user_id, p.status, p.full_name, p.email, p.phone, p.since, p.relation,
           (select count(*) from people p2 where p2.unit_id = u.id and p2.status = 'active') active_residents
      from public.units u left join people p on p.unit_id = u.id
     where u.tenant_id = p_tenant
       and (nullif(f->>'block', '') is null or upper(btrim(coalesce(u.block, ''))) = upper(btrim(f->>'block')))
       and (nullif(f->>'unit', '') is null or u.id = (f->>'unit')::uuid)
       and (nullif(f->>'status', '') is null or p.status = f->>'status')
       and (nullif(f->>'relation', '') is null or p.relation = f->>'relation')
       and (nullif(f->>'occupancy', '') is null
            or (f->>'occupancy' = 'with' and exists (select 1 from people p3 where p3.unit_id = u.id and p3.status = 'active'))
            or (f->>'occupancy' = 'without' and not exists (select 1 from people p3 where p3.unit_id = u.id and p3.status = 'active')))
       and (nullif(f->>'search', '') is null or concat_ws(' ', p.full_name, p.email, u.block, u.label) ilike '%' || replace(replace(f->>'search', '%', '\%'), '_', '\_') || '%')
     limit 10000) x), '[]'::jsonb);
end $$;

revoke all on function public.access_request_set_relation(text, text) from public, anon;
grant execute on function public.access_request_set_relation(text, text) to authenticated;
revoke all on function app.resident_signup_capture_relation(), app.access_request_relation_from_draft(), app.access_request_relation_to_membership()
  from public, anon, authenticated;

-- Síndico pede o link oficial de nova senha para um morador (o e-mail é enviado pelo Auth para a caixa do morador).
-- Só quem aprova moradores, só moradores com vínculo neste condomínio, e só contas usadas somente aqui
-- (senão um síndico dispararia e-mail para quem é de outro condomínio). Limite: 1 por morador a cada 10 min.
create or replace function public.resident_password_reset_check(p_tenant uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova moradores pode enviar o link de nova senha.');
  if not exists (select 1 from public.tenant_memberships where tenant_id = p_tenant and user_id = p_user and role = 'morador') then
    raise exception 'Morador não encontrado neste condomínio.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.tenant_memberships where user_id = p_user and (tenant_id <> p_tenant or role <> 'morador')) then
    raise exception 'Esta conta também é usada em outro condomínio ou na equipe; peça ao morador para usar "Esqueci minha senha".' using errcode = '42501';
  end if;
  if exists (select 1 from public.audit_logs where tenant_id = p_tenant and action = 'resident.password_reset_sent' and target_id = p_user::text and created_at > now() - interval '10 minutes') then
    raise exception 'Um link já foi enviado há pouco. Aguarde 10 minutos.' using errcode = 'P0001';
  end if;
  select lower(email) into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'Conta sem e-mail cadastrado.' using errcode = 'P0001'; end if;
  perform app.audit(p_tenant, 'resident.password_reset_sent', 'membership', p_user::text);
  return jsonb_build_object('email', v_email, 'email_masked', regexp_replace(v_email, '^(.).*(@.*)$', '\1***\2'));
end $$;
revoke all on function public.resident_password_reset_check(uuid, uuid) from public, anon;
grant execute on function public.resident_password_reset_check(uuid, uuid) to authenticated;
