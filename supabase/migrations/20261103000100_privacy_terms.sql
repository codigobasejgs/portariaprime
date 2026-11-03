-- =============================================================================
-- Termo de ciência e aceite (proteção de dados) no cadastro do morador.
--  * privacy_terms: versões por condomínio; rascunho editável, publicada imutável (nova versão =
--    nova linha; a anterior vira "archived" e é preservada). Só uma publicada por condomínio.
--  * privacy_acknowledgements: registro do aceite com timestamp do SERVIDOR, versão e hash do texto
--    resolvidos no servidor (o navegador só diz "aceito" + qual hash leu; se o hash não bater com a
--    versão publicada, recusa). Append-only: sem update/delete.
--  * request_access(..., p_privacy_hash): sem termo publicado ou sem aceite da versão vigente, o
--    cadastro NÃO é enviado. A assinatura antiga (5 args) continua para clientes antigos, mas passa a
--    exigir o aceite quando o condomínio tem termo publicado.
--  * decide_access_request: não aprova pedido sem aceite registrado quando o condomínio exige.
-- A marcação registra ciência e aceite do documento; a base legal do tratamento é definida pelo
-- condomínio (controlador) com apoio jurídico — o sistema não a declara.
-- =============================================================================

create table public.privacy_terms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version text not null check (version ~ '^[0-9A-Za-z.\-]{1,40}$'),
  title text not null check (length(btrim(title)) between 3 and 200),
  content text not null check (length(content) between 50 and 50000),
  content_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  change_note text check (change_note is null or length(change_note) <= 500),
  effective_at timestamptz,
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, version),
  unique (tenant_id, id)
);
create unique index privacy_terms_one_published on public.privacy_terms (tenant_id) where status = 'published';

-- Hash sempre do texto armazenado; publicada/arquivada não muda (exceto published → archived).
create or replace function app.privacy_term_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'Versão publicada do termo não pode ser apagada.' using errcode = '42501'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    if new.content is distinct from old.content or new.title is distinct from old.title or new.version <> old.version
       or new.tenant_id <> old.tenant_id or new.published_at is distinct from old.published_at
       or not (new.status = old.status or (old.status = 'published' and new.status = 'archived')) then
      raise exception 'Termo publicado é imutável; crie uma nova versão.' using errcode = '42501';
    end if;
  end if;
  new.content_hash := app.sha256_hex(new.title || E'\n' || new.content);
  new.updated_at := now();
  return new;
end $$;
create trigger privacy_term_guard before insert or update or delete on public.privacy_terms
  for each row execute function app.privacy_term_guard();

create table public.privacy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_request_id uuid references public.access_requests(id) on delete set null,
  privacy_term_id uuid not null,
  term_version text not null,
  term_hash text not null,
  accepted_at timestamptz not null default now(),
  action_source text not null check (action_source in ('cadastro_portal', 'portal_reaceite')),
  statement text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, privacy_term_id) references public.privacy_terms (tenant_id, id)
);
-- Um aceite por pessoa, condomínio e versão (reenvio do cadastro não duplica; nova versão gera novo registro).
create unique index privacy_ack_once on public.privacy_acknowledgements (tenant_id, user_id, privacy_term_id);
create index privacy_ack_tenant_idx on public.privacy_acknowledgements (tenant_id, accepted_at desc);

create or replace function app.privacy_ack_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Única alteração aceita: vincular o aceite ao pedido de cadastro (quando o pedido é criado depois).
  if tg_op = 'UPDATE' and old.access_request_id is null and new.access_request_id is not null
     and (to_jsonb(new) - 'access_request_id') = (to_jsonb(old) - 'access_request_id') then
    return new;
  end if;
  raise exception 'Registro de aceite é permanente (alteração e exclusão bloqueadas).' using errcode = '42501';
end $$;
create trigger privacy_ack_guard before update or delete on public.privacy_acknowledgements
  for each row execute function app.privacy_ack_guard();

alter table public.privacy_terms enable row level security;
alter table public.privacy_acknowledgements enable row level security;
-- Leitura direta só para quem administra o condomínio; morador lê o termo vigente pela RPC pública.
grant select on public.privacy_terms, public.privacy_acknowledgements to authenticated;
-- Backup/suporte (service_role ignora RLS). Travas imutáveis continuam valendo para ela também.
grant all on public.privacy_terms, public.privacy_acknowledgements to service_role;
create policy privacy_terms_select on public.privacy_terms for select to authenticated using (app.is_admin(tenant_id));
create policy privacy_ack_select on public.privacy_acknowledgements for select to authenticated
  using (user_id = auth.uid() or app.has_perm(tenant_id, 'approve'));

-- Texto-base (rascunho) sujeito à revisão jurídica e à parametrização pelo condomínio.
create or replace function app.privacy_term_default() returns text
language sql immutable set search_path = '' as $$
  select 'Declaro que sou morador efetivo do condomínio identificado neste cadastro e estou ciente do tratamento e armazenamento dos meus dados pessoais na plataforma digital Portaria Prime, em ambiente de nuvem, para finalidades relacionadas à identificação, validação cadastral, gerenciamento, controle, registro, comunicação e entrega de encomendas e correspondências.' || E'\n\n' ||
         'Estou ciente de que o acesso aos meus dados deverá ser restrito a pessoas autorizadas e aos prestadores de serviço que necessitem tratá-los para as finalidades informadas, observadas as medidas de segurança, confidencialidade e proteção de dados aplicáveis.' || E'\n\n' ||
         'Meus dados não deverão ser utilizados para finalidades comerciais incompatíveis com as finalidades informadas, sem fundamento jurídico apropriado.' || E'\n\n' ||
         'Estou ciente de que, após minha saída definitiva do condomínio e confirmação da baixa cadastral, meu acesso poderá ser cancelado, respeitados os prazos e as hipóteses legais de conservação, bloqueio, anonimização ou eliminação dos dados.' || E'\n\n' ||
         'Declaro que tive acesso às informações sobre o tratamento dos meus dados pessoais, incluindo suas finalidades, direitos do titular e canais de contato disponibilizados pelos responsáveis pelo tratamento.'
$$;

-- -----------------------------------------------------------------------------
-- Administração do termo (síndico com permissão "settings").
-- -----------------------------------------------------------------------------
create or replace function public.privacy_terms_admin(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings') or app.has_perm(p_tenant, 'approve'), 'Sem permissão para ver o termo do condomínio.');
  return jsonb_build_object(
    'default_title', 'Termo de ciência e aceite — Proteção de dados pessoais',
    'default_content', app.privacy_term_default(),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'version', t.version, 'title', t.title, 'content', t.content,
        'hash', t.content_hash, 'status', t.status, 'change_note', t.change_note, 'published_at', t.published_at, 'created_at', t.created_at,
        'acknowledgements', (select count(*) from public.privacy_acknowledgements a where a.privacy_term_id = t.id)) order by t.created_at desc)
      from public.privacy_terms t where t.tenant_id = p_tenant), '[]'::jsonb));
end $$;

create or replace function public.privacy_term_save(p_tenant uuid, p_id uuid, p_version text, p_title text, p_content text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.privacy_terms;
begin
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Somente quem altera as configurações pode editar o termo.');
  if p_id is null then
    begin
      insert into public.privacy_terms (tenant_id, version, title, content, content_hash, change_note, created_by)
      values (p_tenant, btrim(p_version), btrim(p_title), p_content, '', nullif(btrim(p_note), ''), auth.uid()) returning * into t;
    exception when unique_violation then raise exception 'Já existe a versão % deste termo.', p_version using errcode = '23505';
    end;
  else
    update public.privacy_terms set title = btrim(p_title), content = p_content, change_note = nullif(btrim(p_note), '')
     where id = p_id and tenant_id = p_tenant and status = 'draft' returning * into t;
    if not found then raise exception 'Só rascunho pode ser editado.' using errcode = 'P0001'; end if;
  end if;
  perform app.audit(p_tenant, 'privacy_term.saved', 'privacy_term', t.id::text, jsonb_build_object('version', t.version, 'hash', t.content_hash));
  return jsonb_build_object('id', t.id, 'status', t.status, 'hash', t.content_hash);
exception when check_violation then
  raise exception 'Termo inválido: versão (letras, números, ponto e hífen), título de 3 a 200 e texto de 50 a 50.000 caracteres.' using errcode = '22023';
end $$;

-- Publicar: a versão vigente anterior é arquivada (preservada, com seus aceites).
create or replace function public.privacy_term_publish(p_tenant uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.privacy_terms; v_now timestamptz := app.now(); v_prev uuid;
begin
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Somente quem altera as configurações pode publicar o termo.');
  perform app.mdm_require_recent_auth();   -- senha recente (≤ 5 min) e MFA quando cadastrado
  select * into t from public.privacy_terms where id = p_id and tenant_id = p_tenant for update;
  if not found then raise exception 'Termo não encontrado.' using errcode = 'P0002'; end if;
  if t.status <> 'draft' then raise exception 'Só rascunho pode ser publicado.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('privacy_term:' || p_tenant::text));
  update public.privacy_terms set status = 'archived' where tenant_id = p_tenant and status = 'published' returning id into v_prev;
  update public.privacy_terms set status = 'published', published_at = v_now, effective_at = v_now, published_by = auth.uid()
   where id = t.id returning * into t;
  perform app.audit(p_tenant, 'privacy_term.published', 'privacy_term', t.id::text,
    jsonb_build_object('version', t.version, 'hash', t.content_hash, 'previous_id', v_prev,
      'previous_acknowledgements', (select count(*) from public.privacy_acknowledgements where privacy_term_id = v_prev)));
  return jsonb_build_object('id', t.id, 'version', t.version, 'hash', t.content_hash, 'previous_id', v_prev);
end $$;

-- Histórico de aceites para quem aprova cadastros (sem dados além do necessário).
create or replace function public.privacy_acknowledgements_list(p_tenant uuid, p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros vê os registros de aceite.');
  return jsonb_build_object(
    'total', (select count(*) from public.privacy_acknowledgements where tenant_id = p_tenant),
    'rows', coalesce((select jsonb_agg(x order by x.accepted_at desc) from (
      select a.id, a.accepted_at, a.term_version, a.term_hash, a.action_source, r.full_name, concat_ws(' ', r.block_text, r.unit_text) unit_text,
             r.status request_status, a.access_request_id
        from public.privacy_acknowledgements a left join public.access_requests r on r.id = a.access_request_id
       where a.tenant_id = p_tenant order by a.accepted_at desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- Morador: termo vigente (público, só texto) e aceite no envio do cadastro.
-- -----------------------------------------------------------------------------
create or replace function public.privacy_term_current(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'version', p.version, 'title', p.title, 'content', p.content, 'hash', p.content_hash, 'published_at', p.published_at)
    from public.privacy_terms p join public.tenants t on t.id = p.tenant_id
   where t.slug = lower(btrim(p_slug)) and t.status = 'active' and p.status = 'published'
$$;

-- Substitui request_access: mesma regra de antes + aceite obrigatório do termo vigente.
create or replace function public.request_access(p_slug text, p_full_name text, p_phone text, p_block text, p_unit text, p_privacy_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.tenants; v_unit uuid; v_req uuid; v_phone text := nullif(app.digits(p_phone), ''); v_term public.privacy_terms; v_ack uuid;
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  perform app.require(app.email_verified(), 'Confirme seu e-mail antes de solicitar o cadastro.');
  select * into v_t from public.tenants where slug = lower(btrim(p_slug)) and status = 'active';
  if not found then raise exception 'Condomínio não encontrado ou indisponível.' using errcode = 'P0002'; end if;
  if exists (select 1 from public.tenant_memberships where tenant_id = v_t.id and user_id = auth.uid() and role = 'morador' and status = 'active') then
    raise exception 'Você já tem acesso de morador neste condomínio.' using errcode = 'P0001';
  end if;
  -- Termo: sem versão publicada não há cadastro; aceite só vale para o texto publicado agora.
  select * into v_term from public.privacy_terms where tenant_id = v_t.id and status = 'published';
  if not found then
    raise exception 'O condomínio ainda não publicou o termo de tratamento de dados. O cadastro será liberado após a publicação.' using errcode = 'P0001';
  end if;
  if p_privacy_hash is null or p_privacy_hash is distinct from v_term.content_hash then
    raise exception 'Leia e aceite o termo de tratamento de dados vigente para enviar o cadastro.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 then raise exception 'Informe seu nome completo.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_unit, ''))) = 0 then raise exception 'Informe sua unidade.' using errcode = '22023'; end if;
  if v_phone is not null and v_phone !~ '^\d{10,13}$' then raise exception 'Telefone inválido (DDD + número).' using errcode = '22023'; end if;
  if (select count(*) from public.access_requests where user_id = auth.uid() and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Muitas solicitações. Tente novamente amanhã.' using errcode = 'P0001';
  end if;
  select id into v_unit from public.units
   where tenant_id = v_t.id and active and app.norm_unit(label) = app.norm_unit(p_unit)
     and coalesce(app.norm_block(block), '') = coalesce(app.norm_block(p_block), '') limit 1;
  select id into v_req from public.access_requests where tenant_id = v_t.id and user_id = auth.uid() and status = 'pending';
  if found then
    update public.access_requests set full_name = btrim(p_full_name), phone = coalesce(v_phone, phone), block_text = nullif(btrim(p_block), ''),
      unit_text = btrim(p_unit), unit_id = v_unit where id = v_req;
  else
    insert into public.access_requests (tenant_id, user_id, full_name, phone, block_text, unit_text, unit_id)
    values (v_t.id, auth.uid(), btrim(p_full_name), v_phone, nullif(btrim(p_block), ''), btrim(p_unit), v_unit)
    returning id into v_req;
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    select v_t.id, m.user_id, 'access_request', 'Nova solicitação de cadastro', 'Um morador pediu acesso. Revise em Unidades e pessoas.'
      from public.tenant_memberships m where m.tenant_id = v_t.id and m.role = 'admin' and m.status = 'active' and 'approve' = any (m.permissions);
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id)
    select v_t.id, 'access_request', 'push', m.user_id::text, v_req::text
      from public.tenant_memberships m where m.tenant_id = v_t.id and m.role = 'admin' and m.status = 'active' and 'approve' = any (m.permissions)
    on conflict do nothing;
  end if;
  -- Aceite na mesma transação do pedido: ou os dois ficam registrados, ou nenhum.
  insert into public.privacy_acknowledgements (tenant_id, user_id, access_request_id, privacy_term_id, term_version, term_hash, accepted_at, action_source, statement)
  values (v_t.id, auth.uid(), v_req, v_term.id, v_term.version, v_term.content_hash, app.now(), 'cadastro_portal',
          'Li e estou ciente do Termo de Tratamento de Dados Pessoais e das finalidades de utilização do Portal Portaria Prime.')
  on conflict (tenant_id, user_id, privacy_term_id) do nothing
  returning id into v_ack;
  if v_ack is null then
    -- Já aceito antes (reenvio): só vincula ao pedido atual se ainda não estava.
    update public.privacy_acknowledgements set access_request_id = v_req
     where tenant_id = v_t.id and user_id = auth.uid() and privacy_term_id = v_term.id and access_request_id is null;
  end if;
  perform app.audit(v_t.id, 'access_request.created', 'access_request', v_req::text, jsonb_build_object('privacy_term', v_term.version));
  return jsonb_build_object('request_id', v_req, 'status', 'pending', 'slug', v_t.slug, 'privacy_version', v_term.version);
end $$;

-- Assinatura antiga (app em cache sem o passo do termo): continua existindo, mas sem hash o servidor recusa.
create or replace function public.request_access(p_slug text, p_full_name text, p_phone text, p_block text, p_unit text)
returns jsonb language sql security definer set search_path = '' as $$
  select public.request_access(p_slug, p_full_name, p_phone, p_block, p_unit, null::text)
$$;

-- Estado do próprio pedido: inclui se o aceite da versão vigente está registrado.
create or replace function public.my_access_request(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  -- Mantém a regra de 20261023000100: aprovado sem vínculo ativo de morador = encerrado.
  select jsonb_build_object('status', case when r.status = 'approved' and not exists (
      select 1 from public.tenant_memberships m where m.tenant_id = r.tenant_id and m.user_id = auth.uid() and m.role = 'morador' and m.status = 'active')
      then 'revoked' else r.status end,
    'unit_text', concat_ws(' ', r.block_text, r.unit_text), 'reason', r.reason, 'created_at', r.created_at,
    'privacy_version', (select a.term_version from public.privacy_acknowledgements a where a.access_request_id = r.id order by a.accepted_at desc limit 1))
  from public.access_requests r join public.tenants t on t.id = r.tenant_id
  where t.slug = lower(btrim(p_slug)) and r.user_id = auth.uid() order by r.created_at desc limit 1
$$;

-- Fila do síndico: mostra a versão aceita; pedido sem aceite fica sinalizado.
create or replace function public.list_access_requests(p_tenant uuid, p_status text default 'pending') returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'approve') then coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'full_name', r.full_name, 'email', u.email, 'phone', r.phone, 'block_text', r.block_text, 'unit_text', r.unit_text,
    'unit_id', r.unit_id, 'status', r.status, 'reason', r.reason, 'created_at', r.created_at, 'decided_at', r.decided_at,
    'privacy_version', a.term_version, 'privacy_accepted_at', a.accepted_at) order by r.created_at desc), '[]') end
  from public.access_requests r join auth.users u on u.id = r.user_id
  left join lateral (select term_version, accepted_at from public.privacy_acknowledgements x
                      where x.access_request_id = r.id order by x.accepted_at desc limit 1) a on true
  where r.tenant_id = p_tenant and (p_status is null or r.status = p_status)
$$;

-- Aprovação: com termo publicado no condomínio, exige o aceite registrado deste pedido.
-- Pedidos anteriores à publicação do primeiro termo continuam aprováveis (sem efeito retroativo).
create or replace function app.access_request_requires_ack(r public.access_requests) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.privacy_terms p where p.tenant_id = r.tenant_id and p.status in ('published', 'archived')
                  and p.published_at <= r.created_at)
$$;

alter function public.decide_access_request(uuid, boolean, uuid, text) rename to decide_access_request_before_privacy;
create function public.decide_access_request(p_request uuid, p_approve boolean, p_unit uuid default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.access_requests;
begin
  select * into r from public.access_requests where id = p_request;
  if found and p_approve and r.status = 'pending' and app.access_request_requires_ack(r)
     and not exists (select 1 from public.privacy_acknowledgements where access_request_id = r.id) then
    raise exception 'Este cadastro não tem o aceite do termo de dados registrado. Peça ao morador que envie o cadastro novamente.' using errcode = 'P0001';
  end if;
  return public.decide_access_request_before_privacy(p_request, p_approve, p_unit, p_reason);
end $$;

revoke all on function app.privacy_term_guard(), app.privacy_ack_guard(), app.privacy_term_default(), app.access_request_requires_ack(public.access_requests)
  from public, anon, authenticated;
revoke all on function public.decide_access_request_before_privacy(uuid, boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.privacy_terms_admin(uuid), public.privacy_term_save(uuid, uuid, text, text, text, text), public.privacy_term_publish(uuid, uuid),
  public.privacy_acknowledgements_list(uuid, int, int), public.request_access(text, text, text, text, text, text),
  public.request_access(text, text, text, text, text), public.my_access_request(text), public.list_access_requests(uuid, text),
  public.decide_access_request(uuid, boolean, uuid, text) from public, anon;
grant execute on function public.privacy_terms_admin(uuid), public.privacy_term_save(uuid, uuid, text, text, text, text), public.privacy_term_publish(uuid, uuid),
  public.privacy_acknowledgements_list(uuid, int, int), public.request_access(text, text, text, text, text, text),
  public.request_access(text, text, text, text, text), public.my_access_request(text), public.list_access_requests(uuid, text),
  public.decide_access_request(uuid, boolean, uuid, text) to authenticated, service_role;
grant execute on function public.privacy_term_current(text) to anon, authenticated, service_role;
