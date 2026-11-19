# 09 · Homologação do P0

**Data:** 19/11/2026 · **Commit:** `47fdea7` (branch `feat/prime-modular-portaria`)
**Produção:** NÃO alterada. Todos os ensaios rodaram dentro de `begin … rollback`.

## 1. Revalidação local (19/11)

| Comando | Resultado | Evidência (`tests/evidence/tmp/p0-hml/`, fora do git) |
|---|---|---|
| `npm run typecheck` | PASS | `typecheck.txt` |
| `npm test` | banco 155/155, API 191/191 | `test.txt` |
| `npm run build` | PASS | `build.txt` |

O banco cobre RLS, permissões, isolamento A/B, as regressões de Encomendas (recebimento, retirada, QR, comprovante, totem, lote) e os testes novos do P0.

## 2. Compatibilidade com produção (leitura e ensaio com rollback)

- **Última migration em produção:** `20261117000400`. As do P0 são posteriores e não colidem.
- **Funções usadas pelo P0:** todas as 15 existem em produção com a mesma assinatura (`app.block_mutation`, `app.platform_require`, `app.mdm_require_recent_auth`, `app.is_staff`, `app.unit_display` etc.).
- **Patch de `platform_context`:** o ponto de encaixe existe na definição de produção. O ensaio confirmou que **nenhuma** capacidade atual se perde e que `modules_manage` é acrescentada.
- **Ensaio 1** (`tests/evidence/tmp/rehearse-1118.mjs`):
  - as 2 migrations compilam;
  - as 11 tabelas ficam fechadas para anon/authenticated;
  - `token_hash`, `secret_hash` e `nonce` ficam sem SELECT;
  - as funções de serviço ficam sem EXECUTE público;
  - o gatilho em `packages` é criado;
  - Encomendas fica ligado nos 2/2 condomínios e Visitantes em 0;
  - rollback confirmado: as tabelas somem e `platform_context` fica intacta.
- **Ensaio 2** (`rehearse-1118-parcel.mjs`): com as migrations aplicadas na transação, `receive_and_store`, executado como o dono real de um condomínio:
  - **funciona**;
  - gera `parcel.received.v1` com as chaves `parcel_id, registered_via, status, unit_id`;
  - enfileira os avisos normalmente.

  Depois do rollback as contagens são idênticas: 36 encomendas e 3026 jobs antes e depois.

## 3. Plano de rollback

Detalhado em `07_ROLLOUT_ROLLBACK.md`. Resumo por gravidade:
1. **Problema num condomínio:** desligar o módulo no `/admin`.
2. **Gatilho afetando encomendas:** `alter table public.packages disable trigger packages_domain_events;`. As encomendas seguem; os eventos param.
3. **Front:** redeploy do commit anterior. O banco novo é compatível com o front antigo.
4. **Banco** (só se exigido, com backup):
   - remover o gatilho e as funções novas;
   - recolocar `platform_context` a partir do backup de funções que `prod-apply-1106.mjs` grava antes de aplicar;
   - `drop` das 11 tabelas novas.

## 4. Roteiro de homologação

**A. Preparação** (exige autorização expressa; nada disto foi feito):
1. Rodar `node tests/evidence/tmp/with-sbp.mjs tests/evidence/tmp/rehearse-1118.mjs` e conferir "permissoes: OK".
2. Aplicar com `PP_MIGRATIONS=20261118000100_modules_catalog,20261118000200_domain_events_visitors node … prod-apply-1106.mjs apply`. Isso faz backup, compara contagens e roda a varredura de segurança.
3. Fazer push e conferir o deploy na Vercel.

**B. Smoke de Encomendas** (sem mudança esperada):
1. Receber uma encomenda de teste.
2. Conferir que o aviso chega.
3. Retirar com QR.
4. Abrir o comprovante.

**C. Módulos, num condomínio piloto:**
1. `/admin` › Detalhes › Módulos: ligar `visitors` e `concierge` com justificativa.
2. Conferir que só o piloto ganhou os menus "Central da portaria", "Visitantes" e, para o morador, "Visitas".
3. No outro condomínio, conferir que nada mudou.

**D. Visitantes:**
1. Como morador, criar um convite.
2. Como porteiro, conferir o código e confirmar a entrada.
3. Repetir o mesmo QR: deve ser negado.
4. Registrar uma entrada manual com "quem autorizou".
5. Registrar a saída.

**E. Desligar e religar:** desligar `visitors` no piloto. Os menus somem, mas os dados continuam e a saída ainda pode ser registrada.

**F. Gateway:** não homologar em produção nesta fase. O simulador só roda em ambiente local.
