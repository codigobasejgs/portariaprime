# Experiência do administrador

## Mapa de navegação

| Menu | Rota | Quem vê |
|---|---|---|
| Visão geral (Operação / Análise) | `/c/{slug}/painel?aba=operacao\|analise` | administrador |
| Encomendas (Receber encomenda, Entregar ao morador, lista e Histórico) | `/c/{slug}/portaria` (`?aba=receber|entregar` já abre o passo a passo) | equipe |
| ↳ Totem da equipe | `/c/{slug}/totem-equipe` (botão "Abrir totem") | equipe |
| Unidades e moradores | `/c/{slug}/pessoas?aba=unidades\|moradores\|solicitacoes` | administrador |
| Relatórios | `/c/{slug}/relatorios?status=…&antigas=1` | administrador |
| Configurações (índice) | `/c/{slug}/configuracoes` | `settings`, `team` ou `billing` |
| ↳ Módulo | `/c/{slug}/configuracoes?m={id}` | permissão do módulo |
| Ajuda | `/c/{slug}/ajuda?artigo={slug}` | todos |
| Notificações (página completa) | `/c/{slug}/avisos` | todos |
| Meu aplicativo e notificações (menu da conta) | `/c/{slug}/aplicativo` | todos |

Módulos: `condominio`, `identidade`, `portal`, `operacao`, `equipe`, `comunicacoes`,
`integracoes`, `comprovantes`, `totens`, `plano`, `seguranca`.

Rotas antigas: `/assinatura` → `configuracoes?m=plano`. Administrador que abre `/c/{slug}`
cai na Visão geral; porteiro, em Encomendas; morador, em Minhas encomendas.

"Administração da plataforma" aparece só no menu da conta e só para quem tem papel na plataforma.
O prazo do mês grátis saiu do topo: fica em Plano e assinatura e chega pelo sino (D-7, D-3 e fim,
uma vez por marco). Faixas no topo só para bloqueio real (carência ou assinatura inativa).

## Contrato dos indicadores

Tudo é calculado no banco (`supabase/migrations/20261022000700_dashboard.sql`), no fuso do
condomínio, só para administradores do próprio condomínio (`app.is_admin`). O cliente não soma
nem filtra dados para gerar número.

### `dashboard_operation(p_tenant, p_stale_hours = 72)`

| Campo | Definição |
|---|---|
| `waiting_now` | encomendas em `RECEBIDA`/`ARMAZENADA` agora |
| `stale_now` | as anteriores recebidas há mais de `p_stale_hours` |
| `received_today` / `picked_today` | do início do dia local até agora; pré-registro não conta |
| `occupancy` | `{used, capacity}`; `capacity = null` sem locais ("Capacidade não definida", nunca 0%) |
| `locations[]` | ocupação por local ativo |
| `attention` | solicitações pendentes, paradas além do prazo, locais ≥ 85%, avisos com falha final, PDFs com falha, pré-registros |
| `recent[8]` | últimas entradas/retiradas |

### `dashboard_analysis(p_tenant, p_from, p_to)` (até 366 dias)

| Campo | Definição |
|---|---|
| `entries` / `pickups` | `{value, previous, change}`; período anterior de mesma duração; `change = null` quando a base é 0 (sem "infinito") |
| `daily[]` | entradas e retiradas por dia local |
| `dwell` | horas até a retirada: `n`, `median_h`, `avg_h`; `p90_h` só com `n ≥ 10`; `invalid` conta datas inconsistentes |
| `aging_now` | quem aguarda agora: até 24 h, 24–48, 48–72, mais de 72 |
| `heatmap[]` | entradas por dia da semana ISO (1 = segunda) × hora local; a tela mostra a frase do pico como alternativa textual |
| `carriers[]`, `exceptions[]` | por transportadora; devoluções/cancelamentos/extravios resolvidos no período |
| `channels[]` | avisos por canal e estado (`pending`, `accepted`, `delivered`, `failed_retryable`, `failed_final`, `disabled`); "aceito" não é "lido" |
| `adoption` | unidades ativas, unidades com morador aprovado, solicitações pendentes |

### `my_notifications(p_tenant, p_unread, p_before, p_limit ≤ 50)`

`{unread, items}` só do próprio usuário; leitura é individual (marcar como lida não afeta outros).
Paginação por `created_at` (`p_before`).

## Testes e evidência

- `tests/db/dashboard.test.mjs`: gabarito com datas na virada do dia local, período anterior
  zerado, amostra vazia, permissões e isolamento entre condomínios, notificações por usuário.
- `tests/db/db.test.mjs`: lembrete do teste chega ao sino uma única vez por marco.
- `tests/e2e/admin-ux.mjs` (stack local, dados sintéticos): ordem do menu, sem faixa de teste,
  sino com contagem e leitura individual, Análise com aba lembrada, KPI → Relatórios filtrado,
  CSV, módulo por URL, redirecionamento de `/assinatura`, abas de moradores, atalho do totem,
  menu da conta sem administração da plataforma, larguras 320/375/414/768/1024/1366/1920 sem
  rolagem horizontal em painel, relatórios, configurações, pessoas e encomendas, drawer com Escape.
  Capturas ficam em `tests/evidence/` (ignorado pelo Git).
