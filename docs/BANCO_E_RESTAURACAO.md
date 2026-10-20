# Banco e restauração

## O que foi reconstruído

Cadeia SQL canônica para um projeto Supabase novo: identidade, vínculos por tenant, unidades alfanuméricas, operação de encomendas, filas, faturamento, RLS, Storage e funções transacionais. Aplicada apenas em Postgres PGlite em memória com schemas Auth/Storage mínimos de teste. **Nenhum banco remoto foi reconstruído.**

## Histórico

Existem backups locais parciais descritos em `DIAGNOSTICO_LEGADO.md`. **Nenhum registro histórico foi recuperado/importado.** O seed de dois condomínios é fictício. Não contém senha padrão nem recria credenciais legadas.

## Novo projeto

Aplicar as migrations canônicas ordenadas em ambiente isolado. Guardar o histórico do mecanismo de migrations. Testar com usuários autenticados comuns antes de configurar dados reais. O shim `tests/db/supabase-shim.sql` é somente teste: nunca aplicar no Supabase.

## Ambiente existente

Não existe caminho incremental legado→SaaS homologado nesta entrega. NÃO aplicar migrations novas sobre tabelas antigas homônimas. Criar novo projeto, realizar backup íntegro do anterior, mapear IDs legados para UUIDs e validar vínculos por condomínio antes de importar. Importador histórico permanece pendente; não há recuperação automática segura por bloco/apartamento.

## Backup e restore

`scripts/backup-prime.mjs` exporta tabelas paginadas, arquivos das migrations, inventário Auth e objetos Storage; criptografa AES-256-GCM com checksum externo. `scripts/verify-backup.mjs` verifica integridade offline. Ainda não foram executados contra o Supabase real.

Limitações: migrações exportadas não equivalem a dump do schema vivo; alterações fora delas precisam de `pg_dump`. Paginação não constitui snapshot transacional: suspender escritas ou usar snapshot Postgres coordenado. Inventário Auth não contém hashes/senhas/sessões; recuperação exige exportação Auth suportada pelo provedor ou recriação/mapeamento deliberado e reset de acesso. A implementação mantém arquivo em memória, exigindo espaço suficiente.

Ensaio de restauração completo **pendente**. Não anunciar backup restaurável até restaurar em projeto isolado, comparar contagens/checksums, verificar FKs/RLS e baixar amostras de objetos autorizadas. Scripts legados não devem ser utilizados como substituto desse procedimento.

## Rollback

Não executar reset/drop no projeto existente. Para implantação futura, preservar o projeto anterior e um backup validado; realizar migração em destino separado. Reverter versão do aplicativo e apontamento somente após validar compatibilidade de schema e integridade, sem apagar transações novas.
