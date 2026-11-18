# 08 · Relatório final — P0

**Status:** P0 implementado e testado **localmente**. **Não publicado.** Não houve deploy, não houve migration remota, nenhum WhatsApp foi enviado, nenhum portão foi aberto e nenhum hardware foi tocado. A branch local é `feat/prime-modular-portaria`.

## Entregue

| Item do prompt | Situação |
|---|---|
| Inventário e baseline | feito (`00_BASELINE.md`) |
| Catálogo de módulos + contratação por condomínio + auditoria | feito |
| Superadmin liga/desliga com justificativa | feito (`/admin` › Detalhes do condomínio) |
| Menu modular (equipe e morador) | feito; itens só com módulo ligado |
| Visitantes básicos vinculados à unidade | feito: convite com QR de uso único e validade, check-in por QR ou manual com quem autorizou, check-out, aviso ao morador |
| Eventos de encomendas por outbox + inbox | feito: gatilho na transação das RPCs atuais, `event_pull`/`event_ack`, retries, dead-letter, retenção |
| Painel integrado (Central da portaria) | feito, com estados honestos (sem licença, não instalado, simulado, sem hardware) |
| Gateway simulador + API de borda | feito (`gateway/simulator.mjs`, `/api/totem/gateway-*`) |
| Tours e artigos de ajuda dos novos módulos | feito (`help.ts`, `tours.ts`) |
| Demonstração | feito: Visitantes e Central ligados em `/demonstracao` |
| Segurança e testes | feito (`06_REGRESSAO_SEGURANCA.md`) |
| OpenAPI / JSON Schema formal | **não feito** (contrato em `04_EVENTOS_APIS.md`; gerar em P1) |
| Agente Go, mTLS, SQLCipher | **não feito**: sem Go na máquina; contrato fixado pelo simulador; P1 |
| CFTV, controle de acesso real, interfonia, garagem, IA | **não feito**: `pending_hardware` / P1–P3 |
| `external_identity_map` | não criado: não há sistema paralelo hoje (ver `01`) |
| Paridade com o manual Acesso Fácil | não verificada: o PDF não está no workspace |

## Arquivos

**Migrations novas (aditivas):**
- `supabase/migrations/20261118000100_modules_catalog.sql`
- `supabase/migrations/20261118000200_domain_events_visitors.sql`

**API:**
- `api/totem/_gateway.ts` (novo);
- `api/totem/[action].ts` (despacho `gateway-*`);
- `api/jobs/tick.ts` (`gateway_sweep`, `event_retention`).

**Front:**
- novos: `src/pages/tenant/VisitantesPage.tsx`, `src/pages/tenant/CentralPage.tsx`, `src/pages/admin/TenantModules.tsx`;
- alterados: `src/pages/admin/TenantDetailModal.tsx`, `src/lib/tenant.tsx` (`hasModule`), `src/App.tsx` (rotas `visitantes`, `central`), `src/pages/tenant/TenantShell.tsx`, `src/pages/resident/ResidentShell.tsx`, `src/lib/help.ts`, `src/lib/tours.ts`, `src/pages/HelpPage.tsx`.

**Demonstração:** `src/demo/rpc-modules.ts` (novo), `src/demo/rpc.ts`.

**Gateway:** `gateway/simulator.mjs`.

**Testes:**
- novos: `tests/db/prime-modular.test.mjs`, `tests/gateway-simulator.test.mjs`, `tests/e2e/modules-demo.mjs`;
- ajustado: `scripts/restore-prime.mjs` (tabela semeada);
- `package.json` (scripts de teste).

**Docs:** `docs/prime-evolution/00` a `08`.

## Resultados (comandos realmente executados)

- `npm run typecheck`: PASS.
- `npm test`: banco 155/155, API 191/191.
- `npm run build`: PASS.
- E2E da demonstração: 7 suítes PASS, incluindo a nova em 3 larguras de tela.

Detalhe em `06`.

## Simulado × bloqueado

| Integração | Estado |
|---|---|
| Gateway, inventário e comandos | **simulado** (nenhum comando físico possível em P0: o banco exige `kind = simulator` e `homologation_status = simulated`) |
| ONVIF/RTSP, Intelbras, Hikvision, Dahua, Axis, Uniview | `pending_hardware` |
| Linear HCS | `pending_hardware` + protocolo oficial |
| SIP/interfonia | `pending_hardware` |
| mTLS do gateway | `pending_infra` (broker persistente fora da Vercel, P1) |
| HMAC de comando verificado pelo agente | requisito de P2 antes de qualquer hardware real |

## Riscos para produção

1. **O gatilho em `packages` roda no recebimento e na retirada.** É leve (1 insert + busca de consumidores, sem rede), mas é novo no caminho crítico. Rollback: `disable trigger` (`07`).
2. **`platform_context` é alterada por patch de texto.** Ensaiar sobre a definição de produção antes de aplicar.
3. **O front novo chama `tenant_modules`.** Sem a migration, cai para "só Encomendas", sem erro visível. Aplicar a migration antes do deploy.
4. **Volume de eventos.** Sem consumidores cadastrados, os eventos só acumulam até a retenção de 90 dias. Monitorar o tamanho de `domain_events`.
5. **Visitantes guardam nome de terceiros.** Conferir o termo de privacidade do condomínio antes do piloto.

## Próximo passo (precisa de aprovação)

- Ensaio com rollback em produção.
- Aplicar as 2 migrations.
- Deploy.
- Ligar `visitors` e `concierge` só no condomínio piloto.
