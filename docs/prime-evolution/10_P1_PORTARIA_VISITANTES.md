# 10 · P1 — Portaria e Visitantes

**Branch:** `feat/prime-p1-portaria-visitantes` (a partir de `1e540e7`, P0 + homologação)
**Produção:** NÃO alterada. Nada publicado. Ensaios só dentro de `begin … rollback`.

## Entregue

| Escopo pedido | Implementação |
|---|---|
| Painel moderno e responsivo do porteiro | Visitantes, em abas: **Agora** (quem está dentro, saída, encomendas do entregador), **Convites**, **Ocorrências**, **Histórico**, **Portões e câmeras**. Testado em 390, 820 e 1280 px, sem rolagem lateral |
| Entrada e saída de visitantes e prestadores | `visitor_entry`: por QR ou manual com quem autorizou, tipo, empresa, documento (4 últimos), observação. Idempotente. A saída sempre pode ser registrada |
| Pré-autorização do morador, QR com uso e validade configuráveis | `concierge_settings` por condomínio: validade padrão e máxima, entradas por convite, exigir documento, morador pode convidar, avisar na entrada. Tela em Configurações › Visitantes e portaria |
| Integração com condomínios, blocos, unidades e moradores existentes | Mesmas `units`, `unit_memberships`, `tenant_memberships`; FK `(tenant_id, unit_id)` |
| Cadastro sem duplicar pessoa | `visitor_profiles`: mesma pessoa = nome normalizado + 4 últimos do documento; entregador = o mesmo `couriers` de Encomendas |
| Histórico de acessos, ocorrências e auditoria | `portaria_timeline`: encomendas, entradas, saídas, entradas negadas e ocorrências, por período e unidade. Ocorrências com categoria, gravidade, encerramento e aviso à administração se a gravidade for alta. `audit_logs` em todas as ações |
| Encomendas × Portaria sem duplicar registros | `visit_parcels` liga a entrada do entregador às encomendas **já recebidas** pelo fluxo atual. Não cria encomenda; cada encomenda fica em uma visita só |
| Permissões e módulos contratados | `visitors`, `concierge` e `incident` (agora disponível) checados em RPC e RLS. Bloquear pessoa exige `approve`; configurar exige `settings`; indicadores, só administrador |
| Interface pronta para câmeras, interfonia e controle físico | `access_points`: cadastro com estado **real** (não instalado, simulado, aguardando homologação, homologado, offline). Botões "Abrir", "Ver ao vivo" e "Chamar" visíveis e **desabilitados**, com o motivo. Nenhum comando |
| PWAs porteiro, morador e síndico | Mesmos apps: porteiro (Visitantes), morador (atalho "Vai receber visita?" no Início + Visitas), síndico (indicadores da portaria no painel + configuração) |
| Bloqueio de entrada | Lista restrita com motivo. A entrada negada fica registrada (histórico, auditoria, `access.denied.v1`) e não consome o convite |
| Ajuda e tours | Artigos: ocorrências, entregador. Tour do síndico. Tour do porteiro atualizado |
| Demonstração | `/demonstracao` com tudo ligado e dados fictícios. Nada fictício entra em produção |

## Migration

`supabase/migrations/20261119000100_concierge_p1.sql`, aditiva.
- **Tabelas novas:** `concierge_settings`, `visitor_profiles`, `visit_parcels`, `incidents`, `access_points`.
- **Colunas novas em `visitor_visits`:** `profile_id`, `company`, `notes`, `denied`.
- **Funções redefinidas:** `visitor_pass_create` (passa a obedecer à configuração) e `visitor_check_in` (mesma assinatura do P0, delega para `visitor_entry`).

## Testes executados (19/11)

| Comando | Resultado | Evidência (`tests/evidence/tmp/p1/`) |
|---|---|---|
| `npm run typecheck` | PASS | `typecheck.txt` |
| `npm test` | banco **161/161** (P0 tinha 155; +6 do P1), API 191/191 | `test.txt` |
| `npm run build` | PASS | `build.txt` |
| E2E `concierge-p1-demo` (3 larguras) | PASS | `e2e-concierge-p1-demo.txt` |
| E2E `modules-demo`, `demo-offline` 26/26, `batch-receive`, `portaria-steps-mobile`, `portaria-suggestions`, `assistant-demo`, `whatsapp-chat-demo` | PASS | `e2e-*.txt` |
| Ensaio em produção P0+P1 com rollback | 16 tabelas fechadas, funções internas sem EXECUTE, capacidades preservadas, rollback limpo | `rehearse-prod.txt` |
| Recebimento em produção com P0+P1 aplicados na transação (rollback) | `receive_and_store` OK, evento `parcel.received.v1` com payload mínimo, 6 avisos enfileirados; contagens idênticas depois | `rehearse-parcel.txt` |

**Mutação:** desligar o bloqueio, ou tirar o filtro de condomínio no vínculo de encomendas, faz a suíte falhar.

`tests/e2e/modules-demo.mjs` foi ajustado: a "Entrada sem convite" agora abre o formulário completo do P1 ("Registrar entrada"). A regra testada é a mesma.

## Revisão de segurança independente

Nada crítico. Corrigido antes de fechar o P1:

| Gravidade | Achado | Correção |
|---|---|---|
| Alta | Ler convite (QR) de pessoa bloqueada mostrava "entrada registrada" ao porteiro, embora o banco registrasse a negativa | O QR passou a usar `visitor_entry`; resposta `denied` mostra "Entrada NÃO autorizada" |
| Média | Morador lia o motivo interno do bloqueio na linha da visita | Motivo genérico na visita; leitura direta de `visitor_visits` só por colunas (sem `reason`, `notes`, `profile_id`) |
| Média | Nome levemente diferente, ou sem documento, contornava o bloqueio | Mesmo nome de uma pessoa bloqueada exige que a equipe confirme que é outra pessoa; a confirmação é auditada (`visitor.namesake_confirmed`) |
| Média | Tentativa negada aparecia como visita para o morador | `visitor_list` esconde negadas do morador; a equipe vê o campo `denied` |
| Baixa | Salvar configuração parcial zerava as demais; `null` passava; validade padrão podia passar da máxima | Merge por chave, `null` recusado, `check` entre validade padrão e máxima |
| Baixa | Vínculo de encomendas sem limite superior de horário | Mesma janela dos candidatos |
| Baixa | Corrida ao criar o cadastro devolvia erro cru | `on conflict do nothing` + nova leitura |
| Baixa | FKs sem `tenant_id` | FKs compostas `(tenant_id, …)` em visitas, vínculos e ocorrências |
| Baixa | Configuração padrão montada por posição | Padrão por campo |

Cada correção tem asserção nova em `tests/db/concierge-p1.test.mjs`.

## Isolamento A/B provado (`tests/db/concierge-p1.test.mjs`)

Com a mesma unidade "A 101" em A e B, um usuário de B:
- não busca cadastros de A;
- não vincula encomenda de A a uma visita de B;
- não usa o entregador de A;
- não lê ocorrências, histórico ou indicadores de A.

## Pendências

- **Câmeras, interfonia e portões reais:** P2, com hardware, agente Go e HMAC.
- **Foto do visitante e leitura de documento por OCR:** não feitos, por decisão de minimização (LGPD). Avaliar com RIPD.
- **Exportar o histórico em CSV/PDF:** não feito. Os relatórios atuais de Encomendas continuam iguais.
- **Testes com Auth real:** PWA, jornada, cadastro, totem e Android não rodaram (NOT_RUN). Precisam da stack local com Auth.

## Instruções de homologação (quando autorizado)

1. Na ordem, cada passo com aprovação:
   1. ensaio `rehearse-1119.mjs`;
   2. aplicar `20261118000100`, `20261118000200` e `20261119000100` com `prod-apply-1106.mjs`, com backup e comparação de contagens;
   3. push;
   4. deploy.
2. **Encomendas (smoke):** receber, avisar, retirar com QR, abrir o comprovante.
3. **Piloto:** ligar `visitors`, `concierge` e `incident` só no condomínio piloto (`/admin`).
4. **Síndico:**
   1. Configurações › Visitantes e portaria: definir a validade.
   2. Cadastrar 1 portão e 1 câmera em "Portões e câmeras" e conferir que aparecem como "Não instalado".
5. **Morador:** criar um convite e confirmar que a validade respeita a configuração.
6. **Porteiro:**
   1. ler o convite e confirmar a entrada;
   2. repetir o QR e conferir que é negado;
   3. "Entregador": buscar um entregador já cadastrado em Encomendas, registrar a entrada e marcar as encomendas recebidas;
   4. registrar uma ocorrência e encerrar;
   5. conferir tudo no Histórico.
7. **Síndico:** bloquear um cadastro com motivo. O porteiro tenta a entrada: deve ser negada e ficar no histórico.
8. **Outro condomínio:** conferir que nada mudou.

**Rollback:** ver `07` e `09`. O P1 só adiciona; desligar os módulos esconde tudo e preserva os dados.
