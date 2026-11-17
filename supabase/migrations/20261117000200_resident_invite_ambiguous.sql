-- =============================================================================
-- Ajuste da 20261117000100: tempo esgotado DEPOIS de entregar à Evolution ("ambiguous: ...") vira falha final sem
-- reenvio, mas a mensagem quase sempre chegou. Invalidar o link nesse caso deixava o morador com um link que não abre.
-- Agora a falha ambígua mantém o convite valendo (continua "Convite na fila"; o plano não reconvida até vencer).
-- Aditiva: só substitui a função do gatilho existente (mesma assinatura).
-- =============================================================================

create or replace function app.resident_invite_job_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_final boolean := new.status = 'failed' and new.attempts >= 5 and coalesce(new.last_error, '') !~* '^ambiguous';
begin
  if new.status in ('accepted', 'delivered', 'disabled') or v_final then new.payload := new.payload - 'token'; end if;
  if new.status in ('accepted', 'delivered') then
    update public.resident_import_entries set status = case new.channel when 'email' then 'sent_email' else 'sent_whatsapp' end,
           last_error = null, updated_at = now()
     where tenant_id = new.tenant_id and id::text = split_part(new.ref_id, ':', 1)
       and invite_count::text = split_part(new.ref_id, ':', 2) and status = 'queued';
  elsif new.status = 'disabled' or v_final then
    -- O mesmo convite também saiu (ou ainda vai sair) por outro canal: o link continua valendo.
    if not exists (select 1 from public.notification_jobs o where o.tenant_id = new.tenant_id and o.event = 'resident_invite'
                    and o.ref_id = new.ref_id and o.id <> new.id
                    and (o.status in ('queued', 'sending', 'accepted', 'delivered') or (o.status = 'failed' and o.attempts < 5))) then
      update public.resident_import_entries set status = 'pending', token_hash = null, token_expires_at = null,
             last_error = left(coalesce(new.last_error, 'Envio cancelado'), 200), updated_at = now()
       where tenant_id = new.tenant_id and id::text = split_part(new.ref_id, ':', 1)
         and invite_count::text = split_part(new.ref_id, ':', 2) and status = 'queued';
    end if;
  end if;
  return new;
end $$;
