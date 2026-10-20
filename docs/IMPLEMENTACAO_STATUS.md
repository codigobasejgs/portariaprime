# Status de implementação — Portaria Prime

Atualizado: 20/10/2026. Legenda: ✅ passou local · 🌐 homologado externamente · ⏳ parcial · ⛔ bloqueado (insumo externo) · ❌ não iniciado

| Etapa | Situação | Evidência / pendência |
|---|---|---|
| 1. Diagnóstico, checkpoint, logos | ✅ | branch `feat/portaria-prime-saas`; `DIAGNOSTICO_LEGADO.md` |
| 2. Schema multi-tenant, RLS, RPCs | ✅ local · ⛔ Supabase real | 11 migrations; `npm run test:db` 27/27 em PGlite |
| 3. Identidade e personalização | ✅ | `AUDITORIA_IDENTIDADE.md`; legado removido do app |
| 4. Fluxos operacionais | ⏳ | telas prontas e tipadas; ponta a ponta exige Supabase real |
| 5. Onboarding, trial, planos, cobrança | ✅ lógica · ⛔ InfinitePay | contrato com mocks de teste; sem homologação financeira |
| 6. Canais, PWA, ajuda | ✅ código · ⛔ provedores | Resend/Evolution/Gemini/VAPID sem credenciais de homologação |
| 7. QA isolamento e restore | ⏳ | isolamento em PGlite ✅; restore ❌ não ensaiado |
| 8. Gate da landing | ⛔ fechado | `GATE_LANDING.md` |
| 9. Screenshots reais | ❌ | depende do gate |
| 10. Landing | ❌ | proibida antes do gate |

## Matriz requisito → implementação → teste → pendência

| Requisito | Implementação | Teste | Pendência |
|---|---|---|---|
| Isolamento entre condomínios | RLS + FK composta + RPC | db.test "isolamento", storage | Supabase real, Realtime |
| Morador só por convite | `create/accept_invitation` | db.test "convite" | e-mail real (Resend) |
| Revogação imediata | `has_role` por query; contatos desativados | db.test + security-fixes | — |
| Totem pareado sem token de staff | `api/totem/[action].ts`, `device_*` | security-fixes (suspensão) | dispositivo físico |
| QR uso único, hash | `issue/lookup_pickup_token`, `confirm_pickup` | db.test "QR" | concorrência multi-conexão |
| Lotação sem fallback | `app.pick_storage` | db.test "lotação" | — |
| Outbox + retry | `notification_jobs`, `api/jobs/tick.ts` | db.test "outbox", api templates | envio real |
| Trial 1 mês calendário | `provision_tenant`, `app.add_months` | db.test trial/fuso/fevereiro | — |
| Sem cobrança no trial; 1 pedido | `prepare_checkout`, `tick_subscription` | db.test "cobrança" | cron real |
| Pagamento verificado | `apply_verified_payment` + `payment_check` | db.test + api billing | homologação InfinitePay |
| Carência e restrição | `commercial_state` | db.test "carência" | — |
| Personalização por tenant | `tenant_branding`, `applyTheme` | tipagem/build | teste visual autenticado |
| Web Push real | `PushToggle`, `sw.js`, `channels.ts` | push-security | dispositivos reais |
| Backup criptografado | `scripts/backup-prime.mjs` | — | execução + restore |

## Credenciais / ações externas pendentes

1. Novo projeto Supabase: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; aplicar migrations; configurar Auth URLs.
2. `APP_URL` (domínio HTTPS) e vínculo do projeto Vercel.
3. `INFINITEPAY_HANDLE` da conta Portaria Prime + homologação de um pagamento de teste.
4. `CRON_SECRET` + agendador (Vercel pago ou externo).
5. `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (domínio verificado).
6. `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`.
7. `GEMINI_API_KEY`, `GEMINI_OCR_MODEL`.
8. `VITE_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
9. Revisão e publicação dos preços no painel `/admin` (hoje hipóteses, não publicados).
10. Revisão jurídica de termos e privacidade (minutas).
