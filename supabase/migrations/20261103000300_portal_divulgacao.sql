-- =============================================================================
-- Central de divulgação do portal (Configurações → Portal e aplicativo → Divulgação).
-- Guarda só os TEXTOS personalizados por modelo; o QR e o link são sempre gerados
-- a partir do endereço público /c/{slug} (nunca contêm convite, token ou senha).
-- Tabela própria (não toca nos grants de tenant_settings, lida por todos os membros):
-- sem acesso direto; leitura e escrita só pelas RPCs, para quem altera as configurações.
-- =============================================================================

create or replace function app.divulgacao_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from jsonb_each(p) f
        where f.key not in ('title', 'subtitle', 'body', 'cta')
           or jsonb_typeof(f.value) <> 'string'
           or length(f.value #>> '{}') > case f.key when 'body' then 1200 when 'title' then 120 else 240 end
           or (f.value #>> '{}') ~ '[<>]')
$$;

create table public.portal_divulgacao (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  model text not null check (model in ('cartaz', 'comunicado', 'whatsapp', 'elevador')),
  texts jsonb not null check (app.divulgacao_valid(texts)),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, model)
);
alter table public.portal_divulgacao enable row level security;
revoke all on public.portal_divulgacao from public, anon, authenticated;
grant all on public.portal_divulgacao to service_role;

create or replace function public.divulgacao_get(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Somente quem altera as configurações vê a divulgação.');
  return coalesce((select jsonb_object_agg(model, texts) from public.portal_divulgacao where tenant_id = p_tenant), '{}'::jsonb);
end $$;

-- Salvar um modelo. Só os campos diferentes do padrão chegam aqui; objeto vazio volta ao padrão.
create or replace function public.divulgacao_save(p_tenant uuid, p_model text, p_texts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_clean jsonb;
begin
  perform app.require(app.has_perm(p_tenant, 'settings'), 'Somente quem altera as configurações pode editar a divulgação.');
  if p_model is null or p_model not in ('cartaz', 'comunicado', 'whatsapp', 'elevador') or jsonb_typeof(p_texts) is distinct from 'object' then
    raise exception 'Modelo inválido.' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(key, to_jsonb(btrim(value #>> '{}'))), '{}'::jsonb) into v_clean
    from jsonb_each(p_texts) where jsonb_typeof(value) = 'string' and btrim(value #>> '{}') <> '';
  if v_clean = '{}'::jsonb then
    delete from public.portal_divulgacao where tenant_id = p_tenant and model = p_model;
  else
    insert into public.portal_divulgacao (tenant_id, model, texts, updated_by) values (p_tenant, p_model, v_clean, auth.uid())
    on conflict (tenant_id, model) do update set texts = excluded.texts, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform app.audit(p_tenant, 'divulgacao.saved', 'portal_divulgacao', p_model, jsonb_build_object('model', p_model, 'custom', v_clean <> '{}'::jsonb));
  return public.divulgacao_get(p_tenant);
exception when check_violation then
  raise exception 'Texto inválido: título até 120, texto até 1.200 e demais campos até 240 caracteres, sem < ou >.' using errcode = '22023';
end $$;

revoke all on function app.divulgacao_valid(jsonb) from public, anon, authenticated;
revoke all on function public.divulgacao_save(uuid, text, jsonb), public.divulgacao_get(uuid) from public, anon;
grant execute on function public.divulgacao_save(uuid, text, jsonb), public.divulgacao_get(uuid) to authenticated;
