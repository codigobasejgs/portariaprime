# Arquitetura multi-tenant

## Camadas

- **Frontend** React 19 + Vite + Tailwind 4 (`src/`). Roteador mínimo por `pathname` (`src/lib/router.ts`). Rotas de condomínio em `/c/:slug/:area`.
- **Banco** Supabase Postgres. Autorização em RLS + RPCs `SECURITY DEFINER` (`supabase/migrations/`). Fonte única da verdade para papel, vínculo, estado comercial e franquias.
- **API** funções Vercel Web Request/Response em `api/` — somente o que exige segredo de servidor: cobrança InfinitePay, webhook, job, totem, OCR, WhatsApp, convites por e-mail, contato.

## Isolamento

- `tenant_id NOT NULL` em todas as tabelas de negócio; FKs compostas `(tenant_id, id)`.
- Slug/`tenant_id` vindos do cliente são **seleção**, nunca autorização: cada política/RPC chama `app.has_role(tenant, papéis)`, que consulta o vínculo ativo e o status do condomínio a cada query.
- Storage: `tenant-private/<tenant>/packages/<package>/…` (provas) com política por papel/unidade; `tenant-public/<tenant>/logo-*` só para logos.
- Realtime: `postgres_changes` filtrado por `tenant_id` e sujeito a RLS; canais encerrados ao trocar de condomínio/sair.
- Nada de dados pessoais, QR ou URLs assinadas em `localStorage`/cache do service worker.

## Decisões

| Decisão | Motivo | Limite / evolução |
|---|---|---|
| Escrita de encomendas só por RPC | transação única: registro + evento + outbox + ocupação | — |
| QR guarda só hash (`PP1.<token>`) | vazamento do banco não gera QR válido | — |
| Webhook InfinitePay = aviso | doc pública sem assinatura | ativar só após `payment_check` |
| `app.now()` com relógio de teste | testar trial/carência sem esperar | flag `test_clock` nunca existe em produção |
| Roteador próprio | 15 rotas, sem aninhamento | trocar por react-router se surgirem loaders/aninhamento |
| Backup em memória | volume inicial pequeno | stream quando o acervo crescer |
| Contrato futuro via `previous_*` | renovação antecipada não muda plano antes da data | — |

## Estados

- Encomenda: `PRE_REGISTRADA → RECEBIDA/ARMAZENADA → RETIRADA` ou `CANCELADA/DEVOLVIDA/EXTRAVIADA`. "Avisada" é `notified_at`, não estado físico. Ocupação: `app.occupies_space` (RECEBIDA, ARMAZENADA).
- Assinatura: `trialing → pending_payment → active ⇄ past_due`, `canceled`, `suspended`. Acesso derivado por data em `app.commercial_state`: `full`, `grace` (carência), `restricted`.
