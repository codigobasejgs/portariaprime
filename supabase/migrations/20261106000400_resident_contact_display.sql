-- Nome/e-mail do morador editados pelo síndico (resident_update grava em resident_contacts, contato DESTE condomínio)
-- passam a valer na listagem, no relatório e no reconhecimento de nome da portaria. O perfil global (profiles) e o
-- e-mail de login (auth.users) continuam intocados e servem só de fallback quando não há contato ativo.
-- Equipe (admin/porteiro) segue exibindo o perfil: o contato de morador não vale para outro papel.
--
-- Ativação: resident_update e set_membership_status recusam ativar quem tem solicitação de cadastro pendente
-- (a aprovação é decide_access_request, que confere o aceite do termo). Sem solicitação pendente, ativar é seguro:
-- vínculo de morador só nasce por accept_invitation (e-mail confirmado + convite) ou decide_access_request
-- (aprovação + aceite); 'pending'/'revoked' no vínculo é sempre suspensão de alguém que já passou por um deles.
-- Mesmas assinaturas; create or replace mantém os grants.

-- Listagem de membros: morador com contato ativo neste condomínio usa o contato; senão perfil/e-mail de login.
create or replace function public.list_members(p_tenant uuid) returns table (
  membership_id uuid, user_id uuid, role text, permissions text[], status text, full_name text, email text, units jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'team') or app.has_perm(p_tenant, 'approve'));
  return query
  select m.id, m.user_id, m.role, m.permissions, m.status,
    coalesce(rc.name, p.full_name) as full_name,
    coalesce(rc.contact_email, u.email::text) as email,
    coalesce((select jsonb_agg(jsonb_build_object('unit_membership_id', um.id, 'unit_id', un.id, 'block', un.block, 'label', un.label, 'status', um.status))
       from public.unit_memberships um join public.units un on un.id = um.unit_id
      where um.tenant_id = m.tenant_id and um.user_id = m.user_id), '[]'::jsonb)
  from public.tenant_memberships m
  join auth.users u on u.id = m.user_id
  left join public.profiles p on p.id = m.user_id
  left join lateral (select c.name, c.email as contact_email from public.resident_contacts c
                      where c.tenant_id = m.tenant_id and c.user_id = m.user_id and c.active
                      order by c.created_at desc limit 1) rc on m.role = 'morador'
  where m.tenant_id = p_tenant
  order by m.role, coalesce(rc.name, p.full_name);
end $$;

-- Relatório de moradores (versão 20261104000300 com filtro/coluna relation): nome e e-mail do contato ativo da
-- unidade, senão perfil/e-mail de login. Telefone: mesmo contato (antes: um contato qualquer da unidade).
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
             coalesce(case when rc.active then rc.name end, pr.full_name) full_name,
             coalesce(case when rc.active then rc.email end, au.email::text) email,
             rc.phone, um.created_at since, nullif(um.relation, 'morador') relation
        from public.unit_memberships um
        join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador'
        join auth.users au on au.id = um.user_id
        left join public.profiles pr on pr.id = um.user_id
        left join lateral (select c.name, c.email, c.phone, c.active from public.resident_contacts c
                            where c.tenant_id = um.tenant_id and c.unit_id = um.unit_id and c.user_id = um.user_id
                            order by c.active desc, c.created_at desc limit 1) rc on true
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

-- Reconhecimento do destinatário: um nome por pessoa+unidade = contato ativo deste condomínio, senão o perfil.
-- Nome antigo (perfil) não casa mais depois que o síndico corrige o contato; contatos inativos não entram.
create or replace function public.match_recipient(p_tenant uuid, p_name text, p_block text, p_unit text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare nb text := app.norm_block(p_block); nu text := app.norm_unit(p_unit);
  v_units jsonb; v_people jsonb; n_units int; strong_units uuid[]; v_status text; v_unit uuid; v_alerts text[] := '{}';
begin
  perform app.require(app.is_staff(p_tenant));
  if length(coalesce(p_name, '')) > 200 or length(coalesce(p_block, '')) > 60 or length(coalesce(p_unit, '')) > 60 then
    raise exception 'Leitura muito longa.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', u.id, 'block', u.block, 'label', u.label) order by u.block, u.label), '[]'), count(*)
    into v_units, n_units
    from public.units u
   where u.tenant_id = p_tenant and u.active and nu is not null and app.norm_unit(u.label) = nu
     and (nb is null or app.norm_block(u.block) = nb);
  -- Pessoas ativas da unidade, uma linha por pessoa+unidade.
  with people as (
    select distinct um.unit_id, u.block, u.label, n.name, app.name_score(p_name, n.name) score
      from public.unit_memberships um
      join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
      join public.units u on u.tenant_id = um.tenant_id and u.id = um.unit_id and u.active
      left join public.profiles p on p.id = um.user_id
      cross join lateral (select coalesce((select c.name from public.resident_contacts c
          where c.tenant_id = um.tenant_id and c.unit_id = um.unit_id and c.user_id = um.user_id and c.active
          order by c.created_at desc limit 1), p.full_name) name) n
     where um.tenant_id = p_tenant and um.status = 'active' and n.name is not null and app.norm_text(p_name) is not null
  ), best as (
    select distinct on (unit_id, name) * from people where score >= 0.5 order by unit_id, name, score desc limit 20
  )
  select coalesce(jsonb_agg(jsonb_build_object('unit_id', unit_id, 'block', block, 'label', label, 'name', name, 'score', score)
           order by score desc, name), '[]'),
         array(select distinct unit_id from best where score >= 0.75)
    into v_people, strong_units from best;

  if n_units = 1 then
    v_unit := (v_units->0->>'unit_id')::uuid;
    if v_unit = any(strong_units) then v_status := 'matched';
    elsif cardinality(strong_units) > 0 then v_status := 'conflict'; v_alerts := array_append(v_alerts, 'O nome lido pertence a outra unidade.');
    else v_status := 'unit_only'; v_alerts := array_append(v_alerts, 'Nome não confere com moradores ativos desta unidade.');
    end if;
    if cardinality(strong_units) > 1 then v_alerts := array_append(v_alerts, 'Há pessoa com nome semelhante em outra unidade.'); end if;
  elsif n_units > 1 then
    v_status := 'ambiguous'; v_alerts := array_append(v_alerts, 'Mais de uma unidade com esse número: confirme o bloco.');
  elsif cardinality(strong_units) = 1 then
    v_status := 'name_only'; v_unit := strong_units[1]; v_alerts := array_append(v_alerts, 'Unidade não lida: sugerida pelo nome. Confira.');
  elsif cardinality(strong_units) > 1 then
    v_status := 'ambiguous'; v_alerts := array_append(v_alerts, 'Nome igual em mais de uma unidade (homônimos).');
  else
    v_status := 'not_found'; v_alerts := array_append(v_alerts, 'Nenhum morador ativo corresponde à leitura.');
  end if;
  return jsonb_build_object('status', v_status, 'unit_id', v_unit, 'units', v_units, 'people', v_people, 'alerts', to_jsonb(v_alerts));
end $$;

-- Igual à 20261106000300, com a recusa de ativação quando há solicitação pendente.
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
  -- Quem está suspenso e pediu cadastro de novo entra pela solicitação (aprovação + aceite do termo), não por aqui.
  if p_status = 'active' and m.status <> 'active'
     and exists (select 1 from public.access_requests where tenant_id = p_tenant and user_id = p_user and status = 'pending') then
    raise exception 'Esta pessoa tem uma solicitação de cadastro pendente: aprove ou recuse em Solicitações.' using errcode = 'P0001';
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

-- Igual à 20261019000500, com a mesma recusa para morador com solicitação pendente (botão "Reativar" da lista).
create or replace function public.set_membership_status(p_membership uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.tenant_memberships;
begin
  select * into m from public.tenant_memberships where id = p_membership for update;
  if not found then raise exception 'Vínculo não encontrado.' using errcode = 'P0002'; end if;
  perform app.require(case when m.role = 'morador' then app.has_perm(m.tenant_id, 'approve') else app.has_perm(m.tenant_id, 'team') end);
  if p_status not in ('active', 'revoked') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  if m.user_id = auth.uid() and p_status = 'revoked' then raise exception 'Você não pode revogar o próprio acesso.' using errcode = 'P0001'; end if;
  if m.role = 'morador' and p_status = 'active' and m.status <> 'active'
     and exists (select 1 from public.access_requests where tenant_id = m.tenant_id and user_id = m.user_id and status = 'pending') then
    raise exception 'Esta pessoa tem uma solicitação de cadastro pendente: aprove ou recuse em Solicitações.' using errcode = 'P0001';
  end if;
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

revoke all on function public.list_members(uuid), public.report_residents(uuid, jsonb), public.match_recipient(uuid, text, text, text),
  public.resident_update(uuid, uuid, text, text, text, uuid, uuid, text), public.set_membership_status(uuid, text) from public, anon;
grant execute on function public.list_members(uuid), public.report_residents(uuid, jsonb), public.match_recipient(uuid, text, text, text),
  public.resident_update(uuid, uuid, text, text, text, uuid, uuid, text), public.set_membership_status(uuid, text) to authenticated;
grant execute on function public.match_recipient(uuid, text, text, text) to service_role;
