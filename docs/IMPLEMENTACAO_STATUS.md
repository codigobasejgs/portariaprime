# Status de implementação — Portaria Prime

Legenda: ✅ passou local · 🌐 homologado externamente · ⏳ em andamento · ⛔ bloqueado (insumo externo) · ❌ não iniciado

| Etapa | Situação | Evidência |
|---|---|---|
| 1. Diagnóstico, checkpoint e inventário dos logos | ✅ | branch `feat/portaria-prime-saas`; `docs/DIAGNOSTICO_LEGADO.md`; logos em `design/brand/` |
| 2. Schema multi-tenant + RLS + RPCs | ✅ | `supabase/migrations/2026101900*.sql`; `node --test tests/db/db.test.mjs` (22/22) em PGlite |
| 3. Identidade e personalização | ⏳ | |
| 4. Fluxos operacionais (frontend) | ⏳ | |
| 5. Onboarding/trial/planos/cobrança | ⏳ banco ✅, API/UI pendentes | |
| 6. Canais/PWA/ajuda | ❌ | |
| 7. QA funcional, isolamento e restore | ⏳ | |
| 8. Gate da landing | ❌ fechado | `docs/GATE_LANDING.md` |
| 9. Screenshots reais | ❌ | |
| 10. Landing | ❌ (proibida antes do gate) | |
