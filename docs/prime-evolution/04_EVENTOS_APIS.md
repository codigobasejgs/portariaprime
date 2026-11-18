# 04 · Eventos e APIs

## Envelope (`domain_events` / `event_pull`)

```json
{
  "event_id": "uuid", "seq": 123, "tenant_id": "uuid",
  "event_type": "parcel.received.v1", "schema_version": 1,
  "aggregate_id": "uuid", "correlation_id": "uuid",
  "occurred_at": "2026-11-18T14:00:00Z",
  "payload": { "parcel_id": "uuid", "unit_id": "uuid", "status": "recebida", "registered_via": "portaria" },
  "attempts": 1
}
```

Payload mínimo: ids, status e enums. **Nunca** nome, telefone, e-mail, foto, assinatura ou caminho de storage. Teste: `prime-modular.test.mjs` confere as chaves exatas.

## Tipos publicados em P0

| Evento | Origem | Payload |
|---|---|---|
| `parcel.received.v1` | gatilho em `packages` (insert RECEBIDA/ARMAZENADA ou PRE_REGISTRADA → RECEBIDA) | parcel_id, unit_id, status, registered_via |
| `parcel.picked_up.v1` | status → RETIRADA | + pickup_method |
| `parcel.exception.v1` | status → CANCELADA/DEVOLVIDA/EXTRAVIADA | idem |
| `visitor.invited.v1` | `visitor_pass_create` | pass_id, unit_id, kind, valid_until |
| `visitor.arrived.v1` / `visitor.authorized.v1` | `visitor_check_in` | visit_id, pass_id, unit_id, method |
| `access.command_requested.v1` | `access_command_request` | command_id, device_id, action, simulated |
| `access.device_acknowledged.v1` / `access.physically_confirmed.v1` | `gateway_command_result` | command_id, status, simulated |
| `gateway.status_changed.v1` | pareamento, heartbeat após offline, `gateway_sweep`, revogação | gateway_id, status |

`access.attempted.v1` e `access.denied.v1` ficam reservados para leitores físicos (P2). Recusas de comando já vão para `audit_logs` (`access.command_rejected`).

## Garantias

- **Idempotência de produção:** `unique (tenant_id, dedupe_key)`. O retry do cliente (mesma `idempotency_key` da encomenda) não duplica o evento.
- **Inbox por consumidor:** `event_deliveries (consumer_key, event_id)` é PK.
  - `event_pull` reserva lotes com lease de 2 minutos (`for update skip locked`).
  - `event_ack(ok)` é idempotente.
  - Em caso de falha, o backoff é de 1, 4, 16 e 64 min; depois de 6 tentativas a entrega vai para `dead`.
  - `event_redeliver` (superadmin) reprocessa uma entrega `dead`.
- **Autorização de consumo:** cada consumidor lista os `event_types` que pode ler e, opcionalmente, um único `tenant_id`. Nenhum consumidor é criado por padrão.
- **Retenção:** 90 dias, só eventos sem entrega pendente (`event_retention`, chamado pelo tick).

## APIs do gateway (`/api/totem/gateway-*`)

| Rota | Autenticação | Corpo | Resposta |
|---|---|---|---|
| `POST gateway-pair` | código de 10 caracteres (15 min, uso único) | `{ code, agentVersion }` | `{ gatewaySecret, gatewayId }`; o segredo aparece só aqui |
| `POST gateway-heartbeat` | `X-Gateway-Secret` | `{ clock, devices[] }` (até 50, só `driver: simulator` em P0) | `{ commands[] }` pendentes com `seq`, `nonce`, `expires_at` |
| `POST gateway-result` | `X-Gateway-Secret` | `{ commandId, seq, nonce, result, detail }` | `{ status }`: `acknowledged`, `physically_confirmed`, `unknown`, `failed`, `expired`, `rejected_signature` ou `rejected_replay` |

Limites por IP ou por segredo: pair 10/min, heartbeat 30/min, result 60/min.

Estados do comando: `requested → acknowledged | physically_confirmed | unknown | failed | expired`. TTL de 30 s. `seq` é monotônica por gateway e única. `nonce` tem 128 bits.

### Sobre o mTLS

O prompt pede mTLS. A Vercel não termina mTLS de cliente, então em P0 a identidade é um segredo de 256 bits por gateway, guardado como hash, com revogação imediata. Fica `pending_infra`: mTLS e certificado por gateway entram no broker persistente de P1, fora da Vercel.

## Contratos versionados

O sufixo `.vN` no `event_type` e `schema_version` tornam o contrato versionado. Uma mudança incompatível vira `v2` publicado em paralelo.

OpenAPI/JSON Schema formal: **NOT_DONE** em P0. As tabelas acima são o contrato vigente; gerar `openapi.yaml` faz parte de P1, junto com o broker.
