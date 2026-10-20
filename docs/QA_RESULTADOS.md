# Resultados de QA

Legenda: ✅ passou local · ⚠ passou com ressalvas · ⛔ bloqueado (insumo externo) · ❌ não testado

## Banco (PGlite + shim mínimo Supabase)

`node --test tests/db/db.test.mjs tests/db/security-fixes.test.mjs`

| Cenário | Situação | Nota |
|---|---|---|
| Trial 31/01 termina último dia de fevereiro | ✅ | |
| Provisionamento idempotente; trial não repete para mesmo CNPJ | ✅ | |
| Sem e-mail verificado não provisiona | ✅ | |
| Isolamento: A não lê/escreve em B (tabelas, RPC, Storage, FK cruzada) | ✅ | |
| Mesmo rastreio em tenants distintos não colide | ✅ | |
| Retry com a mesma chave de idempotência não duplica | ✅ | |
| Lotação retorna erro, sem A1 por fallback | ✅ | |
| Outbox enfileira avisos com destinatário do banco, não do browser | ✅ | |
| Morador não lê dados de outro tenant nem se promove | ✅ | |
| Convite: e-mail errado, reutilizado e expirado são recusados | ✅ | |
| Revogação vale na próxima query | ✅ | |
| QR uso único; retirada concorrente (PGlite única conexão) | ✅ | |
| QR expirado recusado; manual exige justificativa e assinatura enviada | ✅ | |
| Exceções não contam como pendentes; ocupação correta | ✅ | |
| Checkout bloqueado durante trial; job cria exatamente 1 pedido | ✅ | |
| Carência bloqueia recebimentos; retirada de guardado liberada | ✅ | |
| Valor menor para revisão; pago ativa por calendário; duplicado ignorado | ✅ | |
| Cancelamento no trial não gera pedido; reativação mantém data original | ✅ | |
| Fuso: término preserva horário local em outro fuso | ✅ | |
| Catálogo: anônimo vê só publicados; atualização de preço sem impacto em pedidos existentes | ✅ | |
| Storage: porteiro B não envia para pasta de A; morador B não lê | ✅ | |
| Anônimo não acessa nada de negócio | ✅ | |
| Pedido cancelado/review não ativa assinatura em reprocessamento | ✅ | |
| Renovação antecipada mantém plano vigente; troca efetiva na data | ✅ | |
| Revogação desativa contatos; fila revalida antes de enviar | ✅ | |
| Suspensão do condomínio bloqueia totem | ✅ | |
| Push rejeitado sem allowlist; aceito em domínio conhecido | ✅ | |

## API/contrato (mocks locais — sem provedor real)

`tsx --test tests/api/billing.test.mjs tests/api/push-security.test.mjs`

| Cenário | Situação |
|---|---|
| Checkout: handle sem $, preço do servidor, URLs corretas | ✅ |
| Erro do provedor não inventa link | ✅ |
| payment_check: campos documentados, normalização | ✅ |
| parseWebhook: exige campos obrigatórios, descarta extras | ✅ |
| Webhook forjado (paid=false no provedor) não aplica | ✅ |
| Templates: HTML escapa XSS, WhatsApp remove formatação injetada, link correto | ✅ |
| validPushEndpoint: aceita provedor conhecido, rejeita IP/porta/userinfo | ✅ |

## Interface

`node tests/ui-smoke.mjs` (Edge instalado, Vite em 127.0.0.1:3017)

| Cenário | Situação |
|---|---|
| Login 360 px — sem rolagem horizontal, sem erros JS | ✅ |
| Login 390 px | ✅ |
| Login 768 px | ✅ |
| Login 1024 px | ✅ |
| Login 1440 px | ✅ |
| Recuperação de senha e voltar | ✅ |

## Não testado (pendente)

- APIs no runtime Vercel (exige vinculação de projeto).
- Migrations aplicadas em Supabase real com RLS e Auth.
- Isolamento com conexões Postgres distintas simultâneas.
- Recebimento, OCR, upload Storage, assinatura, retirada e comprovante ponta a ponta.
- Push remoto em dispositivos reais; compatibilidade de plataforma.
- Canais externos: InfinitePay, Resend, Evolution API, Gemini.
- Cron `billing_tick` com banco real e job duplicado.
- Backup restore com contagens, Auth e objetos Storage.
- Testes de carga e concorrência com pool de conexões real.
- Painel admin, bootstrap de superadministrador.

## Declaração

Nenhuma integração real foi ativada nesta sessão. Testes comprovam lógica local. Homologação com Supabase, InfinitePay, Resend e Evolution depende de credenciais, ambientes externos e ação explícita do proprietário. "Build passou" não equivale a produto pronto para produção.
