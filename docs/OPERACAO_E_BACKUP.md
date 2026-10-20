# Operação e backup

## Job periódico

`/api/jobs/tick` (Bearer `CRON_SECRET`): lembretes do teste, pedidos pós-teste e renovação, `past_due`, reprocessa eventos de pagamento e envia a fila de avisos com retry (1, 4, 16, 64 min; máx. 5 tentativas). Idempotente e seguro em paralelo.

Agendamento em duas camadas (plano Hobby da Vercel só permite cron diário):

- `vercel.json`: 1×/dia às 09:17 UTC (06:17 em Brasília) — garantia mínima.
- `.github/workflows/tick.yml`: a cada ~10 min via GitHub Actions. Exige os secrets `APP_URL` e `CRON_SECRET` no repositório; sem eles o job só avisa e termina. O GitHub pode atrasar execuções agendadas e desativa workflows agendados após 60 dias sem atividade no repositório.
- Com dois repositórios, configure os secrets em **apenas um**, para não dobrar as chamadas (o job é idempotente, mas não há motivo para chamadas extras).
- No plano Pro, dá para voltar o `vercel.json` para `*/10 * * * *` e desligar o workflow.

Atraso do job não libera acesso: vencimento é decidido por data no banco. O que atrasa são avisos e geração de pedidos.

Monitorar: `notification_jobs` com `failed`, `payment_events` em `received/error`, `billing_incidents` abertos (painel `/admin`).

## Backup

```
BACKUP_PASSPHRASE=... node --env-file=.env scripts/backup-prime.mjs --output <pasta fora do repositório>
BACKUP_PASSPHRASE=... node scripts/verify-backup.mjs <arquivo>.encrypted.json
```

- Guardar cópia externa criptografada (a senha fica em cofre separado do arquivo).
- Retenção sugerida: diária 7 dias, semanal 4 semanas, mensal 12 meses — ajustar à política jurídica.
- Agendar fora do horário de pico; alerta em caso de saída ≠ 0.
- Nunca salvar backup no Git (`backups/` está no `.gitignore`).

Limitações e restore: ver `BANCO_E_RESTAURACAO.md`. **Restore ainda não ensaiado.**

## Incidentes

- Suspender condomínio por segurança: `/admin` (justificativa auditada). Bloqueia equipe, moradores e totem na próxima requisição.
- Revogar totem/pessoa: Configurações / Unidades e pessoas.
- Pagamento divergente: fica em `review` + `billing_incidents`; resolver manualmente, nunca reativar por SQL sem registrar.
