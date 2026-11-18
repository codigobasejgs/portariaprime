-- =============================================================================
-- Evolução modular · P0 · Catálogo de módulos e contratação por condomínio.
-- Estritamente aditiva: não altera planos, assinaturas, cobrança nem o módulo de encomendas.
--  * module_catalog: chaves estáveis (parcels, concierge, visitors, cctv, access_control, intercom, garage, incident,
--    remote_operations, analytics_ai) com fase e se dependem de hardware.
--  * tenant_module_entitlements: módulo ligado/desligado por condomínio, vigência, limites, versão e motivo.
--  * tenant_module_audit: trilha imutável de cada mudança (autor, antes/depois, justificativa).
--  * parcels é implícito para todo condomínio (sem linha = ligado): nada muda para quem já usa encomendas.
--  * app.module_enabled é a verificação de SERVIDOR usada por RLS e RPCs dos módulos; esconder menu não protege.
--  * Regra de segurança: estado comercial/módulo nunca aciona nem bloqueia saída física (não existe comando aqui).
-- =============================================================================

create table public.module_catalog (
  key text primary key check (key ~ '^[a-z_]{3,40}$'),
  name text not null check (length(name) between 2 and 60),
  description text not null check (length(description) <= 400),
  phase text not null check (phase in ('P0', 'P1', 'P2', 'P3')),
  requires_hardware boolean not null default false,
  default_on boolean not null default false,
  available boolean not null default false,      -- pode ser contratado hoje (implementação existe)
  sort int not null default 100
);

insert into public.module_catalog (key, name, description, phase, requires_hardware, default_on, available, sort) values
  ('parcels', 'Encomendas', 'Recebimento, guarda, aviso e retirada de encomendas com QR e comprovante.', 'P0', false, true, true, 10),
  ('visitors', 'Visitantes', 'Convites com QR de uso único e validade, check-in e check-out na portaria, vinculados à unidade.', 'P0', false, false, true, 20),
  ('concierge', 'Portaria', 'Painel integrado da portaria: encomendas, visitas esperadas, ocorrências e dispositivos.', 'P0', false, false, true, 30),
  ('incident', 'Ocorrências', 'Registro de ocorrências e recados da portaria com trilha de auditoria.', 'P1', false, false, false, 40),
  ('cctv', 'Câmeras', 'Visualização de câmeras pelo gateway local (ONVIF/RTSP), sem expor credenciais ao navegador.', 'P1', true, false, false, 50),
  ('access_control', 'Controle de acesso', 'Pontos de acesso, credenciais e comandos assinados pelo gateway, com confirmação física separada.', 'P2', true, false, false, 60),
  ('intercom', 'Interfonia', 'Chamadas SIP/WebRTC quando o equipamento for compatível.', 'P2', true, false, false, 70),
  ('garage', 'Garagem', 'Veículos, vagas e eventos de entrada e saída.', 'P2', true, false, false, 80),
  ('remote_operations', 'Central remota', 'Operação remota multi-condomínio por escopo explícito.', 'P3', true, false, false, 90),
  ('analytics_ai', 'Inteligência', 'Detecção, LPR e biometria opt-in, com revisão humana e avaliação LGPD.', 'P3', true, false, false, 100);

create table public.tenant_module_entitlements (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  module_key text not null references public.module_catalog(key),
  enabled boolean not null,
  valid_from timestamptz,
  valid_until timestamptz,
  limits jsonb not null default '{}'::jsonb check (jsonb_typeof(limits) = 'object' and length(limits::text) <= 2000),
  version int not null default 1,
  reason text not null check (length(btrim(reason)) between 5 and 300),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, module_key),
  check (valid_until is null or valid_from is null or valid_until > valid_from)
);

create table public.tenant_module_audit (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  module_key text not null,
  actor_id uuid,
  before jsonb,
  after jsonb not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index tenant_module_audit_idx on public.tenant_module_audit (tenant_id, created_at desc);
-- Imutável para UPDATE; DELETE só pela exclusão do condomínio (cascade) — não bloqueia apagar o tenant (LGPD).
create trigger tenant_module_audit_append_only before update on public.tenant_module_audit
  for each row execute function app.block_mutation();

alter table public.module_catalog enable row level security;
revoke all on sequence public.tenant_module_audit_id_seq from public, anon, authenticated;
alter table public.tenant_module_entitlements enable row level security;
alter table public.tenant_module_audit enable row level security;
revoke all on public.module_catalog, public.tenant_module_entitlements, public.tenant_module_audit from public, anon, authenticated;
grant select on public.module_catalog to authenticated;
create policy module_catalog_read on public.module_catalog for select to authenticated using (true);
grant all on public.module_catalog, public.tenant_module_entitlements, public.tenant_module_audit to service_role;

-- Verificação de servidor: módulo vigente E condomínio ativo E vínculo do usuário (quem chama decide o papel).
-- Encomendas: sempre ligado, a menos que a plataforma desligue explicitamente (nunca feito em P0).
create function app.module_enabled(p_tenant uuid, p_module text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tenants t where t.id = p_tenant and t.status = 'active')
     and coalesce(
       (select e.enabled and (e.valid_from is null or e.valid_from <= app.now()) and (e.valid_until is null or e.valid_until > app.now())
          from public.tenant_module_entitlements e where e.tenant_id = p_tenant and e.module_key = p_module),
       (select c.default_on from public.module_catalog c where c.key = p_module),
       false)
$$;

create function app.require_module(p_tenant uuid, p_module text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.module_enabled(p_tenant, p_module) then
    raise exception 'Módulo % não contratado neste condomínio.', p_module using errcode = '42501';
  end if;
end $$;

-- Para o painel do condomínio (qualquer membro): módulos e situação. Sem limites internos nem autor.
create function public.tenant_modules(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.is_member(p_tenant));
  return (select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name, 'description', c.description, 'phase', c.phase,
      'requires_hardware', c.requires_hardware, 'available', c.available, 'enabled', app.module_enabled(p_tenant, c.key),
      'valid_until', e.valid_until) order by c.sort), '[]'::jsonb)
    from public.module_catalog c left join public.tenant_module_entitlements e on e.tenant_id = p_tenant and e.module_key = c.key);
end $$;

-- Superadmin: liga/desliga com justificativa (capacidade nova 'modules_manage', só owner; exige MFA quando cadastrado).
-- Idempotente: repetir o mesmo estado não cria versão nem auditoria. Desligar não apaga dados.
create function public.platform_module_set(p_tenant uuid, p_module text, p_enabled boolean, p_reason text,
  p_valid_until timestamptz default null, p_limits jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.module_catalog; old public.tenant_module_entitlements; v public.tenant_module_entitlements;
begin
  perform app.platform_require('modules_manage');
  select * into c from public.module_catalog where key = p_module;
  if not found then raise exception 'Módulo inexistente.' using errcode = '22023'; end if;
  if not exists (select 1 from public.tenants where id = p_tenant) then raise exception 'Condomínio não encontrado.' using errcode = 'P0002'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Informe a justificativa (mín. 5 caracteres).' using errcode = '22023'; end if;
  if p_enabled and not c.available then raise exception 'Módulo % ainda não está disponível para contratação.', c.name using errcode = 'P0001'; end if;
  if jsonb_typeof(coalesce(p_limits, '{}'::jsonb)) <> 'object' then raise exception 'Limites inválidos.' using errcode = '22023'; end if;
  select * into old from public.tenant_module_entitlements where tenant_id = p_tenant and module_key = p_module for update;
  if found and old.enabled = p_enabled and old.valid_until is not distinct from p_valid_until and old.limits = coalesce(p_limits, '{}'::jsonb) then
    return jsonb_build_object('module', p_module, 'enabled', old.enabled, 'version', old.version, 'changed', false);
  end if;
  insert into public.tenant_module_entitlements as e (tenant_id, module_key, enabled, valid_from, valid_until, limits, version, reason, updated_by, updated_at)
  values (p_tenant, p_module, p_enabled, app.now(), p_valid_until, coalesce(p_limits, '{}'::jsonb), 1, btrim(p_reason), auth.uid(), now())
  on conflict (tenant_id, module_key) do update set enabled = excluded.enabled, valid_from = excluded.valid_from, valid_until = excluded.valid_until,
    limits = excluded.limits, version = e.version + 1, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now()
  returning * into v;
  insert into public.tenant_module_audit (tenant_id, module_key, actor_id, before, after, reason)
  values (p_tenant, p_module, auth.uid(), case when old.tenant_id is null then null else to_jsonb(old) - 'updated_by' end,
          to_jsonb(v) - 'updated_by', btrim(p_reason));
  return jsonb_build_object('module', p_module, 'enabled', v.enabled, 'version', v.version, 'changed', true);
end $$;

create function public.platform_tenant_modules(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.platform_require('tenants');
  return jsonb_build_object(
    'modules', (select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name, 'phase', c.phase, 'available', c.available,
        'requires_hardware', c.requires_hardware, 'enabled', app.module_enabled(p_tenant, c.key), 'explicit', e.tenant_id is not null,
        'version', e.version, 'valid_until', e.valid_until, 'reason', e.reason, 'updated_at', e.updated_at) order by c.sort), '[]'::jsonb)
      from public.module_catalog c left join public.tenant_module_entitlements e on e.tenant_id = p_tenant and e.module_key = c.key),
    'audit', (select coalesce(jsonb_agg(jsonb_build_object('module', a.module_key, 'enabled', a.after->'enabled', 'reason', a.reason, 'at', a.created_at)
        order by a.created_at desc), '[]'::jsonb)
      from (select * from public.tenant_module_audit where tenant_id = p_tenant order by created_at desc limit 30) a));
end $$;

-- Capacidade 'modules_manage' só para owner, encadeada na definição VIGENTE de platform_context (mesmo padrão da
-- 20261028000400): mantém tudo o que migrations anteriores incluíram (devices, devices_release...) e só acrescenta.
do $$
declare def text;
begin
  def := pg_get_functiondef('public.platform_context()'::regprocedure);
  if def not like '%''modules_manage''%' then
    def := replace(def, $x$'organizations','organizations_manage',$x$, $x$'organizations','organizations_manage','modules_manage',$x$);
    if def not like '%''modules_manage''%' then raise exception 'platform_context: não foi possível incluir modules_manage'; end if;
    execute def;
  end if;
end $$;

revoke all on function app.module_enabled(uuid, text), app.require_module(uuid, text), public.tenant_modules(uuid),
  public.platform_module_set(uuid, text, boolean, text, timestamptz, jsonb), public.platform_tenant_modules(uuid) from public, anon;
grant execute on function app.module_enabled(uuid, text), public.tenant_modules(uuid),
  public.platform_module_set(uuid, text, boolean, text, timestamptz, jsonb), public.platform_tenant_modules(uuid) to authenticated, service_role;
grant execute on function app.require_module(uuid, text) to service_role;
