# 06 · Regressão e segurança

Executado em 18/11/2026 nesta máquina, branch `feat/prime-modular-portaria`, sem tocar produção. Evidências em `tests/evidence/tmp/p0/` (pasta ignorada pelo git).

## Regressão total

| Comando | Antes (baseline `26bd0d5`) | Depois (P0) |
|---|---|---|
| `npm run typecheck` | PASS | PASS |
| `npm test` (banco) | 150/150 | **155/155** |
| `npm test` (API + unidade) | 189/189 | **191/191** |
| `npm run build` | PASS | PASS |
| E2E demo `demo-offline` | 26/26 | 26/26 |
| E2E `batch-receive`, `portaria-steps-mobile`, `assistant-demo`, `whatsapp-chat-demo` | PASS | PASS |
| E2E novo `modules-demo` (celular 390, tablet 820, desktop 1280) | — | PASS |
| PWA (`test:pwa`), `test:journey`, `test:signup`, `test:totem`, `test:android` | NOT_RUN | NOT_RUN (precisam da stack local com Auth; não mudam com P0) |

**Incidente durante o trabalho:** 4 testes antigos quebraram com a primeira versão da migration. Os 4 foram corrigidos na causa, não no teste.
- **`platform_context` redefinida por inteiro:** perdia `devices`/`devices_release` (teste `mdm`). Agora a capacidade é encadeada na definição vigente.
- **`grant execute on all functions … to service_role`:** reabria wrappers internos antigos (testes `cleanup-disabled` e `security-fixes`). Agora o grant é só das funções novas.
- **Backup e restauração:** `module_catalog`, semeado pela migration, duplicava (teste `restore`). Entrou na lista de tabelas semeadas de `scripts/restore-prime.mjs`.

## Provas pedidas (testes em `tests/db/prime-modular.test.mjs` e `tests/gateway-simulator.test.mjs`)

| Prova | Teste |
|---|---|
| A e B com a mesma unidade "A 101", sem vazamento (banco, RPC, eventos) | morador de B não convida para A nem vê convites de A; QR de A não é reconhecido em B; B não lê módulos, gateways nem visitas de A |
| Stream/dispositivo de B negado a A | porteiro de B não comanda dispositivo de A; RLS de `gateways` e `gateway_devices` |
| Chave revogada impede comando | `gateway_revoke` → heartbeat 401; credencial anulada |
| Replay e TTL recusados | nonce errado, seq errada e resposta repetida → `rejected_*` auditado; TTL vencido → `expired`; resultado tardio vira `unknown` e é auditado |
| Comando entregue uma vez | o segundo heartbeat não reentrega |
| Webhook/evento duplicado não duplica | retry de `receive_package` com a mesma chave → 1 evento; `event_ack` repetido idempotente |
| QR já usado negado | check-in com o mesmo QR → "já utilizado"; revogado, vencido e de ex-morador também negados |
| Encomendas anteriores preservadas | recebimento + baixa pelas RPCs atuais; `status`/`idempotency_key` intactos; suítes antigas de encomendas 100% verdes |
| Falha do worker e reprocessamento | lease vencido volta para a fila; falha → retry com backoff; 6 falhas → dead-letter |
| `visitors` em A gera menus/APIs só em A | `tenant_modules` e `visitor_*` em A/B; RLS também respeita o módulo |
| Desligar não exclui dados nem afeta segurança | dados contados após desligar; saída de visitante continua registrável |
| Simulador: online/offline, fila, comando inválido, lógico × físico | sweep → offline; fila em disco sobrevive à queda; sem sensor → `acknowledged`/`unknown`, com sensor → `physically_confirmed` |
| Recebimento de encomenda não abre portão | nenhum `access_commands` criado após recebimento ou check-in |

**Mutação** (o teste pega a regressão):
- removendo `app.require_module` das RPCs de visitantes, a suíte falha;
- trocando a regra "confirmação física só com sensor", a suíte falha.

## Revisão de segurança independente

Agente revisor, leitura do código e testes locais. **Nada crítico ou alto.**

Corrigido antes de fechar P0:
1. Comando reentregue a cada heartbeat; agora a entrega é única (`requested → sent`).
2. "Só simulador" era só um rótulo; agora `gateway_create` e `access_command_request` exigem `kind = 'simulator'`.
3. Saída de visitante bloqueada com o módulo desligado; a saída agora exige só a equipe.
4. Convite de ex-morador ou de unidade inativa continuava valendo; agora é negado.
5. Resultado tardio se perdia; agora vira `unknown` + auditoria.
6. Comando de gateway offline ficava pendente para sempre; agora o sweep o faz vencer.
7. Texto que dizia "assinatura": é eco de nonce + seq. **HMAC por gateway é requisito de P2.**
8. Item malformado derrubava o heartbeat, e um relógio inválido dava 500; agora o item é ignorado e o relógio validado.
9. Falha emitia o evento de "recebido"; agora `access.command_failed.v1`, sem carimbo de ack.
10. A trilha imutável de módulos bloqueava excluir um condomínio; agora é imutável só para UPDATE.
11. Gateway pendente vencido ocupava vaga; agora não conta.
12. Sequências com grants padrão; revogados.

Pendente: ensaiar o patch de `platform_context` sobre a definição de **produção** (passo 1 do 07_ROLLOUT).

## LGPD e privacidade (P0)

- **Visitante:** nome, tipo e, opcionalmente, os 4 últimos caracteres do documento. Sem foto, sem documento completo, sem placa.
- **Eventos:** só ids e status.
- **Retenção:** 90 dias para eventos; convites listados até 7 dias após vencer.
- **Biometria, LPR e IA:** não implementados (P3). Exigem RIPD antes.
