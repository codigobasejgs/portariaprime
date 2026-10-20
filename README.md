# Portaria Prime

Gestão de encomendas para condomínios — multi-condomínio, com portaria, morador, totem, painel do síndico e assinatura com mês grátis.

```
npm ci
npm run typecheck
npm test          # banco (PGlite) + contratos de API
npm run build
npm run dev       # só interface; APIs exigem `npm run dev:full` (vercel dev)
```

Configuração: `.env.example`. Implantação: `docs/DEPLOY.md`. Situação real: `docs/IMPLEMENTACAO_STATUS.md` e `docs/QA_RESULTADOS.md`.
