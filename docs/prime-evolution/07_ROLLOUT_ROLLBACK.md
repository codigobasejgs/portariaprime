# 07 · Rollout e rollback

**Nada desta evolução foi aplicado em produção nem publicado.** O código está na branch local `feat/prime-modular-portaria`. Aplicar migrations e fazer deploy exige aprovação explícita do proprietário, conforme o prompt.

## Ordem segura de publicação (quando aprovado)

1. **Ensaio com rollback em produção** (`tests/evidence/tmp/rehearse-*.mjs`, mesmo padrão das migrations anteriores):
   - aplicar `20261118000100` e `20261118000200` dentro de `begin … rollback`;
   - conferir permissões (anon/authenticated sem EXECUTE nas funções de service_role, sem SELECT nas colunas de hash);
   - conferir que `receive_and_store` e `deliver_package` continuam compilando com o gatilho novo.
2. **Aplicar** com `prod-apply-1106.mjs`:
   - backup das funções e das linhas das tabelas tocadas;
   - comparação de contagens antes e depois (tenants, packages, receipts, memberships…);
   - varredura de segurança.
3. **Deploy do front e da API.** Com a migration aplicada antes do deploy:
   - o front novo funciona;
   - o front antigo ignora as tabelas novas.

   Com o front publicado antes da migration, `tenant_modules` falha e o front cai para "só Encomendas" (fallback testado no código).
4. **Piloto:** ligar `visitors` e `concierge` só no condomínio piloto, com justificativa. Os demais não veem nada novo.
5. **Gateway:**
   - só com o simulador, fora da rede do cliente;
   - o hardware real é P2, com o instalador presente.

## Compatibilidade com o que existe

- **Encomendas:** nenhuma RPC, tabela ou coluna de encomendas foi alterada. O gatilho `packages_domain_events` é `AFTER` e só grava no banco (sem chamada externa).
- **IDs, retiradas, assinaturas, comprovantes e histórico:** permanecem. O teste `prime-modular.test.mjs` recebe, faz a baixa e confere `status` e `idempotency_key` intactos.
- **Menus e rotas antigas:** iguais. Itens novos aparecem só com módulo ligado.
- **`platform_context`:** a capacidade nova é encadeada na definição vigente (não sobrescreve `devices`/`devices_release`, como confirma o teste `mdm`).

## Rollback

| Situação | Ação | Efeito |
|---|---|---|
| Problema num condomínio | desligar o módulo no `/admin` | menus somem, RPCs e RLS negam, dados preservados |
| Problema geral nos módulos | desligar para todos: `update tenant_module_entitlements set enabled = false` via service_role, com registro no log | idem |
| Gatilho de eventos afetando encomendas (não esperado) | `alter table packages disable trigger packages_domain_events` | encomendas seguem; eventos param; reativar depois |
| Reverter o front | redeploy do commit anterior na Vercel | o banco novo é compatível com o front antigo |
| Reverter o banco | **não recomendado** (aditivo). Se exigido: drop das tabelas novas e do gatilho, após backup | sem impacto em encomendas |

Nunca usar `reset`, `drop` de tabela existente, `truncate` nem reseed.
