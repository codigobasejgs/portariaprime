# 00 · Baseline — Portaria Prime antes da evolução modular

**Data:** 18/11/2026 · **Branch:** `feat/prime-modular-portaria` (criada localmente a partir de `feat/portaria-prime-saas`)
**Commit base:** `26bd0d5` — "feat(whatsapp): conversas do WhatsApp dos avisos no painel do síndico"
**Ambiente:** Windows 10, Node 24 (`%LOCALAPPDATA%\pp-stack`), PGlite para `tests/db`, Vercel Hobby (12 funções, limite já atingido).

## Resultado do baseline (executado nesta máquina, sem tocar produção)

| Comando | Resultado | Evidência |
|---|---|---|
| `npm run typecheck` | PASS (app + api) | `tests/evidence/tmp/baseline/typecheck.txt` |
| `npm test` (`test:db` + `test:api`) | PASS — banco 150/150, API 189/189 | `tests/evidence/tmp/baseline/test.txt` |
| `npm run build` | PASS | `tests/evidence/tmp/baseline/build.txt` |
| E2E da demonstração (`tests/e2e/*.mjs` contra `vite preview`) | PASS em 18/11 (demo-offline 26/26, batch-receive, assistant-demo, portaria-steps-mobile, whatsapp-chat-demo) | sessão anterior, mesma árvore |
| `npm ci` | NOT_RUN (node_modules já instalado e íntegro; reinstalar não muda o resultado) | — |

Nenhuma falha pré-existente.

## Inventário real (arquivos lidos)

**Identidade do condomínio.** A chave canônica é `tenants.id` (`tenant_id` em todas as tabelas, com `unique (tenant_id, id)` em `units`/`packages` para FKs compostas). Não existe `condominium_id` nem conceito de sítio; um tenant = um condomínio. Vínculos: `tenant_memberships (role admin|porteiro|morador, permissions ⊂ {team,approve,billing,settings})`, `unit_memberships (unit_id, user_id)` para moradores, `resident_contacts` para familiares/contatos, `profiles` (sem autoridade). Decisão: **não** criar `site_id` em P0; nada no código atual exige.

**Autorização (banco).** `app.has_role`, `app.is_admin`, `app.is_staff` (porteiro com identidade facial exige turno aberto), `app.is_member`, `app.is_unit_member`, `app.has_perm`, `app.require`, `app.audit` (append-only), `app.mdm_require_recent_auth` (senha ≤ 5 min + MFA), `app.platform_require(cap)` (superadmin por papel owner/support/finance/auditor; ações exigem aal2 quando há MFA). Estado comercial: `app.commercial_state` (full/grace/restricted), `app.can_operate`, `app.entitlements` (plano → `plan_entitlements`), `app.has_feature(ocr|whatsapp|totem|reports_plus)`.

**Encomendas (fonte de verdade, preservar).** `packages` (status `PRE_REGISTRADA|RECEBIDA|ARMAZENADA|RETIRADA|CANCELADA|DEVOLVIDA|EXTRAVIADA`), `package_events`, `package_attachments`, `receipts`, `pickup_tokens`. RPCs vigentes: `receive_package`/`receive_and_store` (20261106000100), `deliver_package` → `confirm_pickup` (interna, revogada de `authenticated`), `resolve_package`, `move_package`, `list_packages`. Outbox de avisos já existe: `notification_jobs` + `notification_attempts` (worker `api/jobs/tick.ts`, `claim_notification_jobs`/`complete_notification_job`/`defer_notification_job`).

**Rotas.** `src/lib/router.ts` (`matchTenant`: `/c/:slug/:area`), `src/App.tsx` (lazy routes por área; morador em `ResidentShell`, equipe em `TenantShell`), `/admin` (`AdminPage` + painéis em `src/pages/admin`), `/org`, `/app`, `/totem`, `/demonstracao`. `vercel.json`: rewrites para `/api/*` agrupados (limite de 12 funções) e fallback SPA.

**API.** 12 funções em `api/`: `billing`, `commercial`, `invitations`, `jobs/tick`, `ocr/analyze-label`, `platform/users`, `portal`, `public`, `receipts`, `totem`, `webhooks/infinitepay` (+ autentique/whaileys por `?a=`), `whatsapp` (+ `ia-*`, `chat-*`). Qualquer endpoint novo entra como ação de uma função existente.

**Integrações a preservar.** InfinitePay (webhook + `payment_check`), Evolution (avisos), Whaileys (IA), Gemini (OCR), Resend/Brevo (e-mail), VAPID (push), Autentique (contrato).

**Ajuda/tours.** `src/lib/help.ts` (`ARTICLES`, `areas`, `roles`), `src/lib/tours.ts` (`TOURS`, alvos `[data-tour]`), `TourProvider`/`HelpPage` reutilizáveis.

**Demonstração.** `/demonstracao` em memória: `src/demo/rpc*.ts` (`HANDLERS`), `src/demo/api.ts` (`/api/*`), `src/demo/store.ts`.

## Riscos identificados antes de alterar

1. Limite de 12 funções na Vercel: novos endpoints só como ações de funções existentes.
2. `app.has_feature` tem lista fixa de recursos do plano; módulos novos não podem depender dela (usar entitlement por tenant).
3. Hosted Supabase concede ALL a anon/authenticated em tabelas novas: toda tabela nova precisa de `revoke` explícito (regra já seguida nas migrations recentes).
4. Trigger em `packages` roda no caminho crítico de recebimento/retirada: o outbox de eventos deve ser leve, `after`, sem chamadas externas.
5. Vercel não roda broker nem worker persistente: eventos ficam no banco (outbox) e são consumidos pelo `tick` ou pelo gateway (pull).
6. `AcessoFacil.pdf` não está no workspace (busca por `*cesso*acil*` sem resultado): paridade usada apenas pelo resumo funcional do documento de arquitetura.
7. Hardware (câmeras, controladoras, Linear HCS, SIP) indisponível: tudo que depende dele fica `simulated`/`pending_hardware`.
