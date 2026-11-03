# Cadastro do morador

## Fluxo (uma etapa)

1. O morador abre o portal `/c/{slug}` e toca em **Criar minha conta**. Isso leva a `/cadastro?next=/c/{slug}/solicitar&portal={slug}`.
2. O formulário único tem: nome completo, e-mail, celular/WhatsApp (máscara BR, enviado em E.164), bloco e unidade, senha com confirmação e ciência do termo de dados.
   - Bloco e unidade vêm de `portal_units` (só unidades reais). Quando a unidade não aparece, a opção "não está na lista" abre um campo de texto; a administração confere esse texto antes de aprovar.
   - O checkbox do termo começa desmarcado.
3. `supabase.auth.signUp` envia os dados em `user_metadata.pp_signup`. O gatilho `app.resident_signup_capture` grava `resident_signup_drafts` (expira em 7 dias).
4. Com sessão (Auth com confirmação automática, como em produção), `/c/{slug}/solicitar` chama `resident_signup_finalize`. Essa função é idempotente: cria o pedido e registra o aceite na mesma transação, depois mostra **Cadastro recebido com sucesso!**.
5. Sem sessão (confirmação de e-mail ligada), aparece a tela "Cadastro recebido". Ela persiste no F5 da mesma aba. O primeiro login finaliza o cadastro sem pedir os dados de novo.
6. Se o termo mudou ou algum dado deixou de valer, `finalize` devolve `needs_review`. O morador vê **Revise seu cadastro** com os dados preenchidos e o aceite desmarcado.
7. Situações após o login:
   - **Pendente:** tela de recebido, com "Acompanhar minha solicitação".
   - **Recusado ou encerrado:** formulário com os dados anteriores e o motivo.
   - **Aprovado:** vai direto para `/c/{slug}/inicio`.

## Administração

- O menu **Unidades e moradores** mostra um contador de pendentes (`access_requests_pending_count`). Ele atualiza em tempo real (aviso `access_request`), ao voltar à aba e depois de cada decisão.
- A fila mostra e-mail confirmado ou não, celular, o termo aceito e a seção "Cadastros não concluídos" (`access_incomplete_signups`). Nada é aprovado nem atribuído automaticamente.
- Aprovar ou recusar enfileira e-mail e WhatsApp (`access_decision`).

## Termo de dados (LGPD)

- O termo **global** (`privacy_terms_global`) é mantido pela plataforma em Admin › Jurídico. `{{CONDOMINIO}}` é trocado pelo nome do condomínio no texto exibido.
- O aceite guarda a versão, o `term_hash` (modelo), o `displayed_text_hash` (texto exibido) e o nome exibido.
- O termo próprio do condomínio é opcional. Quando publicado, substitui o global nos novos cadastros.
- Aceites antigos não são migrados nem recriados.

## Avisos (outbox `notification_jobs`)

| Evento | Destinatário | Canais |
|---|---|---|
| `access_request` | quem aprova | push, e-mail |
| `access_received` | morador | e-mail, WhatsApp |
| `access_decision` | morador | e-mail, WhatsApp |

WhatsApp usa o canal do condomínio. Se ele não estiver conectado, usa `PLATFORM_WHATSAPP_INSTANCE`; sem nenhum dos dois, o job fica `disabled` com o motivo (nunca simulado).

## Testes

- `tests/db/resident-signup.test.mjs`: regras no banco, negativos, multi-condomínio.
- `tests/resident-signup.test.mjs`: validação no cliente.
- `tests/api/templates.test.mjs`: mensagens.
- `npm run test:signup`: jornada no navegador contra a pilha local.
