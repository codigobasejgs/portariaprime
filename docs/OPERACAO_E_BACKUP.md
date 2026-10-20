# Operação e backup

## Job periódico

`/api/jobs/tick` (Bearer `CRON_SECRET`): lembretes do teste, pedidos pós-teste e renovação, `past_due`, reprocessa eventos de pagamento e envia a fila de avisos com retry (1, 4, 16, 64 min; máx. 5 tentativas). Idempotente e seguro em paralelo.

`vercel.json` agenda a cada 10 min. **Plano Hobby da Vercel só permite cron diário** — em Hobby, use agendador externo (ex.: GitHub Actions/cron do servidor) chamando `POST /api/jobs/tick`. Atraso do job não libera acesso: vencimento é decidido por data no banco.

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
