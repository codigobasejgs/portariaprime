-- =============================================================================
-- Contrato v1.0 com preenchimento automático e assinatura bilateral na Autentique.
-- Aditiva: o aceite (contract_acceptances) continua sendo a evidência imutável; esta
-- migration acrescenta o endereço do contratante, o rastreio da assinatura nas duas
-- partes, o log idempotente de webhooks e o envio do PDF assinado pelo outbox.
-- Todas as escritas passam pela API (service_role) depois de conferir o estado do
-- documento direto na API da Autentique (webhook nunca é confiado sozinho).
-- =============================================================================

-- Campos do contratante/plano preenchidos por aceite: não bloqueiam a publicação do modelo.
create or replace function app.contract_client_marks() returns text[]
language sql immutable set search_path = '' as $$
  select array['{{CONDOMINIO_NOME}}','{{CONDOMINIO_CNPJ}}','{{CONDOMINIO_ENDERECO}}','{{SINDICO_NOME}}','{{SINDICO_CPF}}',
    '{{SINDICO_EMAIL}}','{{SINDICO_TELEFONE}}','{{PLANO_NOME}}','{{PLANO_VALOR_MENSAL}}','{{PLANO_VALOR_EXTENSO}}',
    '{{PLANO_LIMITE_DESCRICAO}}','{{TAXA_IMPLANTACAO_DESCRICAO}}','{{DATA_INICIO_TRIAL}}','{{DATA_FIM_TRIAL}}',
    '{{DIA_VENCIMENTO}}','{{DATA_EXTENSO_CONTRATO}}','{{AUTENTIQUE_DOCUMENT_ID}}','{{CONTRACT_SHA256_HASH}}']
$$;

create or replace function app.legal_pending_marks(p text) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct m[1]), '{}') from regexp_matches(coalesce(p, ''),
    '(\{\{[A-Z0-9_]+\}\}|\[(?:PENDENTE|A DEFINIR|A VERIFICAR)[^\]]*\])', 'g') m
  where m[1] <> all (app.contract_client_marks())
$$;

-- -----------------------------------------------------------------------------
-- Assinatura por aceite (1:1). Endereço e hash do texto preenchido são evidência.
-- -----------------------------------------------------------------------------
create table if not exists public.contract_signatures (
  acceptance_id uuid primary key references public.contract_acceptances(id),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  contractor_address text not null check (length(btrim(contractor_address)) between 10 and 300),
  contract_text_sha256 text check (contract_text_sha256 is null or contract_text_sha256 ~ '^[0-9a-f]{64}$'),
  provider text not null default 'autentique' check (provider = 'autentique'),
  sandbox boolean not null default false,
  autentique_document_id text unique check (autentique_document_id is null or autentique_document_id ~ '^[0-9A-Za-z_-]{8,120}$'),
  autentique_contractor_signer_id text check (autentique_contractor_signer_id is null or length(autentique_contractor_signer_id) <= 120),
  autentique_contractor_sign_url text check (autentique_contractor_sign_url is null or autentique_contractor_sign_url ~ '^https://'),
  autentique_owner_signer_id text check (autentique_owner_signer_id is null or length(autentique_owner_signer_id) <= 120),
  autentique_owner_sign_url text check (autentique_owner_sign_url is null or autentique_owner_sign_url ~ '^https://'),
  owner_name text check (owner_name is null or length(owner_name) <= 200),
  owner_email text check (owner_email is null or (owner_email = lower(btrim(owner_email)) and owner_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  contract_status text not null default 'pending_send' check (contract_status in
    ('pending_send', 'not_configured', 'send_failed', 'awaiting_signatures', 'signed_by_contractor', 'signed_by_owner', 'fully_signed', 'rejected')),
  contractor_signed_at timestamptz,
  owner_signed_at timestamptz,
  fully_signed_at timestamptz,
  rejected_at timestamptz,
  rejected_reason text check (rejected_reason is null or length(rejected_reason) <= 500),
  signed_pdf_path text,
  signed_pdf_sha256 text check (signed_pdf_sha256 is null or signed_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  last_error text check (last_error is null or length(last_error) <= 500),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contract_signatures_tenant_idx on public.contract_signatures (tenant_id, created_at desc);

-- Evidência não muda; ids da Autentique e PDF assinado só são gravados uma vez; ninguém apaga.
create or replace function app.contract_signature_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Registro de assinatura é permanente.' using errcode = '42501'; end if;
  if new.acceptance_id <> old.acceptance_id or new.tenant_id <> old.tenant_id or new.contractor_address <> old.contractor_address
     or (old.contract_text_sha256 is not null and new.contract_text_sha256 is distinct from old.contract_text_sha256)
     or (old.autentique_document_id is not null and new.autentique_document_id is distinct from old.autentique_document_id)
     or (old.signed_pdf_path is not null and (new.signed_pdf_path is distinct from old.signed_pdf_path or new.signed_pdf_sha256 is distinct from old.signed_pdf_sha256))
     or (old.contractor_signed_at is not null and new.contractor_signed_at is distinct from old.contractor_signed_at)
     or (old.owner_signed_at is not null and new.owner_signed_at is distinct from old.owner_signed_at) then
    raise exception 'Evidências da assinatura são imutáveis.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists contract_signature_guard on public.contract_signatures;
create trigger contract_signature_guard before update or delete on public.contract_signatures
  for each row execute function app.contract_signature_guard();

-- Webhooks recebidos (idempotência por id do evento da Autentique).
create table if not exists public.autentique_webhook_events (
  event_id text primary key check (length(event_id) between 8 and 200),
  event_type text not null check (length(event_type) <= 80),
  document_id text check (document_id is null or length(document_id) <= 120),
  signature_valid boolean,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'error')),
  error text check (error is null or length(error) <= 500),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.contract_signatures enable row level security;
alter table public.autentique_webhook_events enable row level security;
revoke all on public.contract_signatures, public.autentique_webhook_events from public, anon, authenticated;
grant all on public.contract_signatures, public.autentique_webhook_events to service_role;

-- -----------------------------------------------------------------------------
-- Aceite v1.0: mesmo aceite de sempre + endereço; CPF e telefone do síndico obrigatórios.
-- -----------------------------------------------------------------------------
create or replace function public.contract_accept_v2(
  p_actor uuid, p_tenant uuid, p_document_sha256 text, p_accepted boolean,
  p_plan_code text, p_cycle text, p_proposal text,
  p_contractor_name text, p_contractor_document text, p_contractor_address text,
  p_rep_name text, p_rep_cpf text, p_rep_email text, p_rep_phone text, p_rep_role text, p_rep_authority text,
  p_ip text, p_user_agent text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app.cpf_valid(app.digits(p_rep_cpf)) then raise exception 'CPF do síndico inválido.' using errcode = '22023'; end if;
  if coalesce(length(app.digits(p_rep_phone)), 0) not between 10 and 13 then raise exception 'Informe o WhatsApp do síndico com DDD.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_contractor_address, ''))) not between 10 and 300 then raise exception 'Endereço do condomínio inválido.' using errcode = '22023'; end if;
  v := public.contract_accept(p_actor, p_tenant, p_document_sha256, p_accepted, p_plan_code, p_cycle, p_proposal,
    p_contractor_name, p_contractor_document, p_rep_name, p_rep_cpf, p_rep_email, p_rep_phone, p_rep_role, p_rep_authority, p_ip, p_user_agent);
  insert into public.contract_signatures (acceptance_id, tenant_id, contractor_address) values ((v ->> 'id')::uuid, p_tenant, btrim(p_contractor_address));
  return v || jsonb_build_object('contractor_address', btrim(p_contractor_address));
end $$;

-- Dados para preencher o contrato (somente backend).
create or replace function public.contract_fill_data(p_acceptance uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.contract_pdf_data(a.id) || jsonb_build_object(
    'contractor_address', s.contractor_address, 'signature', to_jsonb(s),
    'trial_started_at', sub.trial_started_at, 'trial_ends_at', sub.trial_ends_at, 'current_period_end', sub.current_period_end,
    'subscription_status', sub.status)
  from public.contract_acceptances a
  left join public.contract_signatures s on s.acceptance_id = a.id
  left join public.subscriptions sub on sub.tenant_id = a.tenant_id
  where a.id = p_acceptance
$$;

create or replace function public.contract_signature_prepared(p_acceptance uuid, p_text_sha256 text) returns void
language sql security definer set search_path = '' as $$
  update public.contract_signatures set contract_text_sha256 = p_text_sha256
   where acceptance_id = p_acceptance and contract_text_sha256 is null and p_text_sha256 ~ '^[0-9a-f]{64}$'
$$;

create or replace function public.contract_signature_sent(p_acceptance uuid, p_document_id text, p_contractor_id text, p_contractor_url text,
  p_owner_id text, p_owner_url text, p_owner_name text, p_owner_email text, p_sandbox boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.contract_signatures;
begin
  update public.contract_signatures set autentique_document_id = p_document_id, autentique_contractor_signer_id = p_contractor_id,
    autentique_contractor_sign_url = p_contractor_url, autentique_owner_signer_id = p_owner_id, autentique_owner_sign_url = p_owner_url,
    owner_name = left(p_owner_name, 200), owner_email = lower(btrim(p_owner_email)), sandbox = coalesce(p_sandbox, false),
    contract_status = 'awaiting_signatures', last_error = null
   where acceptance_id = p_acceptance and autentique_document_id is null returning * into s;
  if not found then raise exception 'Documento já enviado para assinatura.' using errcode = 'P0001'; end if;
  perform app.audit(s.tenant_id, 'contract.sent_for_signature', 'contract_acceptance', p_acceptance::text,
    jsonb_build_object('autentique_document_id', p_document_id, 'sandbox', s.sandbox));
  return to_jsonb(s);
end $$;

create or replace function public.contract_signature_failed(p_acceptance uuid, p_status text, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('not_configured', 'send_failed') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  update public.contract_signatures set contract_status = p_status, last_error = left(p_error, 500)
   where acceptance_id = p_acceptance and autentique_document_id is null;
end $$;

create or replace function public.contract_signature_by_document(p_document_id text) returns uuid
language sql stable security definer set search_path = '' as $$
  select acceptance_id from public.contract_signatures where autentique_document_id = p_document_id
$$;

-- Estado vindo da API da Autentique (já conferido pelo backend). Assinatura do síndico
-- confirma o e-mail do representante e torna o contrato vigente (mesmo efeito do código por e-mail).
create or replace function public.contract_signature_sync(p_acceptance uuid, p_contractor_signed_at timestamptz,
  p_owner_signed_at timestamptz, p_rejected_at timestamptz, p_rejected_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.contract_signatures; a public.contract_acceptances; v_now timestamptz := app.now(); was_c boolean; was_f boolean; v_status text;
begin
  select * into s from public.contract_signatures where acceptance_id = p_acceptance for update;
  if not found or s.autentique_document_id is null then raise exception 'Assinatura não encontrada.' using errcode = 'P0002'; end if;
  was_c := s.contractor_signed_at is not null; was_f := s.fully_signed_at is not null;
  s.contractor_signed_at := coalesce(s.contractor_signed_at, p_contractor_signed_at);
  s.owner_signed_at := coalesce(s.owner_signed_at, p_owner_signed_at);
  v_status := case
    when s.contractor_signed_at is not null and s.owner_signed_at is not null then 'fully_signed'
    when p_rejected_at is not null then 'rejected'
    when s.contractor_signed_at is not null then 'signed_by_contractor'
    when s.owner_signed_at is not null then 'signed_by_owner'
    else 'awaiting_signatures' end;
  update public.contract_signatures set contractor_signed_at = s.contractor_signed_at, owner_signed_at = s.owner_signed_at,
    fully_signed_at = case when v_status = 'fully_signed' then coalesce(fully_signed_at, v_now) end,
    rejected_at = case when v_status = 'rejected' then coalesce(rejected_at, p_rejected_at) end,
    rejected_reason = case when v_status = 'rejected' then coalesce(rejected_reason, left(p_rejected_reason, 500)) end,
    contract_status = v_status, last_synced_at = v_now, last_error = null
   where acceptance_id = p_acceptance returning * into s;
  if s.contractor_signed_at is not null and not was_c then
    perform pg_advisory_xact_lock(hashtext('contract:' || s.tenant_id::text));
    select * into a from public.contract_acceptances where id = p_acceptance for update;
    if a.status = 'pending_verification' then
      update public.contract_acceptances set status = 'superseded', superseded_by = a.id
       where tenant_id = a.tenant_id and status = 'active' and id <> a.id;
      update public.contract_acceptances set status = 'active', email_verified_at = s.contractor_signed_at where id = a.id;
    end if;
    insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
    values (s.tenant_id, null, 'contract.signed_by_contractor', 'contract_acceptance', p_acceptance::text,
      jsonb_build_object('autentique_document_id', s.autentique_document_id, 'signed_at', s.contractor_signed_at));
  end if;
  if v_status = 'fully_signed' and not was_f then
    insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
    values (s.tenant_id, null, 'contract.fully_signed', 'contract_acceptance', p_acceptance::text,
      jsonb_build_object('autentique_document_id', s.autentique_document_id, 'owner_signed_at', s.owner_signed_at));
  end if;
  if v_status = 'rejected' then
    insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
    select s.tenant_id, null, 'contract.signature_rejected', 'contract_acceptance', p_acceptance::text, jsonb_build_object('reason', s.rejected_reason)
     where not exists (select 1 from public.audit_logs where action = 'contract.signature_rejected' and target_id = p_acceptance::text);
  end if;
  return to_jsonb(s) || jsonb_build_object('newly_contractor_signed', s.contractor_signed_at is not null and not was_c,
    'newly_fully_signed', v_status = 'fully_signed' and not was_f);
end $$;

-- PDF final (com manifesto da Autentique) gravado uma vez; envia a via assinada às duas partes.
create or replace function public.contract_signature_signed_pdf(p_acceptance uuid, p_path text, p_sha256 text) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.contract_signatures; a public.contract_acceptances;
begin
  select * into s from public.contract_signatures where acceptance_id = p_acceptance for update;
  if not found or s.contract_status <> 'fully_signed' then raise exception 'Contrato ainda não assinado pelas duas partes.' using errcode = 'P0001'; end if;
  if s.signed_pdf_path is not null then return; end if;
  if p_path !~ ('^' || s.tenant_id || '/contracts/' || p_acceptance || '/[A-Za-z0-9-]{8,80}\.pdf$') or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PDF inválido.' using errcode = '22023';
  end if;
  update public.contract_signatures set signed_pdf_path = p_path, signed_pdf_sha256 = p_sha256 where acceptance_id = p_acceptance;
  select * into a from public.contract_acceptances where id = p_acceptance;
  insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload)
  select s.tenant_id, 'contract_signed', 'email', r, p_acceptance::text, jsonb_build_object('acceptance_id', p_acceptance)
    from unnest(array[a.representative_email, s.owner_email]) r where r is not null
  on conflict do nothing;
end $$;

-- Arquivos e sincronização: admin do condomínio ou administração da plataforma com "legal".
create or replace function public.contract_file_access(p_actor uuid, p_acceptance uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.contract_acceptances; s public.contract_signatures;
begin
  select * into a from public.contract_acceptances where id = p_acceptance;
  if not found or p_actor is null or not (app.user_permissions(a.tenant_id, p_actor) is not null
     or exists (select 1 from public.platform_admins where user_id = p_actor and active and role in ('owner', 'finance', 'auditor'))) then
    raise exception 'Contrato não encontrado.' using errcode = 'P0002';
  end if;
  select * into s from public.contract_signatures where acceptance_id = a.id;
  return jsonb_build_object('tenant_id', a.tenant_id, 'pdf_status', a.pdf_status, 'pdf_path', a.pdf_path,
    'signed_pdf_path', s.signed_pdf_path, 'autentique_document_id', s.autentique_document_id, 'contract_status', s.contract_status);
end $$;

-- Painel do síndico: situação das assinaturas. Link pessoal só para quem gerencia o faturamento.
create or replace function public.contract_signature_status(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_admin(p_tenant));
  return coalesce((select jsonb_agg(jsonb_build_object('acceptance_id', s.acceptance_id, 'contract_status', s.contract_status,
    'contractor_signed_at', s.contractor_signed_at, 'owner_signed_at', s.owner_signed_at, 'fully_signed_at', s.fully_signed_at,
    'rejected_at', s.rejected_at, 'rejected_reason', s.rejected_reason, 'has_signed_pdf', s.signed_pdf_path is not null,
    'sandbox', s.sandbox, 'sign_url', case when app.has_perm(p_tenant, 'billing') and s.contractor_signed_at is null then s.autentique_contractor_sign_url end,
    'last_error', case when s.contract_status in ('send_failed', 'not_configured') then s.last_error end) order by s.created_at desc)
    from public.contract_signatures s where s.tenant_id = p_tenant), '[]');
end $$;

-- Admin Master: link de assinatura da Contratada e situação de cada contrato.
create or replace function public.platform_contract_signatures() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.platform_require('legal');
  return coalesce((select jsonb_agg(jsonb_build_object('acceptance_id', s.acceptance_id, 'tenant_name', t.name, 'contract_status', s.contract_status,
    'document_version', a.document_version, 'plan', a.terms ->> 'plan_name', 'autentique_document_id', s.autentique_document_id, 'sandbox', s.sandbox,
    'owner_sign_url', case when s.owner_signed_at is null then s.autentique_owner_sign_url end, 'contractor_signed_at', s.contractor_signed_at,
    'owner_signed_at', s.owner_signed_at, 'fully_signed_at', s.fully_signed_at, 'rejected_reason', s.rejected_reason,
    'has_pdf', a.pdf_status = 'ready', 'has_signed_pdf', s.signed_pdf_path is not null, 'last_error', s.last_error, 'created_at', s.created_at)
    order by s.created_at desc)
    from (select * from public.contract_signatures order by created_at desc limit 200) s
    join public.contract_acceptances a on a.id = s.acceptance_id join public.tenants t on t.id = s.tenant_id), '[]');
end $$;

-- -----------------------------------------------------------------------------
-- Outbox: via assinada por e-mail (estende o CHECK vigente, nunca reescreve a lista).
-- -----------------------------------------------------------------------------
do $$ declare def text; begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid = 'public.notification_jobs'::regclass and conname = 'notification_jobs_event_check';
  if def is null then raise exception 'CHECK de eventos não encontrado'; end if;
  if position('contract_signed' in def) = 0 then
    alter table public.notification_jobs drop constraint notification_jobs_event_check;
    execute 'alter table public.notification_jobs add constraint notification_jobs_event_check CHECK (event = ''contract_signed'' OR (' || substr(def, 7) || '))';
  end if;
end $$;

create or replace function app.contract_signed_notification_allowed(j public.notification_jobs) returns boolean
language sql stable security definer set search_path = '' as $$
  select j.channel = 'email' and exists (select 1 from public.contract_signatures s join public.contract_acceptances a on a.id = s.acceptance_id
    where s.acceptance_id::text = j.ref_id and s.tenant_id = j.tenant_id and s.signed_pdf_path is not null
      and j.recipient in (a.representative_email, s.owner_email))
$$;

do $$
declare src text;
begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if src !~ 'contract_signed_notification_allowed' then
    src := regexp_replace(src, '(begin\s*\r?\n)',
      E'\\1  if j.event = ''contract_signed'' then return app.contract_signed_notification_allowed(j); end if;\n');
    if src !~ 'contract_signed_notification_allowed' then raise exception 'Não foi possível encadear notification_allowed.'; end if;
    execute src;
  end if;
end $$;

-- Contexto da mensagem: dados do contrato assinado (encadeia a versão vigente).
do $$
begin
  if to_regprocedure('app.notification_context_before_signed(uuid)') is null then
    alter function public.notification_context(uuid) rename to notification_context_before_signed;
    alter function public.notification_context_before_signed(uuid) set schema app;
  end if;
end $$;
create or replace function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := app.notification_context_before_signed(p_job); j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job;
  if j.event = 'contract_signed' then
    v := v || jsonb_build_object('contract', (select jsonb_build_object('id', a.id, 'document_version', a.document_version,
        'plan_name', a.terms ->> 'plan_name', 'cycle', a.terms ->> 'cycle', 'autentique_document_id', s.autentique_document_id,
        'signed_pdf_path', s.signed_pdf_path, 'signed_pdf_sha256', s.signed_pdf_sha256)
      from public.contract_signatures s join public.contract_acceptances a on a.id = s.acceptance_id
     where s.acceptance_id::text = j.ref_id and s.tenant_id = j.tenant_id));
  end if;
  return v;
end $$;
revoke all on function public.notification_context(uuid), app.notification_context_before_signed(uuid) from public, anon, authenticated;
grant execute on function public.notification_context(uuid), app.notification_context_before_signed(uuid) to service_role;

revoke all on function app.contract_client_marks(), app.contract_signature_guard(), app.contract_signed_notification_allowed(public.notification_jobs)
  from public, anon, authenticated;
revoke all on function public.contract_accept_v2(uuid, uuid, text, boolean, text, text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.contract_fill_data(uuid), public.contract_signature_prepared(uuid, text),
  public.contract_signature_sent(uuid, text, text, text, text, text, text, text, boolean), public.contract_signature_failed(uuid, text, text),
  public.contract_signature_by_document(text), public.contract_signature_sync(uuid, timestamptz, timestamptz, timestamptz, text),
  public.contract_signature_signed_pdf(uuid, text, text), public.contract_file_access(uuid, uuid),
  public.contract_signature_status(uuid), public.platform_contract_signatures() from public, anon, authenticated;
grant execute on function public.contract_accept_v2(uuid, uuid, text, boolean, text, text, text, text, text, text, text, text, text, text, text, text, text, text),
  public.contract_fill_data(uuid), public.contract_signature_prepared(uuid, text),
  public.contract_signature_sent(uuid, text, text, text, text, text, text, text, boolean), public.contract_signature_failed(uuid, text, text),
  public.contract_signature_by_document(text), public.contract_signature_sync(uuid, timestamptz, timestamptz, timestamptz, text),
  public.contract_signature_signed_pdf(uuid, text, text), public.contract_file_access(uuid, uuid) to service_role;
grant execute on function public.contract_signature_status(uuid), public.platform_contract_signatures() to authenticated, service_role;
