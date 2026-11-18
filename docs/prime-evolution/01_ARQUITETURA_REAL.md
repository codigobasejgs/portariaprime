# 01 · Arquitetura real (P0)

**Decisão:** monólito modular no mesmo repositório, mesmo Supabase e mesma marca. Serviços de borda (gateway local) ficam fora da Vercel. Nada de Next.js, microserviço novo ou broker na nuvem nesta fase.

```text
PWA React/Vite (TenantShell / ResidentShell / AdminPage)  ──  tenant.hasModule() só exibe
   │  rpc() / api()                                           (a segurança está no banco)
   ▼
Supabase Postgres (RLS + RPC SECURITY DEFINER)
   ├─ core: tenants, tenant_memberships, units, unit_memberships, resident_contacts, profiles
   ├─ parcels (inalterado): packages, receipts, pickup_tokens, notification_jobs …
   │     └─ trigger AFTER packages_domain_events → domain_events (mesma transação)
   ├─ modules: module_catalog, tenant_module_entitlements, tenant_module_audit
   ├─ visitors: visitor_passes (QR hash), visitor_visits
   ├─ devices: gateways, gateway_devices, access_commands
   └─ events: domain_events (outbox), event_consumers, event_deliveries (inbox)
   ▲
Vercel api/ (12 funções, sem nova)        api/jobs/tick (pg_cron 1/min): gateway_sweep, event_retention
   └─ api/totem/gateway-* (pair, heartbeat, result) ◀── HTTPS de SAÍDA ── Gateway local
                                                                           gateway/simulator.mjs (P0)
                                                                           agente Go + drivers (P1/P2)
```

## Por que assim

- **Identidade única.** `tenant_id` + `units.id` + `auth.users.id` já são canônicos e usados por todas as tabelas novas com FK composta `(tenant_id, unit_id) → units(tenant_id, id)`. Nenhum cadastro paralelo de condomínio, unidade ou pessoa. `external_identity_map` não foi criado: não há sistema paralelo hoje. Vira necessário só ao importar um legado (ex.: banco do Acesso Fácil), e aí entra com simulação e diffs.
- **Sem `site_id`.** Um tenant é um condomínio em todo o código atual. Multi-sítio entra quando houver caso real.
- **Outbox no banco.** A Vercel não segura conexão nem roda broker. O evento nasce na transação da RPC de encomenda, por gatilho. Assim as RPCs vigentes não mudam e o evento não se perde se a API cair depois do commit. Os consumidores leem por `event_pull`/`event_ack` (service_role).
- **Gateway por pull.** O gateway liga para a nuvem (heartbeat a cada 30 s) e recebe os comandos pendentes na resposta. Não há porta aberta no condomínio, nem UPnP, nem RTSP exposto.
- **Limite de 12 funções.** Gateway entra como ação de `api/totem/[action].ts`, como já fazem `kiosk-*`.

## Fronteiras dos módulos

| Módulo | Onde | Fonte de verdade | Verificação |
|---|---|---|---|
| `parcels` | RPCs existentes | `packages` | inalterada (sem linha de contrato = ligado) |
| `visitors` | `visitor_*` | `visitor_passes`, `visitor_visits` | `app.require_module` em toda RPC + RLS com `app.module_enabled` |
| `concierge` | `concierge_overview`, `gateway_*`, `access_command_request` | `gateways`, `access_commands` | idem |
| `cctv`, `access_control`, `intercom`, `garage`, `incident`, `remote_operations`, `analytics_ai` | catálogo apenas | — | `available = false`: não liga |

## Regras invariantes

1. Recebimento de encomenda **não** gera comando de acesso (há teste).
2. Estado comercial e módulo nunca acionam nem bloqueiam saída física. Não existe caminho de comando físico real em P0.
3. `physically_confirmed` só quando o dispositivo declara sensor físico. Caso contrário o banco grava `unknown`.
4. Desligar módulo não apaga dados; RLS e RPCs passam a negar.
