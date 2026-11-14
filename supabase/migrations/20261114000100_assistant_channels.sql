-- =============================================================================
-- Portaria Prime IA — WhatsApp próprio de cada condomínio (motor Whaileys), conectado pelo síndico no painel,
-- ao lado do WhatsApp dos avisos (Evolution). Estritamente aditiva: não altera tabelas nem funções existentes.
--
--  * Instância ppia-<condomínio> criada pelo servidor (chave de parceiro do motor, que só alcança instâncias ppia-*).
--  * Token e segredo do webhook ficam só aqui, sem acesso de usuários (somente service_role).
--  * Quem conecta/desconecta: permissão 'team' (a mesma que autoriza números), plano com WhatsApp e senha recente,
--    porque quem tem o chip da IA lê as respostas do assistente à equipe. Toda conexão/desconexão vai para audit_logs.
-- =============================================================================

create table public.assistant_channels (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  instance text not null unique check (instance ~ '^ppia-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  token text not null check (token ~ '^[0-9a-f]{64}$'),
  webhook_secret text not null check (webhook_secret ~ '^[0-9a-f]{64}$'),
  phone text check (phone is null or phone ~ '^\d{10,15}$'),   -- número conectado (exibido no painel)
  connected_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.assistant_channels enable row level security;
revoke all on public.assistant_channels from public, anon, authenticated;
grant select, insert, update, delete on public.assistant_channels to service_role;

/**
 * Autoriza a API (que age como o usuário) a operar o WhatsApp da IA do condomínio. status = ver; connect/logout = mudar.
 * A API só usa o service_role depois desta checagem.
 */
create or replace function public.assistant_channel_gate(p_tenant uuid, p_action text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require(app.has_perm(p_tenant, 'team'), 'Somente quem gerencia a equipe conecta o WhatsApp do assistente.');
  perform app.require(app.has_feature(p_tenant, 'whatsapp'), 'O assistente no WhatsApp exige plano com WhatsApp.');
  if coalesce(p_action, '') not in ('status', 'connect', 'logout') then
    raise exception 'Ação inválida.' using errcode = '22023';
  end if;
  if p_action <> 'status' then
    perform app.mdm_require_recent_auth();
    insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
    values (p_tenant, auth.uid(), 'assistant.channel_' || p_action, 'assistant_channel', p_tenant::text, jsonb_build_object('via', 'painel'));
  end if;
  return true;
end $$;

revoke all on function public.assistant_channel_gate(uuid, text) from public, anon;
grant execute on function public.assistant_channel_gate(uuid, text) to authenticated;
