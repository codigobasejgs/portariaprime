-- Histórico de envios aos moradores (WhatsApp, e-mail e aplicativo) para o síndico comprovar o envio.
-- Só leitura sobre o outbox que já existe; nenhum dado é alterado. Avisos internos da equipe/síndico,
-- cobrança e alertas operacionais ficam fora (não são mensagens ao morador).
create index if not exists notification_attempts_job_idx on public.notification_attempts (job_id, created_at);
create index if not exists notification_jobs_tenant_created_idx on public.notification_jobs (tenant_id, created_at desc, id desc);

-- Filtros: from/to (data local do condomínio), block, unit, channel, status (sent|failed|pending|not_sent), search (nome/contato).
create function public.notification_log(p_tenant uuid, p_filters jsonb default '{}'::jsonb, p_limit int default 100,
  p_cursor_at timestamptz default null, p_cursor_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); k text; tz text; v jsonb;
begin
  perform app.require(app.is_admin(p_tenant) and (app.has_perm(p_tenant, 'approve') or app.has_perm(p_tenant, 'team')),
    'Somente quem aprova moradores ou gerencia a equipe acessa o histórico de envios.');
  if jsonb_typeof(f) <> 'object' then raise exception 'Filtros inválidos.' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(f) loop
    if k not in ('from', 'to', 'block', 'unit', 'channel', 'status', 'search') or length(coalesce(f->>k, '')) > 80 then
      raise exception 'Filtro inválido: %.', k using errcode = '22023';
    end if;
  end loop;
  if nullif(f->>'channel', '') is not null and f->>'channel' not in ('whatsapp', 'email', 'push') then raise exception 'Canal inválido.' using errcode = '22023'; end if;
  if nullif(f->>'status', '') is not null and f->>'status' not in ('sent', 'failed', 'pending', 'not_sent') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  begin perform (f->>'unit')::uuid, (f->>'from')::date, (f->>'to')::date;
  exception when others then raise exception 'Filtro de data ou unidade inválido.' using errcode = '22023'; end;
  select timezone into tz from public.tenants where id = p_tenant;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id desc), '[]'::jsonb) into v from (
    select j.id, j.created_at, j.event, j.channel, j.status, j.attempts, j.last_error,
           case when j.channel = 'push' then null else j.recipient end recipient,
           (select min(a.created_at) from public.notification_attempts a where a.job_id = j.id and a.ok) sent_at,
           (select max(a.created_at) from public.notification_attempts a where a.job_id = j.id) last_attempt_at,
           (select a.provider_ref from public.notification_attempts a where a.job_id = j.id and a.ok order by a.created_at limit 1) provider_ref,
           u.id unit_id, u.block unit_block, u.label unit_label, pk.carrier, pk.tracking_code,
           coalesce(rc.name, ar.full_name, ie.full_name, pf.full_name) person
      from public.notification_jobs j
      left join public.packages pk on pk.tenant_id = j.tenant_id
            and pk.id = case when j.payload->>'package_id' ~ '^[0-9a-f-]{36}$' then (j.payload->>'package_id')::uuid end
      left join public.access_requests ar on j.event in ('access_received', 'access_decision')
            and ar.tenant_id = j.tenant_id and ar.id::text = j.ref_id
      left join public.resident_import_entries ie on j.event = 'resident_invite'
            and ie.tenant_id = j.tenant_id and ie.id::text = split_part(j.ref_id, ':', 1)
      left join public.units u on u.tenant_id = j.tenant_id and u.id = coalesce(pk.unit_id, ar.unit_id, ie.unit_id)
      left join lateral (select c.name from public.resident_contacts c
                          where c.tenant_id = j.tenant_id and (c.phone = j.recipient or c.email = j.recipient or c.user_id::text = j.recipient)
                          order by (c.unit_id = u.id) desc nulls last, c.active desc, c.created_at desc limit 1) rc on true
      left join public.profiles pf on j.channel = 'push' and pf.id::text = j.recipient
     where j.tenant_id = p_tenant
       and j.event in ('package_received', 'package_picked_up', 'package_reminder', 'access_received', 'access_decision', 'resident_invite')
       and (nullif(f->>'from', '') is null or j.created_at >= ((f->>'from')::date::timestamp at time zone tz))
       and (nullif(f->>'to', '') is null or j.created_at < (((f->>'to')::date + 1)::timestamp at time zone tz))
       and (nullif(f->>'channel', '') is null or j.channel = f->>'channel')
       and (nullif(f->>'status', '') is null
            or (f->>'status' = 'sent' and j.status in ('accepted', 'delivered'))
            or (f->>'status' = 'failed' and j.status = 'failed')
            or (f->>'status' = 'pending' and j.status in ('queued', 'sending'))
            or (f->>'status' = 'not_sent' and j.status = 'disabled'))
       and (nullif(f->>'unit', '') is null or u.id = (f->>'unit')::uuid)
       and (nullif(f->>'block', '') is null or upper(btrim(coalesce(u.block, ''))) = upper(btrim(f->>'block')))
       and (nullif(f->>'search', '') is null or concat_ws(' ', rc.name, ar.full_name, ie.full_name, pf.full_name, case when j.channel <> 'push' then j.recipient end)
            ilike '%' || replace(replace(f->>'search', '%', '\%'), '_', '\_') || '%')
       and (p_cursor_at is null or (j.created_at, j.id) < (p_cursor_at, p_cursor_id))
     order by j.created_at desc, j.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 1000)) x;
  return v;
end $$;

revoke all on function public.notification_log(uuid, jsonb, int, timestamptz, uuid) from public, anon;
grant execute on function public.notification_log(uuid, jsonb, int, timestamptz, uuid) to authenticated;
