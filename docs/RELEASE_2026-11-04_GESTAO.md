# Release 04/11/2026: gestão do síndico (relatórios, unidades, moradores)

## O que foi publicado
- **Migrations:**
  - `20261104000200_reports`, aplicada às 17:25 UTC (backup em `prod-backups/2026-11-04T17-25-29-717Z`).
  - `20261104000300_resident_relation`, aplicada às 17:38 UTC (backup em `prod-backups/2026-11-04T17-38-36-022Z`).
- **Deploy:** `dpl_DK5k9qbamQDKuyoJgmBmXms2Y86e`, commit `6ca6bbb`. Commits da release: `47ea21a` e `6ca6bbb`.

## O que muda para o síndico
- **Relatórios → Encomendas:**
  - Filtros: período de recebimento e de retirada, situação, transportadora, bloco, unidade, porteiro, registro (portaria ou totem), destinatário, rastreio ou protocolo.
  - Atalhos prontos e totais: encomendas, aguardando retirada, retiradas, exceções e tempo médio até a retirada.
  - Rankings por transportadora e das unidades que mais receberam.
  - Exportação em CSV, Excel e PDF, com o mesmo recorte da tela.
  - "Pergunte ao relatório": transforma frases em filtros, sem IA. Mostra o que foi entendido e o que não foi usado.
- **Relatórios → Moradores e unidades:** filtros por bloco, unidade, situação, perfil, unidades com ou sem morador, e busca por texto. Exportação nos três formatos.
- **Unidades:**
  - "Montar blocos e apartamentos": blocos por letra, número ou nome, ou sem blocos; apartamentos por andar ou em sequência. Prévia antes de gravar; grava tudo ou nada, dentro do limite do plano.
  - Filtro rápido por bloco na lista.
- **Moradores:**
  - Perfil obrigatório no cadastro (proprietário, locatário, dependente, funcionário ou outro), visível na fila, no vínculo e nos relatórios.
  - "Enviar link de nova senha": o síndico nunca vê nem define a senha do morador. Vale só para morador deste condomínio, com um envio a cada 10 minutos.
- **Divulgação:** QR Code da entrada e de cada bloco. O QR de bloco abre o cadastro com o bloco já escolhido; um bloco que não existe é ignorado.

## Evidências
- **Testes locais:** `test:db` 104/104, `test:api` 118/118, typecheck e build ok.
- **Testes negativos:**
  - Porteiro, morador, visitante e síndico de outro condomínio são recusados nos relatórios e no reset de senha.
  - Filtros inválidos (chave desconhecida, data ou identificador inválido, objeto no lugar de texto) são recusados.
  - O isolamento entre condomínios foi provado: o teste acusa a falha se o filtro por condomínio for removido.
- **Ensaio das duas migrations** sobre o estado de produção: pedidos antigos, sem perfil, continuam aprováveis.
- **Produção, só leitura:**
  - As funções novas não são executáveis por `anon`, e as internas (`app.*`) não são executáveis por ninguém.
  - Nenhuma tabela aceita TRUNCATE nem escrita por `anon`.
  - Gatilhos de cadastro: `on_auth_user_resident_signup` e `on_auth_user_resident_signup_relation`.
- **Smoke no site, sem login:**
  - As 7 funções novas recusam visitante (401), e `/api/team/resident-reset` também.
  - O QR `?bloco=1A` chega ao cadastro com o bloco 1A escolhido e suas unidades; o perfil aparece com as 5 opções; nenhum erro de JavaScript.
  - Quiosque e portal: `kiosk-routing` OK.

## Não testado
- As telas novas logado como síndico, porque exige a conta real. Os testes de navegador locais não rodaram, porque o Auth local estava fora do ar.
- Envio real do link de nova senha, porque dispara e-mail a um morador real.

## Rollback
- **Site:** promover de novo `dpl_6Hx9G6QSyYjS45ErNqhT6kz4sbyf`.
- **Banco, migration 0300** (só se necessário):
  1. Remover os gatilhos `on_auth_user_resident_signup_relation`, `access_request_relation_from_draft` e `access_request_relation_to_membership`.
  2. Remover as funções `access_request_set_relation` e `resident_password_reset_check`.
  3. Recriar `list_access_requests` e `report_residents` a partir do backup.
  4. A coluna `relation` pode ficar sem prejuízo.
- **Banco, migration 0200:** remover as funções `report_*` e `units_generate` e o índice `packages_tenant_carrier_idx`.
