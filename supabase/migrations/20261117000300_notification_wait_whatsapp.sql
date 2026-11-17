-- =============================================================================
-- WhatsApp do condomínio desconectado: o aviso espera na fila em vez de gastar tentativa. Antes cada rodada do
-- worker contava falha e em ~1h30 o aviso desistia (5 tentativas): foi o que travou os convites em 11/11 e 17/11.
-- Agora o job volta a "queued" (aparece na fila), sem consumir tentativa, e é revisto a cada 10 min. Depois de
-- 24 h esperando (convite do pré-cadastro: 7 dias; o link vale 30) vira falha final, alertada como antes.
-- Aditiva: coluna nova anulável + função nova (só service_role).
-- =============================================================================

alter table public.notification_jobs add column if not exists waiting_since timestamptz;

create function public.defer_notification_job(p_job uuid, p_error text) returns text
language plpgsql security definer set search_path = '' as $$
declare j public.notification_jobs;
begin
  select * into j from public.notification_jobs where id = p_job and status = 'sending' for update;
  if not found then return 'ignored'; end if;
  if coalesce(j.waiting_since, now()) < now() - (case when j.event = 'resident_invite' then interval '7 days' else interval '24 hours' end) then
    perform public.complete_notification_job(p_job, 'failed', null, p_error, true);
    return 'final';
  end if;
  update public.notification_jobs set status = 'queued', attempts = greatest(attempts - 1, 0), locked_until = null,
         last_error = left(p_error, 500), waiting_since = coalesce(waiting_since, now()),
         next_attempt_at = now() + interval '10 minutes', updated_at = now()
   where id = p_job;
  return 'waiting';
end $$;

revoke all on function public.defer_notification_job(uuid, text) from public, anon, authenticated;
grant execute on function public.defer_notification_job(uuid, text) to service_role;
