# Gate da landing

Situação: **FECHADO** — 19/10/2026.

Não iniciar landing comercial ou capturas promocionais antes de comprovar:

- [x] TypeScript frontend e backend (verificação local).
- [x] Build Vite e service worker.
- [x] Testes de banco em PGlite com shim mínimo do Supabase.
- [x] Testes de contrato InfinitePay com respostas simuladas somente na suíte.
- [x] Interface real de login/recuperação em 360, 390, 768, 1024 e 1440 px.
- [ ] Execução das APIs no runtime Vercel. Tentativa de `vercel dev --listen 3018` iniciou configuração de projeto remoto; interrompida antes de vincular/criar projeto.
- [ ] Migrations em Supabase isolado real; Auth, RLS, Storage e Realtime entre dois tenants.
- [ ] Recebimento, OCR, upload, retirada, assinatura e comprovante ponta a ponta.
- [ ] Concorrência com conexões Postgres distintas.
- [ ] Homologação de pagamento InfinitePay e canais externos.
- [ ] Restore com contagens, Auth e objetos Storage.
- [ ] Revisão dos limites, consentimentos, políticas de retenção e segurança restantes.

A raiz direciona ao login/seletor de condomínio. Build e testes locais não equivalem a produto pronto. Nenhuma publicação, cobrança ou mensagem a destinatário real foi autorizada nesta implementação.
