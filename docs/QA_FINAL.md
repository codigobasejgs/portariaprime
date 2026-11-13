# QA final — Portaria Prime

Execução de 21/10/2026. Ambientes:

- **PGlite**: Postgres em memória com shim mínimo de Auth/Storage (`npm run test:db`).
- **Stack local**: PostgreSQL 17.6 + Supabase Auth v2.197.0 + PostgREST 12.2.3 + Supabase Storage oficiais, sem Docker (`docs/STACK_LOCAL.md`). Banco novo, dados fictícios.
- **Navegador**: Microsoft Edge headless via Playwright.
- **Produção**: `https://portariaprime.vercel.app` (somente leitura: HTTP e conteúdo servido; nenhum teste mutável em produção).

Contagem real desta rodada: **36 testes de banco + 26 de API/unidade** (`npm test`), **6 E2E de API** na stack local, **3 roteiros de navegador** (jornada do síndico, landing/tour/ajuda, PWA) e **5 larguras** do smoke de login. **0 falhas** na execução final. Não executados: ver “Não testado”.

## Matriz

| Área | Caso | Ambiente | Resultado | Evidência |
|---|---|---|---|---|
| Banco/restore | Migrations em banco novo real | Stack local | ✅ 16/16 | `local-stack.mjs up` |
| Banco/restore | Backup físico criptografado → cluster novo → contagens, FKs, checksums | Stack local | ✅ 75 tabelas, 822 linhas, 5/5 objetos | `restore-drill.mjs` |
| Banco/restore | Login com senha original após restore | Stack local | ✅ (após correção, ver D1) | `restore-drill-login.mjs` |
| Banco/restore | Upgrade incremental em produção | Produção | ✅ 3 migrations aplicadas e verificadas | `BANCO_E_RESTAURACAO.md` |
| Isolamento | A não lê/grava B: tabelas, RPC, Storage, URL assinada; mesmo bloco/unidade | Stack local | ✅ | `supabase-real.test.mjs` |
| Isolamento | Realtime | — | ❌ não testado (stack sem Realtime) | — |
| Autenticação | Login, convite certo/errado/reutilizado, revogação com JWT válido | Stack local | ✅ | E2E 3 e 5 |
| Autenticação | Papel adulterado, chamada a RPC de serviço | Stack local + PGlite | ✅ recusado | E2E 6, `security-fixes` |
| Operação | Receber → avisar → QR → entregar → assinatura → comprovante → painel | Navegador + stack | ✅ | `journey.mjs` |
| Operação | Duplo clique/retry não duplica | PGlite + stack | ✅ | E2E 4 |
| Concorrência | Duas baixas simultâneas por conexões distintas | Stack local | ✅ exatamente uma vence | E2E 4 |
| Concorrência | Última vaga simultânea | — | ❌ não testado | — |
| QR/totem | QR de outro tenant, expirado, repetido | PGlite + stack | ✅ | E2E 4, `db.test` |
| QR/totem | Totem físico pareado | — | ❌ não testado | — |
| Trial | Um mês de calendário, 31/01 → fim de fevereiro, fuso, cancelamento, troca, elegibilidade | PGlite | ✅ | `db.test` |
| Trial | Trial real criado no servidor sem cobrança | Stack + navegador | ✅ | E2E 1, `journey.mjs` |
| Pagamentos | Valor adulterado, retorno falso, webhook forjado/repetido, link ambíguo, cancelado tardio | PGlite + mocks na suíte | ✅ | `billing*.test` |
| Pagamentos | InfinitePay real | — | ⛔ falta `INFINITEPAY_HANDLE` e autorização | — |
| Visual/PWA | Atualização preserva rascunho | Navegador | ✅ | `pwa-update.mjs` |
| Visual/PWA | Landing 360/390/768/1024/1440 sem rolagem horizontal; zoom 200%; teclado | Navegador | ✅ | `landing-tour.mjs` |
| Visual/PWA | App interno em todas as larguras e tema escuro | — | ⚠ parcial (login em 5 larguras; morador 390; portaria 1024/1440) | capturas |
| Tour | Alvos reais existem no código | Unitário | ✅ | `help-tours.test` |
| Tour | Primeiro acesso oferece; muda de rota; balão não cobre o alvo; Esc; retomar na ajuda | Navegador 390px | ✅ | `landing-tour.mjs` |
| Ajuda | Busca com acento/sinônimo; sem resultado; artigo com passo a passo | Unitário + navegador | ✅ | idem |
| Ajuda | Formulário grava antes de confirmar | Navegador + stack | ✅ | idem |
| Landing | Preço igual ao banco; ciclo; CTA leva ao cadastro com plano/ciclo | Navegador + stack | ✅ | idem |
| Landing | Funil: 4 eventos gravados, deduplicados, sem campo pessoal | Navegador + stack | ✅ | idem + `funnel.test` |
| Landing | SEO: robots/sitemap/canonical; privadas com noindex | Navegador | ✅ | idem |
| Landing | Lighthouse (mobile simulado, gzip) | Build local | Desempenho 73 · Acessibilidade 100 · Boas práticas 100 · SEO 100; LCP 5,0 s; CLS 0 | `tests/evidence/lighthouse/` |
| Deploy | Ver seção Produção | Produção | ver abaixo | — |

## Defeitos encontrados e corrigidos nesta rodada

| ID | Sev. | Defeito | Correção | Reteste |
|---|---|---|---|---|
| D1 | P0 (para restauração) | Restore com `--no-owner` deixava `auth.users` com dono `postgres` e RLS sem policy: Auth via 0 usuários, ninguém entrava | Script devolve posse a `supabase_auth_admin`/`supabase_storage_admin`; documentado no runbook | ✅ login restaurado |
| D2 | P2 | Ajuda/tour eram 10 parágrafos e 3 frases, sem alvo real | Central com 20 artigos, 12 tours com `data-tour` e verificação automática | ✅ |
| D3 | P2 | `/` sempre redirecionava para login | Landing pública; logado vê “Acessar meu condomínio” | ✅ |
| D4 | P2 | Cópia “Avisos por e-mail” prometia canal não homologado | Texto condicional “quando configurados” | ✅ |
| D5 | P2 | Teste PWA assumia `/` = login | Teste usa `/entrar` | ✅ |
| D6 | P3 | Bundle inicial com páginas de login/app | Páginas sob demanda e chunks separados | ✅ build |

Nenhum P0/P1 aberto nos fluxos testados.

## Avaliação de facilidade

Inspeção heurística por tarefa, feita pelo agente sem consultar código durante o roteiro; **não é teste com usuários reais** (nenhum participante foi recrutado).

- Síndico configura: oferta de tutorial na primeira tela; próximos passos listados após criar o condomínio. Risco: muitos campos na tela de Configurações em celular.
- Porteiro recebe/entrega: dois botões grandes no topo (“Receber encomenda”, “Entregar ao morador”) abrem o passo a passo em pop-up, com os botões de ação fixos embaixo; a lista “Aguardando retirada” tem “Entregar” em cada encomenda.
- Morador encontra QR: botão primário na lista “Para retirar”.
- Gestor entende trial e preço: Assinatura mostra início, fim e valor depois do teste.

## Não testado / pendente

- Realtime entre tenants; última vaga simultânea; totem em tablet físico; app interno no tema escuro e em todas as larguras.
- Integrações reais: InfinitePay, Resend, Evolution, Gemini, Web Push com VAPID e aparelhos reais.
- Backup do projeto de produção.

## Produção

Ver resultado da publicação em `docs/FINALIZACAO_CONTEXTO.md` (seção Publicação).
