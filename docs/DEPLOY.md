# Execução e implantação

Não publicar esta versão antes de resolver o gate em `GATE_LANDING.md`.

## Local

1. `npm ci`
2. Configure `.env.local` a partir de `.env.example`, apontando para Supabase **isolado novo**. Não usar banco antigo sem backup e adaptação incremental.
3. `npm run dev` executa apenas a interface Vite. `/api/*` não funciona pelo Vite sozinho.
4. `npm run dev:full` executa `vercel dev --listen 3000`. Primeiro vínculo/configuração do projeto Vercel exige decisão do proprietário; não foi concluído automaticamente.
5. `npm run typecheck`, `npm test`, `npm run build`.
6. Teste visual sem login: inicie Vite em `127.0.0.1:3017` e execute `node tests/ui-smoke.mjs` (Edge instalado).

## Supabase novo

- Crie projeto isolado e habilite confirmação de e-mail.
- Configure Site URL com `APP_URL`; permita retornos `/entrar`, `/nova-senha` e fluxos de convite somente nos domínios controlados.
- Revise `supabase/config.toml` herdado antes de iniciar stack local. Não execute reset em produção.
- Aplique somente `supabase/migrations/202610*.sql` pelo mecanismo versionado de migrations, na ordem lexical. Não aplicar `supabase/legacy`.
- Buckets previstos: `tenant-private` privado; `tenant-public` para logos. Nenhuma prova de retirada em bucket público.
- Bootstrap: `node --env-file=.env scripts/bootstrap-admin.mjs --email EMAIL_VERIFICADO --confirm-project HOSTNAME_SUPABASE`. Executar deliberadamente; não foi executado nesta sessão.
- Seed somente em homologação deliberada, conforme guarda de `supabase/seed/demo.sql`. Não chama recuperação de histórico.

## Variáveis

`.env.example` lista os nomes consumidos. Supabase: painel do projeto. InfinitePay: InfiniteTag da conta recebedora Portaria Prime, sem `$`. Resend: chave e remetente de domínio verificado. Evolution: URL fixa controlada e chave do servidor. Gemini: chave e modelo efetivamente suportado. VAPID: par gerado para esta aplicação. `CRON_SECRET`: segredo aleatório longo.

Nunca prefixar service role, VAPID privada, Resend, Evolution ou Gemini com `VITE_`. `.env` existente não foi sobrescrito.

## Runtime, webhook e scheduler

Validar exports Web Request/Response no runtime Vercel antes do deploy. `vite build` não comprova execução das funções.

- Webhook: `POST APP_URL/api/webhooks/infinitepay`.
- Scheduler externo autenticado: `POST APP_URL/api/jobs/tick`, header `Authorization: Bearer CRON_SECRET`.
- `GET` equivalente está disponível para Vercel Cron. Frequência e orçamento de execução ainda precisam de configuração/homologação. Não há cron publicado nesta sessão.
- Configure fallback SPA somente para rotas de interface, nunca reescrevendo `/api/*` para HTML.

Comandos de publicação e aplicações remotas de migrations exigem autorização específica. Nada foi publicado.
