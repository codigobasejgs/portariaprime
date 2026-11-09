-- =============================================================================
-- PORTARIA PRIME — Importação de moradores (pré-cadastro) e convites em lote.
-- Aditiva. NÃO cria conta, NÃO mexe em unit_memberships, tenant_memberships, resident_contacts nem profiles.
--
-- Fluxo: síndico importa a planilha (parser no navegador) -> resident_import_save guarda o pré-cadastro;
-- resident_invite_preview mostra quem recebe e quem fica de fora; resident_invite_send enfileira 1 convite
-- por unidade SEM cadastro (WhatsApp padrão; e-mail só se o síndico escolher), escalonado no tempo.
-- O morador abre /c/:slug?invite=TOKEN, confere nome/unidade, cria senha e aceita o termo: vira uma
-- solicitação PENDENTE já casada com a unidade. O convite NÃO pula a aprovação do síndico.
--
-- Visibilidade: só quem tem a permissão "approve" vê o pré-cadastro (nome, celular, e-mail). Porteiro e
-- demais admins não veem nada desta área (nem o nome): o porteiro continua vendo só moradores aprovados.
-- Os jobs de convite (destinatário + token no payload) ficam fora do SELECT direto de notification_jobs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Outbox: evento novo (mantém todos os anteriores).
-- -----------------------------------------------------------------------------
-- Amplia o CHECK vigente (como em 20261109000100) em vez de reescrevê-lo: lista fixa aqui apagaria eventos
-- adicionados por outras migrations (ex.: package_rejected da 0100), e as linhas antigas seguem válidas.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid = 'public.notification_jobs'::regclass and conname = 'notification_jobs_event_check';
  if def is null then raise exception 'CHECK de eventos não encontrado'; end if;
  if position('resident_invite' in def) = 0 then
    alter table public.notification_jobs drop constraint notification_jobs_event_check;
    -- convite do pré-cadastro (unidade sem cadastro)
    execute 'alter table public.notification_jobs add constraint notification_jobs_event_check CHECK (event = ''resident_invite'' OR (' || substr(def, 7) || '))';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2) Tabelas (sem acesso direto: só RPCs)
-- -----------------------------------------------------------------------------
create table public.resident_import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  stats jsonb not null default '{}'::jsonb,       -- só contagens (sem nomes/contatos)
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.resident_import_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  batch_id uuid references public.resident_import_batches(id) on delete set null,
  unit_id uuid not null,
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  kind text check (kind is null or length(kind) <= 30),
  phone text check (phone is null or phone ~ '^\+55\d{11}$'),
  email text check (email is null or (email = lower(email) and length(email) <= 254 and email like '%@%')),
  extra jsonb not null default '{}'::jsonb,       -- demais telefones/e-mails da planilha
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'sent_whatsapp', 'sent_email', 'no_contact', 'completed')),
  channel text check (channel is null or channel in ('whatsapp', 'email')),
  invite_count int not null default 0,            -- rodada do convite (ref_id do job = id:rodada)
  token_hash text unique,                         -- só o hash; o token vai apenas na mensagem
  token_expires_at timestamptz,
  token_used_at timestamptz,
  invited_at timestamptz,
  last_error text,
  request_id uuid references public.access_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, unit_id) references public.units (tenant_id, id) on delete cascade
);
-- Reimportar a mesma planilha não duplica: mesma pessoa (nome normalizado) na mesma unidade.
create unique index resident_import_entries_person_uq on public.resident_import_entries (tenant_id, unit_id, app.norm_text(full_name));
create index resident_import_entries_tenant_idx on public.resident_import_entries (tenant_id, status);

alter table public.resident_import_batches enable row level security;
alter table public.resident_import_entries enable row level security;
revoke all on public.resident_import_batches, public.resident_import_entries from public, anon, authenticated;
grant all on public.resident_import_batches, public.resident_import_entries to service_role;

-- -----------------------------------------------------------------------------
-- 3) Regras
-- -----------------------------------------------------------------------------
-- Unidade "com cadastro": qualquer vínculo (ativo ou revogado), contato ativo, pedido pendente ou convite pendente.
create function app.unit_registered(p_tenant uuid, p_unit uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.unit_memberships where tenant_id = p_tenant and unit_id = p_unit)
      or exists (select 1 from public.resident_contacts where tenant_id = p_tenant and unit_id = p_unit and active)
      or exists (select 1 from public.access_requests where tenant_id = p_tenant and unit_id = p_unit and status = 'pending')
      or exists (select 1 from public.invitations where tenant_id = p_tenant and unit_id = p_unit
                    and accepted_at is null and revoked_at is null and expires_at > app.now())
$$;

-- Autorizado/prestador/funcionário/visitante: fica no pré-cadastro, NUNCA recebe convite (nem por payload adulterado).
-- O celular deles também não vale como "celular da unidade".
create function app.import_kind_excluded(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(app.norm_text(p_kind) ~ '^(AUTORIZAD|PRESTADOR|FUNCIONARI|VISITANTE|EMPREGAD|DIARISTA|TERCEIRIZAD)', false)
$$;

-- Destinatário já conhecido no condomínio (contato ativo, pedido, membro da equipe/morador, convite pendente) em
-- QUALQUER unidade: ambíguo, não convida. Celular compara os 11 dígitos finais; e-mail em minúsculas.
create function app.import_contact_known(p_tenant uuid, p_rcpt text) returns boolean
language sql stable security definer set search_path = '' as $$
  with k as (select p_rcpt like '%@%' mail, lower(btrim(p_rcpt)) em, right(regexp_replace(p_rcpt, '\D', '', 'g'), 11) tel
              where coalesce(btrim(p_rcpt), '') <> '')
  select exists (select 1 from k, public.resident_contacts c where c.tenant_id = p_tenant and c.active
                   and case when k.mail then c.email = k.em else right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 11) = k.tel end)
      or exists (select 1 from k, public.access_requests r where r.tenant_id = p_tenant and r.status in ('pending', 'approved')
                   and not k.mail and right(regexp_replace(coalesce(r.phone, ''), '\D', '', 'g'), 11) = k.tel)
      or exists (select 1 from k, public.tenant_memberships m join public.profiles pr on pr.id = m.user_id join auth.users au on au.id = m.user_id
                  where m.tenant_id = p_tenant and m.status <> 'revoked'
                    and case when k.mail then lower(au.email) = k.em else right(regexp_replace(coalesce(pr.phone, ''), '\D', '', 'g'), 11) = k.tel end)
      or exists (select 1 from k, public.invitations i where i.tenant_id = p_tenant and k.mail and i.email = k.em
                   and i.accepted_at is null and i.revoked_at is null and i.expires_at > app.now())
$$;

-- Um convite por unidade: escolhe a pessoa (morador > já convidada > com contato no canal > mais antiga) e o motivo
-- de ficar de fora. Mesmo destinatário em várias unidades: só a primeira (ou a já convidada) recebe.
create function app.resident_invite_plan(p_tenant uuid, p_channel text)
returns table (unit_id uuid, entry_id uuid, full_name text, recipient text, unit text, reason text)
language sql stable security definer set search_path = '' as $$
  with e as (
    select e.*, case when p_channel = 'email' then e.email else e.phone end rcpt, app.import_kind_excluded(e.kind) excl,
           (e.status in ('queued', 'sent_whatsapp', 'sent_email') and e.token_expires_at > app.now()) invited
      from public.resident_import_entries e where e.tenant_id = p_tenant),
  pick as (
    select distinct on (e.unit_id) e.unit_id, e.id, e.full_name, e.rcpt, e.invited, e.excl,
           bool_or(e.status = 'completed') over (partition by e.unit_id) done
      from e
     order by e.unit_id, (e.status = 'completed'), e.excl, e.invited desc, (e.rcpt is null), e.created_at, e.id),
  base as (
    select p.*, u.block, u.label, app.unit_display(p_tenant, u.block, u.label) unit,
      case when not u.active then 'unidade_inativa'
           when app.unit_registered(p_tenant, p.unit_id) then 'unidade_cadastrada'
           when p.done then 'convite_usado'
           when p.excl then 'tipo_nao_morador'
           when p.invited then 'ja_convidado'
           when p.rcpt is null then 'sem_contato'
           when app.import_contact_known(p_tenant, p.rcpt) then 'contato_existente' end reason
      from pick p join public.units u on u.id = p.unit_id),
  ranked as (
    select b.*, b.reason is null or b.reason = 'ja_convidado' cand,
           row_number() over (partition by b.rcpt, (b.reason is null or b.reason = 'ja_convidado')
             order by (b.reason = 'ja_convidado') desc, nullif(btrim(b.block), '') nulls first, length(b.label), b.label, b.unit_id) rn
      from base b)
  select r.unit_id, r.id, r.full_name, r.rcpt, r.unit,
         case when r.reason is null and r.cand and r.rn > 1 then 'destinatario_repetido' else r.reason end
    from ranked r
   order by nullif(btrim(r.block), '') nulls first, length(r.label), r.label
$$;

-- Worker: revalida tudo na hora do envio (unidade ganhou cadastro, contato apareceu, tipo trocado, pré-cadastro excluído).
create function app.resident_invite_notification_allowed(j public.notification_jobs) returns boolean
language sql stable security definer set search_path = '' as $$
  select j.channel in ('whatsapp', 'email')
     and exists (select 1 from public.tenants where id = j.tenant_id and status = 'active')
     and exists (select 1 from public.resident_import_entries e join public.units u on u.id = e.unit_id and u.active
        where e.tenant_id = j.tenant_id and e.id::text = split_part(j.ref_id, ':', 1) and e.invite_count::text = split_part(j.ref_id, ':', 2)
          and e.status in ('queued', 'sent_whatsapp', 'sent_email') and e.token_used_at is null and e.token_expires_at > app.now()
          and (case j.channel when 'email' then e.email else e.phone end) = j.recipient
          and not app.import_kind_excluded(e.kind)
          and not app.unit_registered(e.tenant_id, e.unit_id)
          and not app.import_contact_known(e.tenant_id, j.recipient))
     -- Dedupe por destinatário: outro convite (outra pessoa/unidade) já enviado ou enfileirado antes para o mesmo número/e-mail barra este.
     and not exists (select 1 from public.notification_jobs o where o.tenant_id = j.tenant_id and o.event = 'resident_invite'
        and o.recipient = j.recipient and o.channel = j.channel and o.id <> j.id
        and split_part(o.ref_id, ':', 1) <> split_part(j.ref_id, ':', 1)
        and (o.status in ('sending', 'accepted', 'delivered') or (o.status = 'queued' and (o.created_at, o.id) < (j.created_at, j.id))))
$$;

do $$
declare src text;
begin
  select pg_get_functiondef('app.notification_allowed(public.notification_jobs)'::regprocedure) into src;
  if src !~ 'resident_invite_notification_allowed' then
    src := regexp_replace(src, '(begin\s*\r?\n)',
      E'\\1  if j.event = ''resident_invite'' then return app.resident_invite_notification_allowed(j); end if;\n');
    if src !~ 'resident_invite_notification_allowed' then raise exception 'Não foi possível encadear notification_allowed.'; end if;
    execute src;
  end if;
end $$;

-- Resultado do envio no pré-cadastro + token fora do payload depois de enviado/descartado.
-- Descartado (sem canal, número trocado, unidade cadastrada no meio do caminho): volta a "pendente", token invalidado.
create function app.resident_invite_job_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('accepted', 'delivered', 'disabled') then new.payload := new.payload - 'token'; end if;
  if new.status in ('accepted', 'delivered') then
    update public.resident_import_entries set status = case new.channel when 'email' then 'sent_email' else 'sent_whatsapp' end,
           last_error = null, updated_at = now()
     where tenant_id = new.tenant_id and id::text = split_part(new.ref_id, ':', 1)
       and invite_count::text = split_part(new.ref_id, ':', 2) and status = 'queued';
  elsif new.status = 'disabled' then
    update public.resident_import_entries set status = 'pending', token_hash = null, token_expires_at = null,
           last_error = left(coalesce(new.last_error, 'Envio cancelado'), 200), updated_at = now()
     where tenant_id = new.tenant_id and id::text = split_part(new.ref_id, ':', 1)
       and invite_count::text = split_part(new.ref_id, ':', 2) and status = 'queued';
  end if;
  return new;
end $$;
create trigger notification_jobs_resident_invite before update of status on public.notification_jobs
  for each row when (new.event = 'resident_invite') execute function app.resident_invite_job_status();

-- Jobs de convite (celular/e-mail + token) fora da leitura direta da equipe.
drop policy if exists jobs_select on public.notification_jobs;
create policy jobs_select on public.notification_jobs for select to authenticated
  using (app.is_staff(tenant_id) and event <> 'resident_invite');

-- Mensagem: primeiro nome e unidade (com os rótulos do condomínio). Encadeia a versão vigente.
do $$
begin
  if to_regprocedure('app.notification_context_before_invite(uuid)') is null then
    alter function public.notification_context(uuid) rename to notification_context_before_invite;
    alter function public.notification_context_before_invite(uuid) set schema app;
  end if;
end $$;
create or replace function public.notification_context(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := app.notification_context_before_invite(p_job); j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job;
  if j.event = 'resident_invite' then
    v := v || jsonb_build_object('resident', (select jsonb_build_object('name', split_part(btrim(e.full_name), ' ', 1),
                                   'unit', app.unit_display(e.tenant_id, u.block, u.label))
      from public.resident_import_entries e join public.units u on u.id = e.unit_id
     where e.tenant_id = j.tenant_id and e.id::text = split_part(j.ref_id, ':', 1)));
  end if;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- 4) RPCs do síndico (permissão "approve")
-- -----------------------------------------------------------------------------
create function public.resident_import_save(p_tenant uuid, p_rows jsonb, p_stats jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_batch uuid; r jsonb; v_name text; v_unit uuid; v_phone text; v_email text; v_new boolean;
        v_ins int := 0; v_upd int := 0; v_skip int := 0;
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros pode importar moradores.');
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Nenhuma pessoa para importar.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'Máximo de 5.000 linhas por importação.' using errcode = '22023'; end if;
  -- Estatística só numérica e pequena (nada de nomes no lote).
  insert into public.resident_import_batches (tenant_id, created_by, stats)
  values (p_tenant, auth.uid(), case when jsonb_typeof(p_stats) = 'object' and length(p_stats::text) <= 2000 then p_stats else '{}'::jsonb end)
  returning id into v_batch;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_name := left(regexp_replace(btrim(coalesce(r->>'full_name', '')), '\s+', ' ', 'g'), 120);
    v_unit := case when coalesce(r->>'unit_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (r->>'unit_id')::uuid end;
    if length(v_name) < 2 or app.norm_text(v_name) is null or v_unit is null
       or not exists (select 1 from public.units where tenant_id = p_tenant and id = v_unit and active) then
      v_skip := v_skip + 1; continue;
    end if;
    begin v_phone := app.phone_e164(r->>'phone'); exception when others then v_phone := null; end;
    v_email := lower(btrim(coalesce(r->>'email', '')));
    if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(v_email) > 254 then v_email := null; end if;
    insert into public.resident_import_entries as e (tenant_id, batch_id, unit_id, full_name, kind, phone, email, extra)
    values (p_tenant, v_batch, v_unit, v_name, left(nullif(btrim(r->>'kind'), ''), 30), v_phone, v_email,
            case when jsonb_typeof(r->'extra') = 'object' and length((r->'extra')::text) <= 1000 then r->'extra' else '{}'::jsonb end)
    on conflict (tenant_id, unit_id, app.norm_text(full_name)) do update
      set phone = coalesce(excluded.phone, e.phone), email = coalesce(excluded.email, e.email), kind = coalesce(excluded.kind, e.kind),
          extra = excluded.extra, batch_id = excluded.batch_id, updated_at = now(),
          status = case when e.status = 'no_contact' then 'pending' else e.status end
      where e.status <> 'completed'
    returning (xmax::text = '0') into v_new;
    if not found then v_skip := v_skip + 1; elsif v_new then v_ins := v_ins + 1; else v_upd := v_upd + 1; end if;
  end loop;
  perform app.audit(p_tenant, 'resident_import.saved', 'resident_import_batch', v_batch::text,
    jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'skipped', v_skip));
  return jsonb_build_object('batch_id', v_batch, 'inserted', v_ins, 'updated', v_upd, 'skipped', v_skip);
end $$;

create function public.resident_import_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros pode ver o pré-cadastro.');
  return (select jsonb_build_object(
    'entries', coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'unit_id', e.unit_id, 'unit', app.unit_display(p_tenant, u.block, u.label),
        'full_name', e.full_name, 'kind', e.kind, 'phone', e.phone, 'email', e.email, 'extra', e.extra, 'status', e.status,
        'channel', e.channel, 'invited_at', e.invited_at, 'last_error', e.last_error, 'registered', app.unit_registered(p_tenant, e.unit_id),
        'excluded', app.import_kind_excluded(e.kind))
      order by nullif(btrim(u.block), '') nulls first, length(u.label), u.label, e.full_name), '[]'::jsonb),
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                 from (select status, count(*) n from public.resident_import_entries where tenant_id = p_tenant group by 1) c))
    from public.resident_import_entries e join public.units u on u.id = e.unit_id where e.tenant_id = p_tenant);
end $$;

-- Remove pré-cadastros (um, vários ou todos). Jobs pendentes deixam de valer (destinatário sem autorização).
create function public.resident_import_delete(p_tenant uuid, p_entries uuid[] default null) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros pode excluir o pré-cadastro.');
  delete from public.resident_import_entries where tenant_id = p_tenant and (p_entries is null or id = any (p_entries));
  get diagnostics n = row_count;
  perform app.audit(p_tenant, 'resident_import.deleted', 'resident_import_entry', null, jsonb_build_object('count', n));
  return n;
end $$;

create function public.resident_invite_preview(p_tenant uuid, p_channel text default 'whatsapp', p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_limit int := least(greatest(coalesce(p_limit, 100), 1), 300);
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros pode convidar.');
  if p_channel is null or p_channel not in ('whatsapp', 'email') then raise exception 'Canal inválido.' using errcode = '22023'; end if;
  return (with p as (select * from app.resident_invite_plan(p_tenant, p_channel)),
               c as (select count(*) units, count(*) filter (where reason is null) eligible from p)
    select jsonb_build_object('channel', p_channel, 'limit', v_limit, 'units', c.units, 'eligible', c.eligible,
      'will_send', least(c.eligible, v_limit), 'remaining', greatest(c.eligible - v_limit, 0),
      'excluded', (select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb)
                     from (select reason, count(*) n from p where reason is not null group by 1) r),
      'left_out', (select coalesce(jsonb_agg(jsonb_build_object('unit', p.unit, 'full_name', p.full_name, 'reason', p.reason)), '[]'::jsonb)
                     from p where p.reason is not null))
    from c);
end $$;

-- Envio explícito: 1 convite por unidade sem cadastro, até p_limit, espaçados p_interval_s segundos.
-- Idempotente: unidade já convidada (token válido) fica de fora; o outbox deduplica por (evento, ref_id, destinatário, canal).
create function public.resident_invite_send(p_tenant uuid, p_channel text default 'whatsapp', p_limit int default 100, p_interval_s int default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_limit int := least(greatest(coalesce(p_limit, 100), 1), 300);
        v_gap int := least(greatest(coalesce(p_interval_s, 20), 5), 600);
        x record; v_tok text; v_round int; i int := 0; v_no int := 0; v_eligible int := 0;
begin
  perform app.require(app.has_perm(p_tenant, 'approve'), 'Somente quem aprova cadastros pode convidar.');
  if p_channel is null or p_channel not in ('whatsapp', 'email') then raise exception 'Canal inválido.' using errcode = '22023'; end if;
  -- Dois cliques/abas ao mesmo tempo: um espera o outro (e depois vê as unidades já convidadas).
  perform pg_advisory_xact_lock(hashtext('resident_invite:' || p_tenant::text));
  for x in select * from app.resident_invite_plan(p_tenant, p_channel) loop
    if x.reason = 'sem_contato' then
      update public.resident_import_entries set status = 'no_contact', updated_at = now()
       where tenant_id = p_tenant and unit_id = x.unit_id and status = 'pending' and not app.import_kind_excluded(kind)
         and (case p_channel when 'email' then email else phone end) is null;
      v_no := v_no + 1; continue;
    end if;
    continue when x.reason is not null;
    v_eligible := v_eligible + 1;
    continue when i >= v_limit;
    v_tok := app.random_token();
    update public.resident_import_entries
       set status = 'queued', channel = p_channel, invite_count = invite_count + 1, token_hash = app.sha256_hex(v_tok),
           token_expires_at = app.now() + interval '30 days', token_used_at = null, invited_at = app.now(), last_error = null, updated_at = now()
     where id = x.entry_id returning invite_count into v_round;
    insert into public.notification_jobs (tenant_id, event, channel, recipient, ref_id, payload, next_attempt_at)
    values (p_tenant, 'resident_invite', p_channel, x.recipient, x.entry_id::text || ':' || v_round,
            jsonb_build_object('token', v_tok), app.now() + make_interval(secs => i * v_gap))
    on conflict do nothing;
    if found then i := i + 1;
    else
      update public.resident_import_entries set status = 'pending', token_hash = null, token_expires_at = null,
             last_error = 'Destinatário não autorizado', updated_at = now() where id = x.entry_id;
    end if;
  end loop;
  perform app.audit(p_tenant, 'resident_invite.sent', 'tenant', p_tenant::text,
    jsonb_build_object('channel', p_channel, 'queued', i, 'no_contact', v_no, 'remaining', greatest(v_eligible - i, 0)));
  return jsonb_build_object('queued', i, 'no_contact', v_no, 'remaining', greatest(v_eligible - i, 0),
    'minutes', ceil(greatest(i - 1, 0) * v_gap / 60.0));
end $$;

-- -----------------------------------------------------------------------------
-- 5) Link do convite (portal)
-- -----------------------------------------------------------------------------
-- Pré-preenchimento: nome e unidade, só com token válido. Nada de celular/e-mail (o link pode ser repassado).
create function public.resident_invite_peek(p_slug text, p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('full_name', e.full_name, 'block', u.block, 'label', u.label, 'unit', app.unit_display(t.id, u.block, u.label))
    from public.tenants t
    join public.resident_import_entries e on e.tenant_id = t.id
    join public.units u on u.id = e.unit_id and u.active
   where t.slug = lower(btrim(p_slug)) and t.status = 'active' and coalesce(p_token, '') ~ '^[0-9a-f]{64}$'
     and e.token_hash = app.sha256_hex(p_token) and e.token_used_at is null and e.token_expires_at > app.now()
     and e.status in ('queued', 'sent_whatsapp', 'sent_email')
$$;

-- Conclusão: exige a solicitação pendente do próprio usuário (criada pelo cadastro normal + termo) e só a casa
-- com a unidade do convite. NÃO aprova: o síndico decide como em qualquer pedido. Token de uso único.
create function public.resident_invite_complete(p_slug text, p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.resident_import_entries; v_req uuid;
begin
  perform app.require(auth.uid() is not null, 'Faça login para continuar.');
  select x.* into e from public.resident_import_entries x join public.tenants t on t.id = x.tenant_id
   where t.slug = lower(btrim(p_slug)) and t.status = 'active' and coalesce(p_token, '') ~ '^[0-9a-f]{64}$'
     and x.token_hash = app.sha256_hex(p_token)
   for update of x;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  -- Repetição pelo mesmo morador (outra aba, recarregar): mesma resposta.
  if e.status = 'completed' then
    return case when exists (select 1 from public.access_requests where id = e.request_id and user_id = auth.uid())
      then jsonb_build_object('status', 'completed', 'request_id', e.request_id) else jsonb_build_object('status', 'invalid') end;
  end if;
  if e.token_used_at is not null or e.token_expires_at <= app.now() or e.status not in ('queued', 'sent_whatsapp', 'sent_email') then
    return jsonb_build_object('status', 'invalid');
  end if;
  select id into v_req from public.access_requests where tenant_id = e.tenant_id and user_id = auth.uid() and status = 'pending' for update;
  if not found then raise exception 'Envie o cadastro antes de concluir o convite.' using errcode = 'P0001'; end if;
  -- Unidade digitada pelo morador prevalece; o convite só preenche quando ela não foi encontrada.
  update public.access_requests set unit_id = coalesce(unit_id, e.unit_id) where id = v_req;
  update public.resident_import_entries set status = 'completed', token_used_at = app.now(), request_id = v_req, updated_at = now()
   where id = e.id;
  perform app.audit(e.tenant_id, 'resident_invite.completed', 'access_request', v_req::text, jsonb_build_object('entry', e.id));
  return jsonb_build_object('status', 'completed', 'request_id', v_req);
end $$;

-- -----------------------------------------------------------------------------
-- 6) Permissões
-- -----------------------------------------------------------------------------
revoke all on function app.unit_registered(uuid, uuid), app.import_kind_excluded(text), app.import_contact_known(uuid, text), app.resident_invite_plan(uuid, text),
  app.resident_invite_notification_allowed(public.notification_jobs), app.resident_invite_job_status(),
  app.notification_context_before_invite(uuid) from public, anon, authenticated;
revoke all on function public.notification_context(uuid) from public, anon, authenticated;
grant execute on function public.notification_context(uuid), app.notification_context_before_invite(uuid) to service_role;

revoke all on function public.resident_import_save(uuid, jsonb, jsonb), public.resident_import_list(uuid),
  public.resident_import_delete(uuid, uuid[]), public.resident_invite_preview(uuid, text, int),
  public.resident_invite_send(uuid, text, int, int), public.resident_invite_peek(text, text),
  public.resident_invite_complete(text, text) from public, anon, authenticated;
grant execute on function public.resident_import_save(uuid, jsonb, jsonb), public.resident_import_list(uuid),
  public.resident_import_delete(uuid, uuid[]), public.resident_invite_preview(uuid, text, int),
  public.resident_invite_send(uuid, text, int, int), public.resident_invite_complete(text, text) to authenticated, service_role;
grant execute on function public.resident_invite_peek(text, text) to anon, authenticated, service_role;
