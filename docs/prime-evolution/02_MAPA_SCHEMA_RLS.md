# 02 · Schema e RLS das tabelas novas

Todas as tabelas novas: `enable row level security` + `revoke all … from public, anon, authenticated` explícito (o Supabase hospedado concede ALL por padrão) + `grant` mínimo. Escrita sempre por RPC.

| Tabela | Chave de isolamento | authenticated | Política de leitura |
|---|---|---|---|
| `module_catalog` | global | `select` | todos (catálogo público aos logados) |
| `tenant_module_entitlements` | `tenant_id` | nenhum | — (lido via `tenant_modules`, `platform_tenant_modules`) |
| `tenant_module_audit` | `tenant_id` | nenhum | — (append-only por gatilho `app.block_mutation`) |
| `domain_events` | `tenant_id` | nenhum | — (service_role; append-only para UPDATE) |
| `event_consumers` | `tenant_id` opcional | nenhum | — |
| `event_deliveries` | via evento | nenhum | — |
| `visitor_passes` | `tenant_id` + FK `(tenant_id, unit_id)` | `select` por coluna, **sem `token_hash` e sem `document_last4`** | módulo `visitors` ligado e (equipe ou morador da unidade) |
| `visitor_visits` | `tenant_id` + FK `(tenant_id, unit_id)` | `select` | idem |
| `gateways` | `tenant_id` | `select` por coluna, **sem `secret_hash`, `pair_code_hash`, `last_seq`** | equipe + módulo `concierge` |
| `gateway_devices` | FK `(tenant_id, gateway_id)` | `select` | equipe + `concierge` |
| `access_commands` | FK `(tenant_id, gateway_id/device_id)` | `select` por coluna, **sem `nonce`, `seq`** | equipe + `concierge` |

## RPCs e quem chama

| RPC | Papel | Exige |
|---|---|---|
| `tenant_modules(tenant)` | membro do condomínio | `app.is_member` |
| `platform_module_set`, `platform_tenant_modules` | superadmin | `modules_manage` (owner, MFA se cadastrado) / `tenants` |
| `visitor_pass_create`, `visitor_pass_revoke` | morador da unidade ou equipe | módulo `visitors`; `can_operate` para criar |
| `visitor_list` | morador (só suas unidades) ou equipe | módulo `visitors` |
| `visitor_pass_lookup`, `visitor_check_in`, `visitor_check_out` | equipe | módulo `visitors` |
| `concierge_overview` | equipe | módulo `concierge` |
| `gateway_create`, `gateway_revoke` | admin com `settings` | `concierge` + senha recente (≤ 5 min) |
| `access_command_request` | equipe | `concierge` + senha recente + dispositivo `simulated` |
| `gateway_pair`, `gateway_heartbeat`, `gateway_command_result` | service_role (API do gateway) | segredo do gateway por hash |
| `event_pull`, `event_ack`, `event_retention`, `gateway_sweep` | service_role | consumidor ativo |
| `event_redeliver` | superadmin | `notification_retry` |

## Índices

`domain_events (tenant_id, occurred_at desc)`, `(occurred_at)` para retenção, `unique (tenant_id, dedupe_key)`; `event_deliveries (consumer_key, status, next_attempt_at)`; `visitor_passes (tenant_id, valid_from desc)`, `(tenant_id, unit_id, valid_from desc)`; `visitor_visits (tenant_id, checked_in_at desc)` e parcial de visitas abertas; `access_commands (gateway_id, status, requested_at)`, `unique (gateway_id, seq)`, `unique (nonce)`.

## Storage

Nenhum bucket novo em P0. Visitantes não guardam foto nem documento (só 4 últimos caracteres, opcional).
