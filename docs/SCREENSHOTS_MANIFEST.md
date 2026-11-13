# Manifesto de capturas

Geradas por `scripts/capture-screens.mjs` em 2026-11-13, a partir do commit `47ed353` (mais alterações locais não commitadas), na stack Supabase local isolada, com Edge headless, tema claro e movimento reduzido.
Dados 100% fictícios (domínio `.invalid`). Nenhum envio externo. QR desfocado; assinatura e fotos sintéticas; tokens existem apenas na stack local.

| Arquivo | Rota | Viewport | Cenário |
|---|---|---|---|
| `public/screens/painel-desktop.webp` | `/c/:slug/painel (Operação)` | 1440x900 | Visão geral: 9 entradas, 2 retiradas, 1 encomenda acima de 72 h |
| `public/screens/armazenamento-desktop.webp` | `/c/:slug/painel (ocupação)` | 1440x900 | Ocupação por local de guarda |
| `public/screens/assinatura-desktop.webp` | `/c/:slug/configuracoes?m=plano` | 1440x900 | Mês grátis ativo com início, fim e plano escolhido |
| `public/screens/marca-a-desktop.webp` | `/c/:slug/portaria` | 1440x900 | Condomínio A com marca azul |
| `public/screens/marca-b-desktop.webp` | `/c/:slug/portaria` | 1440x900 | Condomínio B com marca verde; dados separados de A |
| `public/screens/recebimento-desktop.webp` | `/c/:slug/portaria` | 1440x900 | Recebimento em etapas: etapa 2 preenchida, antes de salvar (sem etiqueta real) |
| `public/screens/comprovante-desktop.webp` | `/c/:slug/portaria (comprovante)` | 1440x900 | Comprovante após retirada com assinatura e foto sintéticas (código de verificação desfocado) |
| `public/screens/portaria-mobile.webp` | `/c/:slug/portaria` | 390x844 | Portaria no celular: aguardando retirada |
| `public/screens/morador-mobile.webp` | `/c/:slug/inicio` | 390x844 | App do morador: encomendas aguardando retirada |
| `public/screens/morador-qr-mobile.webp` | `/c/:slug/inicio (QR)` | 390x844 | QR de retirada (desfocado na captura; não utilizável) |
| `public/screens/og.png` | derivada de painel-desktop | 1200x630 | Imagem Open Graph |

Recapturar: `node scripts/local-stack.mjs up`, `npm run dev:stack` e `node --env-file=.env.stack.local scripts/capture-screens.mjs`.

## Modo Portaria Exclusiva (29/10/2026)

Derivadas de capturas reais do app Android gerenciado em **emulador Android 14** (`tests/evidence/emu-21-registrada.png`, `emu-24-comprovante.png`, `emu-04-manutencao.png`), condomínio de laboratório fictício. Código de verificação do comprovante desfocado. Exibidas como "demonstração em emulador"; não são fotos de aparelho físico.

| Arquivo | Origem |
|---|---|
| `public/screens/quiosque-recebimento.webp` (+ `-720`) | `emu-21-registrada.png` |
| `public/screens/quiosque-comprovante.webp` (+ `-720`) | `emu-24-comprovante.png` (verificação desfocada) |
| `public/screens/quiosque-manutencao.webp` (+ `-720`) | `emu-04-manutencao.png` |

Em 13/11/2026 estas três capturas **não foram refeitas**: mostram a tela de Encomendas anterior ao passo a passo (abas Receber/Entregar/Buscar). Refazer exige o emulador Android com o app de laboratório.
