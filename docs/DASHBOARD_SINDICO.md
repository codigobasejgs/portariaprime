# Dashboard do síndico (Painel › Análise)

Fonte: `public.dashboard_executive` e `public.dashboard_unit_ranking` (migração `20261103000200_dashboard_executive.sql`). Só **admin** do condomínio (`app.is_admin`); porteiro, morador e admin de outro condomínio recebem "Sem permissão". O navegador recebe só agregados, mais duas listas limitadas: o ranking paginado (máx. 200 por página) e as 20 encomendas mais antigas que ainda aguardam retirada (unidade, recebida em, horas, situação; sem nome, rastreio ou foto).

## Período e filtros
- Datas no fuso do condomínio; intervalo `[início 00:00, fim+1 00:00)`. Máximo: `fim − início ≤ 366` (um ano completo cabe).
- Atalhos: hoje, ontem, últimos 7/30, mês, trimestre, semestre e ano (atual e anterior), além de personalizado. Os períodos "atuais" vão até hoje.
- **Período anterior** = mesma quantidade de dias, logo antes do início.
- Filtros (`p_filters`): `block`, `unit`, `status` (situação atual ou `PENDENTES`), `carrier`. As opções mostram só valores que existem nas encomendas. A seleção fica em `sessionStorage` com chave `pp_painel_analise:<id do condomínio>`.
- A base sempre exclui `PRE_REGISTRADA`.

## Métricas
| Métrica | Definição |
|---|---|
| Recebidas | `received_at` no período |
| Entregues | `picked_up_at` no período, não importa quando a encomenda chegou |
| Taxa de retirada (coorte) | das recebidas no período, quantas já foram retiradas até agora ÷ recebidas; sem recebidas, `null` |
| Aguardando agora | `app.occupies_space(status)` (RECEBIDA/ARMAZENADA); não depende do período |
| Atrasadas | aguardando agora com mais de **72 h**, valor devolvido em `overdue_hours`. Não existe prazo operacional configurável: `reminder_after_hours` vale só para o lembrete ao morador |
| Tempo até retirada | `picked_up_at − received_at` das entregues no período: média e mediana, em horas |
| Unidades movimentadas | unidades distintas com recebida ou entregue no período |
| Variação | `(atual − anterior) ÷ anterior`; com anterior = 0, `null` ("sem base de comparação") |
| Série | por dia até 62 dias, por semana até 190 e por mês acima disso. O primeiro intervalo começa no início do período |
| Saldo pendente | no fim de cada intervalo: recebidas até o fim − encerradas até o fim (retirada em `picked_up_at`; devolução, cancelamento ou extravio em `resolved_at`). Sem filtros, o último saldo é igual a "aguardando agora" |
| Faixas de pendência | aguardando agora em ≤24 h, 24–48 h, 48–72 h e >72 h |
| Recebimento → aviso | `notified_at − received_at` (primeiro aviso aceito pelo provedor) das recebidas no período. Quem não tem `notified_at` fica fora da amostra e entra em `without_notice` |
| Aviso → retirada | `picked_up_at − notified_at` das entregues no período que têm aviso |
| Em até 24/48 h | entregues no período com tempo ≤ 24/48 h ÷ entregues; sem entregas, `null` |
| Ranking de unidades | recebidas, entregues e pendentes agora; % do total recebido; variação das recebidas contra o período anterior; tempo médio de retirada. Ordem: recebidas, entregues, pendentes, bloco, unidade |

## Inteligência do condomínio
São calculados no navegador a partir dos agregados (`src/lib/dashboard.ts`, função `insights`): crescimento das recebidas, bloco com mais recebidas, retiradas depois de 48 h (comparadas com o período anterior), dia e hora de pico, concentração nas 5 unidades com mais recebidas e atrasadas agora. Cada item mostra o número em que se baseia. Não há previsão nem IA.

## Exportação
CSV (BOM UTF-8, `;`, fórmulas neutralizadas), XLSX (`src/lib/xlsx.ts`, zip stored + CRC32, texto inline) e PDF (`pdf-lib`, Helvetica com WinAnsi). Os acentos do português (ç, ã, é, õ, º) saem normalmente. Fora do WinAnsi, `→ ≤ ≥ —` viram `-> <= >= -` e o restante vira `?`. Os três formatos usam os mesmos dados da tela, com indicadores, ranking (o Top escolhido ou todas as unidades) e série. Nome do arquivo: `painel-<slug>-<início>-a-<fim>.<ext>`.

## Pendências
- **Ranking por destinatário: indisponível.** `packages.recipient_name` vem da etiqueta ou do OCR e não tem vínculo com morador ou usuário. O ranking será possível quando a encomenda tiver um vínculo confiável com o destinatário (por exemplo, `resident_contact_id`).
- **Filtro de condomínio:** não foi implementado. Quem administra vários condomínios usa o "Trocar de condomínio" do menu, e os filtros ficam separados por condomínio.
- **Desempenho:** cada chamada percorre todas as encomendas do condomínio, porque o saldo precisa do histórico. Os índices `(tenant_id, received_at)` e `(tenant_id, picked_up_at)` já existem. Medido em 03/11/2026 no Postgres 17 local (notebook, transação desfeita) com **50.000 encomendas e 400 unidades** em um condomínio: `dashboard_executive` ≈ 0,44 s (30 dias), 0,44 s (90 dias), 0,47 s (1 ano), 0,13 s com filtro de bloco; `dashboard_unit_ranking` ≈ 0,08 s. Roteiro: `tests/evidence/tmp/bench.sql` (fora do Git). Se o volume passar disso, a saída é guardar o saldo diário.
