# Totem da portaria (equipe logada)

Rota da equipe: `/c/:slug/totem-equipe` (menu “Totem da portaria”). Quem da equipe abre `/c/:slug/totem` logado é levado para cá. Com OCR no plano, a leitura roda sozinha após a foto. Só porteiro e administrador ativos. Usa a sessão do operador (RLS), nunca service role.

## OCR sem conta no totem pareado

Em `/c/:slug/totem`, sem sessão de usuário, o dispositivo pareado oferece **Escanear etiqueta (câmera)** e envio de arquivo. A foto dispara `/api/totem/ocr` com `X-Device-Secret`, sem JWT. Não aparece o link “Sou da equipe”.

`device_consume_ocr` valida dispositivo ativo, plano, condição comercial e franquia mensal compartilhada; intervalo persistente mínimo de 10 segundos por dispositivo. Tenant vem do dispositivo, nunca do corpo. A API revalida a credencial após a chamada ao Gemini. Retorna apenas transportadora, rastreio, bloco, unidade e confiança extraídos da imagem, sem consulta a moradores, nomes, contatos ou histórico. O cliente não armazena a imagem. O recebimento direto descrito abaixo dispensa conferência posterior; não autoriza retirada.

## Recebimento automático no totem pareado

Após conferir a unidade na própria tela, **Registrar encomenda e avisar moradores** chama `/api/totem/receive`. O servidor identifica o condomínio pelo dispositivo, escolhe um local cadastrado com vaga, registra a encomenda diretamente e cria os avisos na mesma transação. A encomenda fica visível aos moradores ativos da unidade sem aprovação da portaria. A tela mostra onde depositar o item e só avança ao tocar em **Registrar outra encomenda**.

Sem unidade válida, dispositivo revogado, plano indisponível, local cadastrado ou vaga, nada é registrado. Repetir a mesma operação não duplica encomenda nem avisos. Não há promessa de WhatsApp entregue no clique: o worker envia a fila conforme conexão do canal, franquia e agendador. Registros antigos `PRE_REGISTRADA` não são convertidos automaticamente por esta alteração.

Testes: `tests/db/device-ocr.test.mjs`, `tests/api/device-ocr.test.mjs` e `tests/e2e/device-ocr-ui.mjs` (UI anônima com provedor simulado). Câmera física e leitura real nesse endpoint não homologadas nesta execução.

## Registrar encomenda

Passo a passo em pop-up (`ReceiveForm`), uma etapa por tela, botões de ação fixos embaixo: **1** entregador e transportadora → **2** encomenda (itens abaixo) → **3** confirmação, com “Cadastrar próxima encomenda” (volta à etapa 2, mesmo entregador) ou “Encerrar recebimento” → resumo e “Finalizar”.

1. Foto da etiqueta (câmera `getUserMedia` com câmera traseira; alternativa: arquivo). Reencodada no navegador (sem EXIF). SHA-256 da foto original é calculado no cliente.
2. OCR opcional (`/api/ocr/analyze-label`): extrai campos separados e chama `match_recipient` no servidor com a sessão do operador. Ver `OCR_VALIDACAO.md`.
3. Unidade: só vem pré-selecionada quando o servidor responde `matched` ou `name_only`. `conflict`, `ambiguous`, `unit_only` e `not_found` exigem escolha manual.
4. Local: `storage_availability` lista portaria › estante › prateleira com vagas; sugere o de maior folga, contingência por último; local lotado aparece desabilitado.
5. Operador guarda e marca “Guardei fisicamente em …”.
6. `receive_and_store` (uma transação): valida local/lotação com bloqueio (`pick_storage`, `FOR UPDATE`), recusa foto repetida pendente (`label_sha256`), grava encomenda, `storage_confirmed_at`, evento `storage_confirmed`, e enfileira avisos para a unidade inteira. Idempotente por `p_idempotency_key`.
7. Foto da etiqueta sobe ao bucket privado e é vinculada (`attach_package_file`). Falha de upload não duplica a encomenda.

## Entregar ao morador

Passo a passo em pop-up (`PickupModal`): **1** unidade (QR ou busca) e quem retira → **2** encomendas da unidade a entregar → **3** confirmação de cada uma (foto do item por encomenda; assinatura colhida uma vez e gravada em cada encomenda) → resumo com protocolos e “Encerrar entrega”. Cada encomenda é uma chamada própria a `deliver_package`.

1. Morador mostra o QR (`issue_pickup_token`, uso único, hash no banco, renovar revoga o anterior).
2. Leitura chama `lookup_pickup_token`: **só consulta**, não consome. Mostra foto da etiqueta, unidade e o local **atual** (após `move_package`, aparece o novo).
3. Operador informa quem retira e a relação (morador / recebedor autorizado), coleta assinatura e **foto do item entregue** (obrigatória).
4. Uploads (assinatura PNG, foto JPEG) vão ao bucket privado no caminho da encomenda.
5. `deliver_package` (uma transação): bloqueia a encomenda, exige que assinatura e foto existam, sejam do próprio operador (`storage.objects.owner = auth.uid()`) e não tenham sido usadas; consome o QR; grava comprovante imutável; enfileira avisos. Idempotente por `p_request`: retry após queda devolve o mesmo protocolo.
6. Comprovante fica no resumo da entrega (“Ver comprovante”); moradores da unidade veem no histórico e recebem link estável.

`confirm_pickup` deixou de ser chamável pelo cliente (`revoke execute ... from authenticated`); só `deliver_package` a usa.

## Offline e atualização

- Sem conexão, “Confirmar entrega” não envia e avisa. Nada é confirmado localmente.
- Erro após envio informa que nada foi confirmado e que repetir é seguro (mesma chave).
- Enquanto o modal de entrega está aberto, o aviso de nova versão fica bloqueado (`src/lib/capture.ts`).

## Testes

- `tests/db/totem.test.mjs` (PGlite): correspondência, última vaga, foto repetida, avisos para 3 moradores e não para a outra unidade, provas obrigatórias, idempotência, revogação.
- `tests/e2e/supabase-real.test.mjs` (Supabase local real): concorrência entre conexões, owner das provas, 3 moradores.
- `tests/e2e/totem-flow.mjs` (navegador Edge + Supabase local): percurso completo de UI.
