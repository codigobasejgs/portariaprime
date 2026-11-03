-- =============================================================================
-- Cadastro do morador em UMA etapa + termo LGPD GLOBAL + avisos (e-mail/WhatsApp) + fila do síndico.
--
-- Causa raiz (produção, 03/11/2026):
--  1) request_access exigia termo publicado POR CONDOMÍNIO; nenhum condomínio tinha -> todo cadastro recusado.
--  2) O cadastro era em duas etapas (conta; depois nome/telefone/bloco/unidade + termo). Com a confirmação
--     de e-mail automática da produção, quem criava a conta caía de novo num formulário ao entrar.
--  3) Pedido recebido não gerava e-mail/WhatsApp ao morador; aprovação só e-mail; o síndico só recebia push.
--
-- Agora:
--  * privacy_terms_global: termo padrão da Portaria Prime, versionado, imutável depois de publicado, gerido pela
--    administração da plataforma. Texto com {{CONDOMINIO}}; o hash é do MODELO (mesma versão para todos) e o
--    aceite guarda o texto efetivamente exibido (com o nome do condomínio) e o hash desse texto.
--  * Termo do condomínio (privacy_terms, 0100) passa a ser opcional: se o síndico publicar um, ele prevalece;
--    senão vale o global. Aceites antigos ficam como estão (nada é convertido).
--  * resident_signup_draft: dados do cadastro guardados no servidor ANTES de existir sessão (quando a confirmação
--    de e-mail está ligada). Ao confirmar/entrar, resident_signup_finalize cria o pedido sem pedir nada de novo.
--  * request_access aceita o termo global; notifica síndico (central, push, e-mail) e morador (e-mail, WhatsApp
--    quando houver canal), tudo a partir de eventos persistidos. Decisão também gera e-mail e WhatsApp.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Termo global (plataforma)
-- -----------------------------------------------------------------------------
create table public.privacy_terms_global (
  id uuid primary key default gen_random_uuid(),
  version text not null unique check (version ~ '^[0-9A-Za-z.\-]{1,40}$'),
  title text not null check (length(btrim(title)) between 3 and 200),
  content text not null check (length(content) between 50 and 50000),
  content_hash text not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  change_note text check (change_note is null or length(change_note) <= 500),
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index privacy_terms_global_one_published on public.privacy_terms_global ((true)) where status = 'published';

create or replace function app.privacy_term_global_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'Versão publicada do termo não pode ser apagada.' using errcode = '42501'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status <> 'draft' then
    if new.content is distinct from old.content or new.title is distinct from old.title or new.version <> old.version
       or new.published_at is distinct from old.published_at
       or not (new.status = old.status or (old.status = 'published' and new.status = 'archived')) then
      raise exception 'Termo publicado é imutável; crie uma nova versão.' using errcode = '42501';
    end if;
  end if;
  new.content_hash := app.sha256_hex(new.title || E'\n' || new.content);
  new.updated_at := now();
  return new;
end $$;
create trigger privacy_term_global_guard before insert or update or delete on public.privacy_terms_global
  for each row execute function app.privacy_term_global_guard();

alter table public.privacy_terms_global enable row level security;
revoke all on public.privacy_terms_global from public, anon, authenticated;
grant all on public.privacy_terms_global to service_role;

-- Versão inicial publicada (texto-base sujeito à revisão jurídica; ver docs/CADASTRO_MORADOR.md).
insert into public.privacy_terms_global (version, title, content, content_hash, status, published_at, change_note)
values ('1.0', 'Termo de ciência e aceite — Proteção de dados pessoais',
  'Declaro que sou morador efetivo do {{CONDOMINIO}} e estou ciente do tratamento e armazenamento dos meus dados pessoais na plataforma digital Portaria Prime, em ambiente de nuvem, para finalidades relacionadas à identificação, validação cadastral, gerenciamento, controle, registro, comunicação e entrega de encomendas e correspondências.' || E'\n\n' ||
  'Estou ciente de que o acesso aos meus dados será restrito às pessoas autorizadas e aos prestadores de serviços que necessitem tratá-los para as finalidades informadas, observadas as medidas de segurança e confidencialidade aplicáveis e a Lei nº 13.709/2018 (LGPD).' || E'\n\n' ||
  'Os dados não deverão ser utilizados para finalidades comerciais incompatíveis com aquelas informadas sem fundamento jurídico adequado.' || E'\n\n' ||
  'Estou ciente de que, após minha saída definitiva do condomínio e a confirmação da baixa cadastral, meu acesso será cancelado, observados os prazos e as hipóteses legais aplicáveis à conservação, bloqueio, anonimização ou eliminação dos dados.' || E'\n\n' ||
  'Declaro que tive acesso às informações sobre as finalidades do tratamento, direitos do titular, identificação dos responsáveis pelo tratamento e canais de contato disponibilizados.',
  '', 'published', now(), 'Versão inicial do termo padrão da plataforma (texto-base sujeito à revisão jurídica).');

-- Aceite: pode apontar para o termo global (privacy_term_id fica nulo) e guarda o texto exibido.
alter table public.privacy_acknowledgements alter column privacy_term_id drop not null;
alter table public.privacy_acknowledgements add column global_term_id uuid references public.privacy_terms_global(id);
alter table public.privacy_acknowledgements add column displayed_text_hash text;
alter table public.privacy_acknowledgements add column tenant_name_shown text;
alter table public.privacy_acknowledgements add constraint privacy_ack_one_source
  check ((privacy_term_id is null) <> (global_term_id is null));
alter table public.privacy_acknowledgements drop constraint if exists privacy_acknowledgements_action_source_check;
alter table public.privacy_acknowledgements add constraint privacy_acknowledgements_action_source_check
  check (action_source in ('cadastro_portal', 'portal_reaceite', 'cadastro_completo'));
create unique index privacy_ack_once_global on public.privacy_acknowledgements (tenant_id, user_id, global_term_id) where global_term_id is not null;

-- Termo aplicável ao condomínio: o próprio (se o síndico publicou) ou o global. Texto já com o nome do condomínio.
-- Placeholder só aceita o nome do PRÓPRIO condomínio (vem da linha de tenants, nunca do navegador).
create or replace function app.privacy_term_effective(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.privacy_terms; g public.privacy_terms_global; v_name text; v_text text;
begin
  select coalesce(b.display_name, x.name) into v_name from public.tenants x left join public.tenant_branding b on b.tenant_id = x.id where x.id = p_tenant;
  select * into t from public.privacy_terms where tenant_id = p_tenant and status = 'published';
  if found then
    return jsonb_build_object('scope', 'tenant', 'id', t.id, 'version', t.version, 'title', t.title, 'content', t.content,
      'template_hash', t.content_hash, 'hash', t.content_hash, 'published_at', t.published_at, 'tenant_name', v_name);
  end if;
  select * into g from public.privacy_terms_global where status = 'published';
  if not found then return null; end if;
  v_text := replace(g.content, '{{CONDOMINIO}}', coalesce(v_name, 'condomínio'));
  return jsonb_build_object('scope', 'global', 'id', g.id, 'version', g.version, 'title', g.title, 'content', v_text,
    'template_hash', g.content_hash, 'hash', app.sha256_hex(g.title || E'\n' || v_text), 'published_at', g.published_at, 'tenant_name', v_name);
end $$;

-- Público: termo que o morador vai ler (texto com o nome do condomínio + hash desse texto).
create or replace function public.privacy_term_current(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select app.privacy_term_effective(t.id) - 'template_hash'
    from public.tenants t where t.slug = lower(btrim(p_slug)) and t.status = 'active'
$$;

-- Registra o aceite do termo aplicável. O hash que o navegador leu precisa ser o do texto vigente.
create or replace function app.privacy_record_ack(p_tenant uuid, p_user uuid, p_request uuid, p_hash text, p_source text) returns text
language plpgsql security definer set search_path = '' as $$
declare e jsonb := app.privacy_term_effective(p_tenant); v_id uuid;
begin
  if e is null then raise exception 'Termo de tratamento de dados indisponível no momento. Tente novamente em instantes.' using errcode = 'P0001'; end if;
  if p_hash is null or p_hash is distinct from e->>'hash' then
    raise exception 'Leia e aceite o termo de tratamento de dados vigente para enviar o cadastro.' using errcode = '22023';
  end if;
  if e->>'scope' = 'tenant' then
    insert into public.privacy_acknowledgements (tenant_id, user_id, access_request_id, privacy_term_id, term_version, term_hash, displayed_text_hash, tenant_name_shown, accepted_at, action_source, statement)
    values (p_tenant, p_user, p_request, (e->>'id')::uuid, e->>'version', e->>'template_hash', e->>'hash', e->>'tenant_name', app.now(), p_source,
      'Li e estou ciente do Termo de Tratamento de Dados Pessoais e das finalidades de utilização do Portal Portaria Prime.')
    on conflict (tenant_id, user_id, privacy_term_id) do nothing returning id into v_id;
    if v_id is null then
      update public.privacy_acknowledgements set access_request_id = p_request
       where tenant_id = p_tenant and user_id = p_user and privacy_term_id = (e->>'id')::uuid and access_request_id is null;
    end if;
  else
    insert into public.privacy_acknowledgements (tenant_id, user_id, access_request_id, global_term_id, term_version, term_hash, displayed_text_hash, tenant_name_shown, accepted_at, action_source, statement)
    values (p_tenant, p_user, p_request, (e->>'id')::uuid, e->>'version', e->>'template_hash', e->>'hash', e->>'tenant_name', app.now(), p_source,
      'Li e estou ciente do Termo de Tratamento de Dados Pessoais e das finalidades de utilização do Portal Portaria Prime.')
    on conflict (tenant_id, user_id, global_term_id) where global_term_id is not null do nothing returning id into v_id;
    if v_id is null then
      update public.privacy_acknowledgements set access_request_id = p_request
       where tenant_id = p_tenant and user_id = p_user and global_term_id = (e->>'id')::uuid and access_request_id is null;
    end if;
  end if;
  return e->>'version';
end $$;

-- -----------------------------------------------------------------------------
-- 2) Unidades públicas do portal (para o seletor de bloco/unidade). Só rótulos; sem moradores nem contagens.
-- -----------------------------------------------------------------------------
create or replace function public.portal_units(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('has_blocks', coalesce(bool_or(nullif(btrim(u.block), '') is not null), false),
    'units', coalesce(jsonb_agg(jsonb_build_object('block', nullif(btrim(u.block), ''), 'label', u.label)
      order by nullif(btrim(u.block), '') nulls first, length(u.label), u.label), '[]'::jsonb))
    from public.tenants t left join public.units u on u.tenant_id = t.id and u.active
   where t.slug = lower(btrim(p_slug)) and t.status = 'active'
   group by t.id
$$;

-- Celular brasileiro -> E.164 (+55DD9NNNNNNNN). Nulo se vazio; erro se inválido.
-- Campo do cadastro é "celular / WhatsApp": exige 11 dígitos com 9 após o DDD (fixo não recebe WhatsApp/SMS).
create or replace function app.phone_e164(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text := app.digits(p);
begin
  if d is null then return null; end if;
  if length(d) = 13 and left(d, 2) = '55' then d := substr(d, 3); end if;
  if length(d) <> 11 or left(d, 1) = '0' or substr(d, 1, 2)::int < 11 or substr(d, 3, 1) <> '9' then
    raise exception 'Celular inválido: informe DDD + número (ex.: 11 99999-0000).' using errcode = '22023';
  end if;
  return '+55' || d;
end $$;

-- -----------------------------------------------------------------------------
-- 3) Pedido de cadastro (substitui a versão de 0100; mesma assinatura e regras + termo global + avisos).
-- -----------------------------------------------------------------------------
create or replace function public.request_access(p_slug text, p_full_name text, p_phone text, p_block text, p_unit text, p_privacy_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t public.tenants; v_unit uuid; v_req uuid; v_phone text; v_version text; v_new boolean := false; v_email text; v_name text;
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  perform app.require(app.email_verified(), 'Confirme seu e-mail antes de solicitar o cadastro.');
  select * into v_t from public.tenants where slug = lower(btrim(p_slug)) and status = 'active';
  if not found then raise exception 'Condomínio não encontrado ou indisponível.' using errcode = 'P0002'; end if;
  if exists (select 1 from public.tenant_memberships where tenant_id = v_t.id and user_id = auth.uid() and role = 'morador' and status = 'active') then
    raise exception 'Você já tem acesso de morador neste condomínio.' using errcode = 'P0001';
  end if;
  if length(btrim(coalesce(p_full_name, ''))) < 2 or btrim(p_full_name) !~ '\S+\s+\S+' then
    raise exception 'Informe seu nome completo (nome e sobrenome).' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_unit, ''))) = 0 then raise exception 'Informe sua unidade.' using errcode = '22023'; end if;
  v_phone := app.phone_e164(p_phone);
  if v_phone is null then raise exception 'Informe seu celular com DDD.' using errcode = '22023'; end if;
  -- Bloco obrigatório quando o condomínio organiza unidades por bloco.
  if exists (select 1 from public.units where tenant_id = v_t.id and active and nullif(btrim(block), '') is not null)
     and length(btrim(coalesce(p_block, ''))) = 0 then
    raise exception 'Informe seu bloco ou torre.' using errcode = '22023';
  end if;
  -- Limite de abuso: 5 solicitações por pessoa por dia em todos os condomínios.
  if not exists (select 1 from public.access_requests where tenant_id = v_t.id and user_id = auth.uid() and status = 'pending')
     and (select count(*) from public.access_requests where user_id = auth.uid() and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Muitas solicitações. Tente novamente amanhã.' using errcode = 'P0001';
  end if;
  select id into v_unit from public.units
   where tenant_id = v_t.id and active and app.norm_unit(label) = app.norm_unit(p_unit)
     and coalesce(app.norm_block(block), '') = coalesce(app.norm_block(p_block), '') limit 1;
  -- Uma solicitação pendente por pessoa e condomínio (concorrência: trava a linha / unique parcial).
  select id into v_req from public.access_requests where tenant_id = v_t.id and user_id = auth.uid() and status = 'pending' for update;
  if found then
    update public.access_requests set full_name = btrim(p_full_name), phone = v_phone, block_text = nullif(btrim(p_block), ''),
      unit_text = btrim(p_unit), unit_id = v_unit where id = v_req;
  else
    insert into public.access_requests (tenant_id, user_id, full_name, phone, block_text, unit_text, unit_id)
    values (v_t.id, auth.uid(), btrim(p_full_name), v_phone, nullif(btrim(p_block), ''), btrim(p_unit), v_unit)
    returning id into v_req;
    v_new := true;
  end if;
  -- Aceite na mesma transação do pedido: ou os dois ficam registrados, ou nenhum.
  v_version := app.privacy_record_ack(v_t.id, auth.uid(), v_req, p_privacy_hash, 'cadastro_portal');
  -- Enviado: o rascunho do cadastro (se houver) deixa de valer, para não recriar o pedido depois de uma recusa.
  delete from public.resident_signup_drafts where user_id = auth.uid() and tenant_id = v_t.id;
  -- Perfil: nome e telefone do morador (o pedido é a fonte; o perfil acompanha).
  update public.profiles set full_name = btrim(p_full_name), phone = coalesce(phone, v_phone) where id = auth.uid();
  if v_new then
    select lower(email) into v_email from auth.users where id = auth.uid();
    -- Quem aprova: central + push + e-mail (sem dados do solicitante no push).
    insert into public.notifications (tenant_id, user_id, kind, title, body)
    select v_t.id, m.user_id, 'access_request', 'Nova solicitação de cadastro', 'Um morador pediu acesso. Revise em Unidades e moradores.'
      from public.tenant_memberships m where m.tenant_id = v_t.id and m.role = 'admin' and m.status = 'active' and 'approve' = any (m.permissions);
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id)
    select v_t.id, 'access_request', c.ch, case c.ch when 'push' then m.user_id::text else lower(u.email) end, v_req::text
      from public.tenant_memberships m join auth.users u on u.id = m.user_id cross join (values ('push'), ('email')) c(ch)
     where m.tenant_id = v_t.id and m.role = 'admin' and m.status = 'active' and 'approve' = any (m.permissions)
    on conflict do nothing;
    -- Morador: confirmação de recebimento (e-mail sempre; WhatsApp se o condomínio tiver canal conectado).
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
    values (v_t.id, 'access_received', 'email', v_email, v_req::text, '{}'::jsonb) on conflict do nothing;
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
    values (v_t.id, 'access_received', 'whatsapp', v_phone, v_req::text, '{}'::jsonb) on conflict do nothing;
  end if;
  perform app.audit(v_t.id, case when v_new then 'access_request.created' else 'access_request.updated' end, 'access_request', v_req::text,
    jsonb_build_object('privacy_term', v_version, 'unit_matched', v_unit is not null));
  return jsonb_build_object('request_id', v_req, 'status', 'pending', 'slug', v_t.slug, 'privacy_version', v_version, 'created', v_new);
end $$;

-- Uma pendente por pessoa e condomínio (protege contra corrida entre duas abas).
create unique index if not exists access_requests_one_pending on public.access_requests (tenant_id, user_id) where status = 'pending';

-- A aprovação antiga (decide_access_request_before_privacy) monta o contato com '+55' || phone, pensada para
-- telefone só com dígitos. Agora o pedido já guarda E.164 (+55...): normaliza na mesma regra, aceitando os dois.
do $$
declare src text;
begin
  select pg_get_functiondef('public.decide_access_request_before_privacy(uuid, boolean, uuid, text)'::regprocedure) into src;
  if src !~ 'when r.phone like ''\+%'' then r.phone' then
    src := replace(src, 'case when r.phone is null then null when r.phone like ''55%'' then ''+'' || r.phone else ''+55'' || r.phone end',
                        'case when r.phone is null then null when r.phone like ''+%'' then r.phone when r.phone like ''55%'' then ''+'' || r.phone else ''+55'' || r.phone end');
    if src !~ 'when r.phone like ''\+%'' then r.phone' then raise exception 'Não foi possível ajustar o telefone na aprovação.'; end if;
    execute src;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 4) Rascunho do cadastro antes da sessão (confirmação de e-mail ligada): guardado pelo servidor
--    no momento do signUp, finalizado no primeiro login. Sem senha; expira em 7 dias.
-- -----------------------------------------------------------------------------
create table public.resident_signup_drafts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null check (length(full_name) between 2 and 120),
  phone text not null check (phone ~ '^\+55\d{11}$'),
  block_text text check (block_text is null or length(block_text) <= 30),
  unit_text text not null check (length(unit_text) between 1 and 30),
  privacy_hash text not null,
  created_at timestamptz not null default now()
);
alter table public.resident_signup_drafts enable row level security;
revoke all on public.resident_signup_drafts from public, anon, authenticated;
grant all on public.resident_signup_drafts to service_role;

-- Gatilho do Auth: o signUp manda os dados do cadastro em user_metadata.pp_signup (o servidor valida tudo de novo
-- ao finalizar). Guardamos só o necessário e tiramos o resto do metadata (não fica no token).
create or replace function app.resident_signup_capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare s jsonb := new.raw_user_meta_data -> 'pp_signup'; v_t uuid; v_phone text;
begin
  if s is null or jsonb_typeof(s) <> 'object' then return new; end if;
  begin
    select id into v_t from public.tenants where slug = lower(btrim(s->>'slug')) and status = 'active';
    v_phone := app.phone_e164(s->>'phone');
    if v_t is not null and v_phone is not null and length(btrim(coalesce(s->>'full_name', ''))) >= 2 and length(btrim(coalesce(s->>'unit', ''))) > 0 then
      insert into public.resident_signup_drafts (user_id, tenant_id, full_name, phone, block_text, unit_text, privacy_hash)
      values (new.id, v_t, left(btrim(s->>'full_name'), 120), v_phone, nullif(left(btrim(coalesce(s->>'block', '')), 30), ''),
              left(btrim(s->>'unit'), 30), coalesce(s->>'privacy_hash', ''))
      on conflict (user_id) do nothing;
    end if;
  exception when others then
    -- Dados inválidos não impedem a criação da conta: o morador completa só o que faltar depois.
    null;
  end;
  return new;
end $$;
create trigger on_auth_user_resident_signup after insert on auth.users
  for each row execute function app.resident_signup_capture();

-- Finaliza o cadastro guardado (idempotente): cria o pedido + aceite. Chamado após o login/confirmação.
create or replace function public.resident_signup_finalize() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.resident_signup_drafts; v_slug text; r jsonb;
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  select * into d from public.resident_signup_drafts where user_id = auth.uid() for update;
  if not found then return jsonb_build_object('status', 'none'); end if;
  select slug into v_slug from public.tenants where id = d.tenant_id;
  if d.created_at < now() - interval '7 days' then
    delete from public.resident_signup_drafts where user_id = auth.uid();
    return jsonb_build_object('status', 'expired', 'slug', v_slug);
  end if;
  begin
    r := public.request_access(v_slug, d.full_name, d.phone, d.block_text, d.unit_text, d.privacy_hash);
  exception when others then
    -- Termo mudou entre o cadastro e a confirmação (ou dado deixou de valer): o morador revê só isso.
    return jsonb_build_object('status', 'needs_review', 'slug', v_slug, 'reason', sqlerrm,
      'draft', jsonb_build_object('full_name', d.full_name, 'phone', d.phone, 'block', d.block_text, 'unit', d.unit_text));
  end;
  delete from public.resident_signup_drafts where user_id = auth.uid();
  return r || jsonb_build_object('status', 'created');
end $$;

-- -----------------------------------------------------------------------------
-- 5) Estado do próprio pedido: inclui o rascunho pendente (para a tela certa após login).
-- -----------------------------------------------------------------------------
create or replace function public.my_access_request(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('status', case when r.status = 'approved' and not exists (
        select 1 from public.tenant_memberships m where m.tenant_id = r.tenant_id and m.user_id = auth.uid() and m.role = 'morador' and m.status = 'active')
        then 'revoked' else r.status end,
      'full_name', r.full_name, 'block_text', r.block_text, 'unit', r.unit_text,
      'unit_text', concat_ws(' ', r.block_text, r.unit_text), 'reason', r.reason, 'created_at', r.created_at, 'decided_at', r.decided_at,
      'privacy_version', (select a.term_version from public.privacy_acknowledgements a where a.access_request_id = r.id order by a.accepted_at desc limit 1),
      'email', (select email from auth.users where id = auth.uid()))
      from public.access_requests r join public.tenants t on t.id = r.tenant_id
     where t.slug = lower(btrim(p_slug)) and r.user_id = auth.uid() order by r.created_at desc limit 1),
    (select jsonb_build_object('status', 'draft') from public.resident_signup_drafts d join public.tenants t on t.id = d.tenant_id
      where t.slug = lower(btrim(p_slug)) and d.user_id = auth.uid()))
$$;

-- Fila do síndico: também o estado do e-mail e do aceite.
create or replace function public.list_access_requests(p_tenant uuid, p_status text default 'pending') returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'approve') then coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'full_name', r.full_name, 'email', u.email, 'email_verified', u.email_confirmed_at is not null, 'phone', r.phone,
    'block_text', r.block_text, 'unit_text', r.unit_text, 'unit_id', r.unit_id, 'status', r.status, 'reason', r.reason,
    'created_at', r.created_at, 'decided_at', r.decided_at,
    'privacy_version', a.term_version, 'privacy_accepted_at', a.accepted_at) order by r.created_at desc), '[]') end
  from public.access_requests r join auth.users u on u.id = r.user_id
  left join lateral (select term_version, accepted_at from public.privacy_acknowledgements x
                      where x.access_request_id = r.id order by x.accepted_at desc limit 1) a on true
  where r.tenant_id = p_tenant and (p_status is null or r.status = p_status)
$$;

-- Contador para o menu (quem aprova).
create or replace function public.access_requests_pending_count(p_tenant uuid) returns int
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'approve') then (select count(*)::int from public.access_requests where tenant_id = p_tenant and status = 'pending') else 0 end
$$;

-- Aprovação exige aceite registrado (de qualquer termo: global ou do condomínio). Sem efeito retroativo:
-- pedidos de antes desta migration sem aceite continuam aprováveis (não havia como aceitar).
create or replace function app.access_request_requires_ack(r public.access_requests) returns boolean
language sql stable security definer set search_path = '' as $$
  select r.created_at >= (select coalesce(min(published_at), 'infinity'::timestamptz) from public.privacy_terms_global)
      or exists (select 1 from public.privacy_terms p where p.tenant_id = r.tenant_id and p.status in ('published', 'archived') and p.published_at <= r.created_at)
$$;

-- Decisão: e-mail e WhatsApp ao morador (aprovado: boas-vindas com o link do condomínio).
create or replace function public.decide_access_request(p_request uuid, p_approve boolean, p_unit uuid default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.access_requests; res jsonb;
begin
  select * into r from public.access_requests where id = p_request for update;
  if found and p_approve and r.status = 'pending' and app.access_request_requires_ack(r)
     and not exists (select 1 from public.privacy_acknowledgements where access_request_id = r.id) then
    raise exception 'Este cadastro não tem o aceite do termo de dados registrado. Peça ao morador que envie o cadastro novamente.' using errcode = 'P0001';
  end if;
  res := public.decide_access_request_before_privacy(p_request, p_approve, p_unit, p_reason);
  if found and coalesce((res->>'replayed')::boolean, false) = false and r.phone is not null then
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
    values (r.tenant_id, 'access_decision', 'whatsapp', r.phone, r.id::text, jsonb_build_object('approved', p_approve))
    on conflict do nothing;
  end if;
  return res;
end $$;

-- -----------------------------------------------------------------------------
-- 6) Outbox: evento novo e quem pode receber cada um.
-- -----------------------------------------------------------------------------
alter table public.notification_jobs drop constraint if exists notification_jobs_event_check;
alter table public.notification_jobs add constraint notification_jobs_event_check check (event in
  ('package_received', 'package_picked_up', 'invitation', 'trial_reminder', 'billing_order', 'billing_paid', 'ops_alert',
   'access_request', 'access_decision', 'portal_welcome', 'package_reminder', 'quote_sent', 'contract_copy', 'support_reply',
   'access_received'));   -- confirmação ao morador: cadastro recebido

-- Regras do cadastro do morador (só para o próprio solicitante, pelo e-mail da conta ou o celular do pedido).
create or replace function app.resident_signup_notification_allowed(j public.notification_jobs) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.access_requests r join auth.users u on u.id = r.user_id
     where r.id::text = j.ref_id and r.tenant_id = j.tenant_id
       and ((j.channel = 'email' and lower(u.email) = j.recipient) or (j.channel = 'whatsapp' and r.phone = j.recipient)))
$$;

-- Encadeia: access_received e access_decision por WhatsApp; access_request por e-mail já é aceito pela regra base.
do $$
declare src text;
begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if src !~ 'resident_signup_notification_allowed' then
    src := regexp_replace(src, '(begin\s*\r?\n)',
      E'\\1  if j.event = ''access_received'' or (j.event = ''access_decision'' and j.channel = ''whatsapp'') then\n    return exists(select 1 from public.tenants where id = j.tenant_id and status = ''active'') and app.resident_signup_notification_allowed(j);\n  end if;\n');
    if src !~ 'resident_signup_notification_allowed' then raise exception 'Não foi possível encadear notification_allowed.'; end if;
    execute src;
  end if;
end $$;

-- Contexto do template: nome do morador e situação do pedido (sem e-mail/telefone).
-- A versão vigente vira app.notification_context_core_signup e a nova a envolve (padrão de 0400_support).
alter function public.notification_context(uuid) rename to notification_context_core_signup;
alter function public.notification_context_core_signup(uuid) set schema app;
create function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := app.notification_context_core_signup(p_job); j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job;
  if j.event in ('access_received', 'access_decision', 'access_request') then
    v := coalesce(v, '{}'::jsonb) || jsonb_build_object('resident', (select jsonb_build_object('name', split_part(btrim(r.full_name), ' ', 1),
      'unit', concat_ws(' ', r.block_text, r.unit_text), 'reason', r.reason) from public.access_requests r where r.id::text = j.ref_id and r.tenant_id = j.tenant_id));
  end if;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- 7) Administração da plataforma: versões do termo global (síndico só consulta).
-- -----------------------------------------------------------------------------
create or replace function public.platform_privacy_terms() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.platform_require('legal');
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'version', g.version, 'title', g.title, 'content', g.content, 'hash', g.content_hash,
    'status', g.status, 'change_note', g.change_note, 'published_at', g.published_at, 'created_at', g.created_at,
    'acknowledgements', (select count(*) from public.privacy_acknowledgements a where a.global_term_id = g.id)) order by g.created_at desc)
    from public.privacy_terms_global g), '[]'::jsonb);
end $$;

create or replace function public.platform_privacy_term_save(p_id uuid, p_version text, p_title text, p_content text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.privacy_terms_global;
begin
  perform app.platform_require('legal_manage');
  if p_content !~ '\{\{CONDOMINIO\}\}' then raise exception 'O texto precisa conter {{CONDOMINIO}} (nome do condomínio do morador).' using errcode = '22023'; end if;
  if p_id is null then
    begin
      insert into public.privacy_terms_global (version, title, content, content_hash, change_note, created_by)
      values (btrim(p_version), btrim(p_title), p_content, '', nullif(btrim(p_note), ''), auth.uid()) returning * into g;
    exception when unique_violation then raise exception 'Já existe a versão % do termo.', p_version using errcode = '23505';
    end;
  else
    update public.privacy_terms_global set title = btrim(p_title), content = p_content, change_note = nullif(btrim(p_note), '')
     where id = p_id and status = 'draft' returning * into g;
    if not found then raise exception 'Só rascunho pode ser editado.' using errcode = 'P0001'; end if;
  end if;
  perform app.audit(null, 'privacy_term_global.saved', 'privacy_term_global', g.id::text, jsonb_build_object('version', g.version, 'hash', g.content_hash));
  return jsonb_build_object('id', g.id, 'status', g.status, 'hash', g.content_hash);
exception when check_violation then
  raise exception 'Termo inválido: versão (letras, números, ponto e hífen), título de 3 a 200 e texto de 50 a 50.000 caracteres.' using errcode = '22023';
end $$;

create or replace function public.platform_privacy_term_publish(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.privacy_terms_global; v_prev uuid;
begin
  perform app.platform_require('legal_manage');
  perform app.mdm_require_recent_auth();
  select * into g from public.privacy_terms_global where id = p_id for update;
  if not found then raise exception 'Termo não encontrado.' using errcode = 'P0002'; end if;
  if g.status <> 'draft' then raise exception 'Só rascunho pode ser publicado.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('privacy_term_global'));
  update public.privacy_terms_global set status = 'archived' where status = 'published' returning id into v_prev;
  update public.privacy_terms_global set status = 'published', published_at = app.now(), published_by = auth.uid() where id = g.id returning * into g;
  perform app.audit(null, 'privacy_term_global.published', 'privacy_term_global', g.id::text,
    jsonb_build_object('version', g.version, 'hash', g.content_hash, 'previous_id', v_prev));
  return jsonb_build_object('id', g.id, 'version', g.version, 'hash', g.content_hash, 'previous_id', v_prev);
end $$;

-- Síndico: consulta o termo aplicável (global ou do condomínio) e o histórico do condomínio.
create or replace function public.privacy_terms_admin(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings') or app.has_perm(p_tenant, 'approve'), 'Sem permissão para ver o termo do condomínio.');
  return jsonb_build_object(
    'effective', app.privacy_term_effective(p_tenant) - 'template_hash',
    'global_acknowledgements', (select count(*) from public.privacy_acknowledgements a where a.tenant_id = p_tenant and a.global_term_id is not null),
    'default_title', 'Termo de ciência e aceite — Proteção de dados pessoais',
    'default_content', app.privacy_term_default(),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'version', t.version, 'title', t.title, 'content', t.content,
        'hash', t.content_hash, 'status', t.status, 'change_note', t.change_note, 'published_at', t.published_at, 'created_at', t.created_at,
        'acknowledgements', (select count(*) from public.privacy_acknowledgements a where a.privacy_term_id = t.id)) order by t.created_at desc)
      from public.privacy_terms t where t.tenant_id = p_tenant), '[]'::jsonb));
end $$;

-- Aceites: lista inclui os do termo global.
create or replace function public.privacy_acknowledgements_list(p_tenant uuid, p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros vê os registros de aceite.');
  return jsonb_build_object(
    'total', (select count(*) from public.privacy_acknowledgements where tenant_id = p_tenant),
    'rows', coalesce((select jsonb_agg(x order by x.accepted_at desc) from (
      select a.id, a.accepted_at, a.term_version, a.term_hash, a.displayed_text_hash, a.action_source,
             case when a.global_term_id is not null then 'global' else 'condominio' end scope,
             r.full_name, concat_ws(' ', r.block_text, r.unit_text) unit_text, r.status request_status, a.access_request_id
        from public.privacy_acknowledgements a left join public.access_requests r on r.id = a.access_request_id
       where a.tenant_id = p_tenant order by a.accepted_at desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) x), '[]'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- 8) Recuperação de cadastros incompletos (sem aprovar, sem atribuir unidade, sem aceite retroativo).
-- -----------------------------------------------------------------------------
-- Contas criadas pelo portal que nunca enviaram o pedido aparecem para quem aprova como "cadastro não concluído";
-- o próprio morador conclui ao entrar (tela única, só com o que falta).
create or replace function public.access_incomplete_signups(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when app.has_perm(p_tenant, 'approve') then coalesce(jsonb_agg(jsonb_build_object('full_name', d.full_name,
    'block_text', d.block_text, 'unit_text', d.unit_text, 'created_at', d.created_at) order by d.created_at desc), '[]') end
  from public.resident_signup_drafts d where d.tenant_id = p_tenant
$$;

-- -----------------------------------------------------------------------------
-- Permissões
-- -----------------------------------------------------------------------------
revoke all on function app.privacy_term_global_guard(), app.privacy_term_effective(uuid), app.privacy_record_ack(uuid, uuid, uuid, text, text),
  app.phone_e164(text), app.resident_signup_capture(), app.resident_signup_notification_allowed(public.notification_jobs),
  app.notification_context_core_signup(uuid) from public, anon, authenticated;
grant execute on function app.notification_context_core_signup(uuid) to service_role;
revoke all on function public.portal_units(text), public.resident_signup_finalize(), public.access_requests_pending_count(uuid),
  public.platform_privacy_terms(), public.platform_privacy_term_save(uuid, text, text, text, text), public.platform_privacy_term_publish(uuid),
  public.access_incomplete_signups(uuid), public.notification_context(uuid) from public, anon;
grant execute on function public.portal_units(text) to anon, authenticated;
grant execute on function public.resident_signup_finalize(), public.access_requests_pending_count(uuid), public.platform_privacy_terms(),
  public.platform_privacy_term_save(uuid, text, text, text, text), public.platform_privacy_term_publish(uuid), public.access_incomplete_signups(uuid) to authenticated;
revoke all on function public.notification_context(uuid) from authenticated;
grant execute on function public.notification_context(uuid) to service_role;
-- request_access/my_access_request/list_access_requests/decide_access_request/privacy_terms_admin/
-- privacy_acknowledgements_list/privacy_term_current: redefinidas com a mesma assinatura (grants preservados).
