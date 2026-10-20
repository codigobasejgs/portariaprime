# Diagnóstico do legado

Inspeção local em 19/10/2026. React 19, TypeScript, Vite, Tailwind e Supabase preservados.

## Alterações preexistentes

`index.html` continha um protótipo React com autenticação simulada e senhas fixas; foi preservado em `docs/legado/prototipo-portaria-prime-index.jsx`, fora do aplicativo e sem execução. O HTML de entrada foi reconstruído. Logos originais preservados em `design/brand/`; material antigo em `docs/legado/`. Nenhum reset de banco ou force push.

## Divergências SQL

- Cadeia anterior iniciava com políticas públicas e `staff_accounts` com senhas próprias.
- Schema posterior usava Auth/RLS, mas mantinha papel global em `profiles`, unidade numérica e unicidade global.
- Migrações de múltiplos moradores duplicavam alterações; uma continha atualização nominal de morador.
- Operações e políticas não possuíam tenant; bucket e serviço divergiam entre privacidade e URL pública.
- Cadeia antiga preservada em `supabase/legacy/`, fora das migrations executáveis. Não aplicar em sequência com a cadeia canônica nova.

## Recuperação: evidência real

Ao contrário da análise do ZIP, a pasta local **contém backups parciais** ignorados pelo Git:

- `backups/2026-09-02T18-11-46/`: 1 unidade, 2 contas legadas de equipe, 2 logs; arquivos de encomendas e notificações vazios.
- Snapshot pré-exclusão em `backups/`: 1 unidade, 1 encomenda e 1 perfil.

Foram inspecionadas contagens e estrutura, sem copiar dados pessoais para esta documentação. Não foi importado nenhum registro. Hashes de senha legados não devem ser usados para autenticação nova. Inventário parcial não comprova integridade nem recuperação completa. Acesso ao projeto Supabase antigo expirou por timeout na tentativa somente leitura; não é prova de exclusão definitiva.

## Material de marca

Dez PNGs oficiais e `identidade-visual.png` encontrados e inspecionados. Não foram encontrados SVGs novos, `GUIA_IDENTIDADE.md` ou `tokens.css` do kit. Tokens foram transcritos da identidade fornecida, sem redesenhar o símbolo. O ZIP interno permanece separado; não substituiu o projeto nem foi tratado como dump.

## Preservado

Câmera/leitura QR, assinatura desenhada, geração de QR real, instalação PWA e feedback sonoro foram reaproveitados. Componentes e serviços legados restantes não participam do novo grafo principal de rotas; remoção/revisão final ainda pendente. Não se deve considerar identidade global integralmente auditada enquanto esses resíduos existirem.
