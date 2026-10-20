# Auditoria de identidade

Data: 20/10/2026. Busca: `village|azaleia|VA-|#0D3823|#D4AF37|#D81B60|Cinzel` fora de `node_modules`, `dist`, `.git`.

## Aplicado

- Logos oficiais do kit (`design/brand/`, PNG) redimensionados sem redesenho para `public/brand/`: horizontal claro/escuro, vertical, símbolo.
- Ícones PWA, favicon e apple-touch gerados a partir de `10-icone-app-azul.png` (fundo azul de borda a borda).
- Manifest, `<title>`, `theme-color`, e-mails, WhatsApp, comprovante, login, onboarding, shell, totem, ajuda: Portaria Prime + marca do condomínio.
- Tokens em `design/tokens.css` (cores do guia) e tema semântico claro/escuro em `src/index.css`. Champagne só como destaque/ícone, não texto pequeno em fundo claro.
- Código legado com marca antiga removido do aplicativo (31 arquivos fora do grafo de rotas, preservados no histórico Git).

## Ocorrências remanescentes justificadas

| Local | Motivo |
|---|---|
| `supabase/legacy/*` | histórico das migrations antigas, fora da cadeia executável |
| `docs/legado/*` | material histórico do cliente anterior |
| `supabase/migrations/20261019000100_base_tenancy.sql` (comentário) | referência histórica à cadeia antiga |
| `PROMPT_MESTRE_PORTARIA_PRIME.md` | especificação do proprietário |
| `backups/` (fora do Git) | dados do condomínio anterior; não alterar |

## Pendências

- Kit não trouxe SVG nem `GUIA_IDENTIDADE.md`; telas usam PNG. Substituir por SVG quando o arquivo vetorial existir.
- Tipografia: guia cita sans-serif legível sem nomear fonte; usada pilha do sistema (Inter quando disponível). Confirmar com o proprietário.
- Cache do PWA antigo: `cleanupOutdatedCaches` remove precache anterior no próximo service worker; ícone já instalado no celular pode manter aparência antiga até reinstalar.
