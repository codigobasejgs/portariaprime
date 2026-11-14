-- =============================================================================
-- Portaria Prime IA — mais ações pelo WhatsApp. Estritamente aditiva:
--  * assistant_pending ganha ações novas (CHECK ampliado, nada removido) e params maiores (planilha).
--  * assistant_read / assistant_propose / assistant_confirm são redefinidas com TODOS os ramos anteriores
--    idênticos (copiados de 20261113000100) mais os novos. Mesma assinatura e mesmas permissões.
--
-- Regras (as mesmas do painel, porque cada execução chama a RPC do painel COMO a conta vinculada):
--  * Escrita continua: proposta com resumo (10 min) -> ✅ -> executa uma vez -> audit_logs 'Portaria Prime IA (WhatsApp)'.
--  * Lote: até 20 encomendas por confirmação (reenviar aviso / devolver). Cada item roda na RPC do painel;
--    falha de um item não desfaz os outros e o resultado lista quantos deram certo.
--  * Planilha: a validação roda no servidor (mesmo parser do painel); aqui só grava o pré-cadastro (resident_import_save).
--  * Convites: resident_invite_send (permissão 'approve', mesmo teto do painel).
--  * Nível: leituras = basic; ações = intermediate; foto, áudio e planilha = advanced.
-- =============================================================================

alter table public.assistant_pending drop constraint assistant_pending_action_check;
alter table public.assistant_pending add constraint assistant_pending_action_check check (action in (
  'approve_resident', 'reject_resident', 'destinate_package', 'return_package', 'keyword_used', 'receive_package', 'register_courier',
  'mark_unidentified', 'move_package', 'resend_notice', 'cancel_package', 'keyword_create', 'keyword_cancel',
  'invite_residents', 'import_residents', 'bulk_resend', 'bulk_return'));

/** Aviso manual ao morador: um por encomenda a cada 30 min (evita spam por clique repetido). */
create table public.assistant_resends (
  package_id uuid primary key,
  tenant_id uuid not null,
  n int not null default 0,
  last_at timestamptz not null,
  foreign key (tenant_id, package_id) references public.packages (tenant_id, id) on delete cascade
);
alter table public.assistant_resends enable row level security;
revoke all on public.assistant_resends from public, anon, authenticated;

/** Reenvia o aviso de encomenda aguardando retirada (mesma regra de destinatário do lembrete automático). */
create or replace function app.assistant_resend(p_tenant uuid, p_package uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.packages; v_n int;
begin
  perform app.require(app.is_staff(p_tenant));
  select * into v from public.packages where tenant_id = p_tenant and id = p_package;
  if not found or not app.occupies_space(v.status) then raise exception 'Encomenda não aguarda retirada.' using errcode = 'P0001'; end if;
  insert into public.assistant_resends as r (tenant_id, package_id, n, last_at) values (p_tenant, v.id, 1, app.now())
  on conflict (package_id) do update set n = r.n + 1, last_at = app.now() where r.last_at <= app.now() - interval '30 minutes'
  returning n into v_n;
  if v_n is null then raise exception 'Aviso desta encomenda já reenviado há menos de 30 minutos.' using errcode = 'P0001'; end if;
  -- ref '<pacote>:<n>' com n a partir de 50 (lembretes automáticos usam 1..10): não colide nem conta no limite deles.
  return jsonb_build_object('jobs', app.enqueue_package_notifications_ref(v, 'package_reminder', v.id::text || ':' || (49 + least(v_n, 50))::text));
end $$;
revoke all on function app.assistant_resend(uuid, uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Leituras (ramos anteriores idênticos + 'find_packages', 'unit_residents', 'storage', 'invite_preview')
-- -----------------------------------------------------------------------------
create or replace function public.assistant_read(p_link uuid, p_kind text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.assistant_links; v_tz text; v_from date; v_to date; v_days int; r jsonb; v_today date; v_q text;
begin
  l := app.assistant_as(p_link, 'basic');
  select timezone into v_tz from public.tenants where id = l.tenant_id;
  v_today := (app.now() at time zone v_tz)::date;
  if p_kind = 'today' then
    return jsonb_build_object(
      'waiting', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status)),
      'overdue_7d', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.received_at <= app.now() - interval '7 days'),
      'overdue_72h', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.received_at <= app.now() - interval '72 hours'),
      'rejected', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.rejected_at is not null),
      'unidentified', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and app.occupies_space(p.status) and p.unidentified_reason is not null),
      'received_today', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and (p.received_at at time zone v_tz)::date = v_today and p.status <> 'PRE_REGISTRADA'),
      'picked_today', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and (p.picked_up_at at time zone v_tz)::date = v_today),
      'access_requests', public.access_requests_pending_count(l.tenant_id),
      'keywords', jsonb_array_length(public.list_delivery_keywords(l.tenant_id, null)),
      'oldest', coalesce((select jsonb_agg(x) from (select jsonb_build_object('ref', app.package_ref(p.id), 'unit', concat_ws(' ', u.block, u.label),
          'carrier', p.carrier, 'recipient', p.recipient_name, 'days', floor(extract(epoch from app.now() - p.received_at) / 86400)::int) x
        from public.packages p left join public.units u on u.id = p.unit_id
        where p.tenant_id = l.tenant_id and app.occupies_space(p.status) order by p.received_at limit 5) s), '[]'::jsonb));
  elsif p_kind = 'pending_by_unit' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('ref', app.package_ref(p.id), 'unit', concat_ws(' ', u.block, u.label),
        'carrier', p.carrier, 'recipient', p.recipient_name, 'storage', sl.code,
        'days', floor(extract(epoch from app.now() - p.received_at) / 86400)::int, 'rejected', p.rejected_at is not null) x
      from public.packages p join public.units u on u.id = p.unit_id left join public.storage_locations sl on sl.id = p.storage_location_id
      where p.tenant_id = l.tenant_id and app.occupies_space(p.status)
        and (nullif(p_args->>'block', '') is null or app.norm_block(u.block) = app.norm_block(p_args->>'block'))
        and (nullif(p_args->>'unit', '') is null or app.norm_unit(u.label) = app.norm_unit(p_args->>'unit'))
      order by p.received_at limit 15) s), '[]'::jsonb);
  elsif p_kind = 'access_requests' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', e->>'id', 'name', e->>'full_name', 'unit', concat_ws(' ', e->>'block_text', e->>'unit_text'),
        'unit_id', e->>'unit_id', 'relation', e->>'relation') x
      from jsonb_array_elements(public.list_access_requests(l.tenant_id, 'pending')) e limit 10) s), '[]'::jsonb);
  elsif p_kind = 'unidentified' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', e->>'id', 'ref', app.package_ref((e->>'id')::uuid),
        'unit', concat_ws(' ', e->>'unit_block', e->>'unit_label'), 'carrier', e->>'carrier', 'recipient', e->>'recipient_name') x
      from jsonb_array_elements(public.list_unidentified_packages(l.tenant_id)) e limit 10) s), '[]'::jsonb);
  elsif p_kind = 'keywords' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', e->>'id', 'keyword', e->>'keyword',
        'unit', concat_ws(' ', e->>'unit_block', e->>'unit_label'), 'carrier', e->>'carrier') x
      from jsonb_array_elements(public.list_delivery_keywords(l.tenant_id, null)) e limit 10) s), '[]'::jsonb);
  elsif p_kind = 'report' then
    v_days := case p_args->>'period' when 'today' then 0 when 'month' then 29 when '3m' then 89 when '6m' then 179 when 'year' then 364 end;
    if v_days is null then raise exception 'Período inválido.' using errcode = '22023'; end if;
    v_to := v_today; v_from := v_today - v_days;
    r := public.dashboard_executive(l.tenant_id, v_from, v_to, '{}'::jsonb);
    return jsonb_build_object('from', v_from, 'to', v_to, 'received', r->'received'->'value', 'delivered', r->'delivered'->'value',
      'pending_now', r->'pending_now', 'overdue_now', r->'overdue_now', 'avg_pickup_h', r->'pickup_time'->'avg_h',
      'carriers', r->'carriers', 'occupancy', (public.dashboard_operation(l.tenant_id, 72))->'occupancy',
      'rejected', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and p.rejected_at is not null
        and (p.received_at at time zone v_tz)::date between v_from and v_to),
      'unidentified', (select count(*) from public.packages p where p.tenant_id = l.tenant_id and p.unidentified_reason is not null
        and (p.received_at at time zone v_tz)::date between v_from and v_to),
      'porters', coalesce((select jsonb_agg(x order by (x->>'n')::int desc) from (select jsonb_build_object('name', coalesce(p.received_by_name, 'Sem nome'), 'n', count(*)) x
        from public.packages p where p.tenant_id = l.tenant_id and p.status <> 'PRE_REGISTRADA' and (p.received_at at time zone v_tz)::date between v_from and v_to
        group by coalesce(p.received_by_name, 'Sem nome') order by count(*) desc limit 5) s), '[]'::jsonb),
      'couriers', (select count(distinct coalesce(p.courier_id::text, lower(btrim(p.courier_name)))) from public.packages p
        where p.tenant_id = l.tenant_id and p.courier_name is not null and (p.received_at at time zone v_tz)::date between v_from and v_to));
  elsif p_kind = 'unit_lookup' then
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', u.id, 'unit', concat_ws(' ', u.block, u.label),
        'residents', public.unit_residents_for_staff(l.tenant_id, u.id)) x
      from public.units u where u.tenant_id = l.tenant_id and u.active
        and (nullif(p_args->>'block', '') is null or app.norm_block(u.block) = app.norm_block(p_args->>'block'))
        and app.norm_unit(u.label) = app.norm_unit(p_args->>'unit')
      order by u.block nulls first, u.label limit 5) s), '[]'::jsonb);
  elsif p_kind = 'match_label' then
    return public.match_recipient(l.tenant_id, p_args->>'name', p_args->>'block', p_args->>'unit');
  elsif p_kind = 'consume_ocr' then
    return to_jsonb(public.consume_ocr(l.tenant_id));
  -- ---------------------------------------------------------------- novas
  elsif p_kind = 'find_packages' then
    -- Busca nas que aguardam retirada: referência (#A1B2C3), rastreio, destinatário ou "atrasadas" (dias mínimos).
    perform app.require(app.is_staff(l.tenant_id));
    v_q := nullif(btrim(coalesce(p_args->>'q', '')), '');
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', p.id, 'ref', app.package_ref(p.id), 'unit', concat_ws(' ', u.block, u.label),
        'carrier', p.carrier, 'recipient', p.recipient_name, 'tracking', p.tracking_code, 'storage', sl.code, 'storage_id', p.storage_location_id,
        'days', floor(extract(epoch from app.now() - p.received_at) / 86400)::int, 'rejected', p.rejected_at is not null,
        'unidentified', p.unidentified_reason is not null) x
      from public.packages p left join public.units u on u.id = p.unit_id left join public.storage_locations sl on sl.id = p.storage_location_id
      where p.tenant_id = l.tenant_id and app.occupies_space(p.status)
        and (nullif(p_args->>'id', '') is null or p.id::text = p_args->>'id')
        and (v_q is null
          or app.package_ref(p.id) = upper(regexp_replace(v_q, '^#', ''))
          or upper(coalesce(p.tracking_code, '')) = upper(v_q)
          or (length(v_q) >= 3 and p.recipient_name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%'))
        and (nullif(p_args->>'min_days', '') is null or p.received_at <= app.now() - make_interval(days => least(greatest((p_args->>'min_days')::int, 0), 365)))
        and (nullif(p_args->>'block', '') is null or app.norm_block(u.block) = app.norm_block(p_args->>'block'))
      order by p.received_at limit 20) s), '[]'::jsonb);
  elsif p_kind = 'unit_residents' then
    -- Quem mora na unidade (nome e situação; sem telefone/e-mail, como na portaria).
    return coalesce((select jsonb_agg(x) from (select jsonb_build_object('unit', concat_ws(' ', u.block, u.label),
        'residents', public.unit_residents_for_staff(l.tenant_id, u.id)) x
      from public.units u where u.tenant_id = l.tenant_id and u.active
        and (nullif(p_args->>'block', '') is null or app.norm_block(u.block) = app.norm_block(p_args->>'block'))
        and app.norm_unit(u.label) = app.norm_unit(p_args->>'unit')
      order by u.block nulls first, u.label limit 3) s), '[]'::jsonb);
  elsif p_kind = 'storage' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', e->>'id', 'name', concat_ws(' › ', e->>'concierge', e->>'rack', e->>'shelf', case when e->>'rack' is null then e->>'code' end),
        'free', (e->>'free')::int, 'capacity', (e->>'capacity')::int))
      from jsonb_array_elements(coalesce(public.storage_availability(l.tenant_id), '[]'::jsonb)) e), '[]'::jsonb);
  elsif p_kind = 'invite_preview' then
    return public.resident_invite_preview(l.tenant_id, 'whatsapp', 100);
  elsif p_kind = 'units' then
    -- Unidades ativas para validar planilha no servidor (sem moradores).
    perform app.require(app.has_perm(l.tenant_id, 'approve'), 'Somente quem aprova cadastros pode importar moradores.');
    return coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'block', u.block, 'label', u.label, 'active', u.active))
      from public.units u where u.tenant_id = l.tenant_id), '[]'::jsonb);
  end if;
  raise exception 'Consulta desconhecida.' using errcode = '22023';
end $$;

/** Nível mínimo por ação. Leitura = basic; ações = intermediate; foto e planilha = advanced. */
create or replace function app.assistant_action_level(p_action text) returns text
language sql immutable set search_path = '' as $$
  select case when p_action in ('receive_package', 'register_courier', 'import_residents') then 'advanced' else 'intermediate' end
$$;

/** Cria a ação pendente (10 min). Só uma pendente por número: a nova substitui a anterior. Planilha cabe em params (até 400 KB). */
create or replace function public.assistant_propose(p_link uuid, p_action text, p_params jsonb, p_summary text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.assistant_links; p public.assistant_pending;
  v_max int := case when p_action = 'import_residents' then 400000 else 4000 end;
begin
  l := app.assistant_as(p_link, app.assistant_action_level(p_action));
  if p_params is null or jsonb_typeof(p_params) <> 'object' or length(p_params::text) > v_max then
    raise exception 'Dados da ação inválidos.' using errcode = '22023';
  end if;
  if p_action in ('bulk_resend', 'bulk_return') and (jsonb_typeof(p_params->'package_ids') <> 'array'
      or jsonb_array_length(p_params->'package_ids') not between 1 and 20) then
    raise exception 'Lote de 1 a 20 encomendas por confirmação.' using errcode = '22023';
  end if;
  update public.assistant_pending set status = 'cancelled', decided_at = now() where link_id = l.id and status = 'pending';
  insert into public.assistant_pending (link_id, tenant_id, action, params, summary, expires_at)
  values (l.id, l.tenant_id, p_action, p_params, left(coalesce(p_summary, ''), 1500), app.now() + interval '10 minutes')
  returning * into p;
  return jsonb_build_object('id', p.id, 'expires_at', p.expires_at);
end $$;

/**
 * Executa a ação confirmada, uma única vez, como a conta vinculada. Ramos anteriores idênticos; novos chamam as RPCs do painel.
 * Lote: cada item numa subtransação (falha de um não desfaz os outros); resultado com ok/falhas.
 */
create or replace function public.assistant_confirm(p_link uuid, p_pending uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.assistant_pending; l public.assistant_links; r jsonb; a jsonb; v_msg text; v_id text; v_ok int := 0; v_fail jsonb := '[]'::jsonb;
begin
  select * into p from public.assistant_pending where id = p_pending and link_id = p_link for update;
  if not found then raise exception 'Ação não encontrada.' using errcode = 'P0002'; end if;
  if p.status = 'done' then return jsonb_build_object('status', 'done', 'replayed', true, 'result', p.result); end if;
  if p.status <> 'pending' then return jsonb_build_object('status', p.status); end if;
  if p.expires_at <= app.now() then
    update public.assistant_pending set status = 'expired', decided_at = now() where id = p.id;
    return jsonb_build_object('status', 'expired');
  end if;
  l := app.assistant_as(p_link, app.assistant_action_level(p.action));
  a := p.params;
  if p.action in ('approve_resident', 'reject_resident') and not exists (
      select 1 from public.access_requests where id = nullif(a->>'request_id', '')::uuid and tenant_id = l.tenant_id) then
    update public.assistant_pending set status = 'failed', decided_at = now(), result = jsonb_build_object('error', 'Cadastro não encontrado neste condomínio.') where id = p.id;
    return jsonb_build_object('status', 'failed', 'error', 'Cadastro não encontrado neste condomínio.');
  end if;
  begin
    if p.action = 'approve_resident' then
      r := public.decide_access_request((a->>'request_id')::uuid, true, nullif(a->>'unit_id', '')::uuid, null);
    elsif p.action = 'reject_resident' then
      r := public.decide_access_request((a->>'request_id')::uuid, false, null, a->>'reason');
    elsif p.action = 'destinate_package' then
      r := public.package_destinate(l.tenant_id, (a->>'package_id')::uuid, (a->>'unit_id')::uuid, a->>'recipient', nullif(a->>'resident_user', '')::uuid);
    elsif p.action = 'return_package' then
      r := public.resolve_package(l.tenant_id, (a->>'package_id')::uuid, 'DEVOLVIDA', a->>'reason');
    elsif p.action = 'keyword_used' then
      r := to_jsonb(public.delivery_keyword_mark_used(l.tenant_id, (a->>'keyword_id')::uuid));
    elsif p.action = 'receive_package' then
      r := public.receive_and_store(l.tenant_id, 'wa-' || p.id::text, (a->>'unit_id')::uuid, nullif(a->>'tracking', ''), coalesce(nullif(a->>'carrier', ''), 'Outra'),
        nullif(a->>'recipient', ''), 'Registrada pelo assistente no WhatsApp.', nullif(a->>'storage_location_id', '')::uuid, null,
        coalesce(nullif(a->>'courier', ''), 'Informado no WhatsApp'), coalesce(nullif(a->>'received_by', ''), 'Assistente WhatsApp'));
    elsif p.action = 'register_courier' then
      r := public.courier_upsert_from_ocr(l.tenant_id, a->>'full_name', nullif(a->>'cpf', ''), nullif(a->>'cnh', ''), nullif(a->>'category', ''), nullif(a->>'carrier', ''));
    -- ---------------------------------------------------------------- novas (todas pelas RPCs do painel)
    elsif p.action = 'mark_unidentified' then
      r := public.package_mark_unidentified(l.tenant_id, (a->>'package_id')::uuid, coalesce(nullif(a->>'reason', ''), 'incomplete_or_unknown_name'));
    elsif p.action = 'move_package' then
      r := public.move_package(l.tenant_id, (a->>'package_id')::uuid, (a->>'storage_location_id')::uuid, 'Movida pelo assistente no WhatsApp.');
    elsif p.action = 'resend_notice' then
      r := app.assistant_resend(l.tenant_id, (a->>'package_id')::uuid);
    elsif p.action = 'cancel_package' then
      r := public.resolve_package(l.tenant_id, (a->>'package_id')::uuid, a->>'status', a->>'reason');
    elsif p.action = 'keyword_create' then
      -- Equipe cria em nome da unidade (o painel do morador exige ser morador; aqui a regra é ser da equipe do condomínio).
      perform app.require(app.is_staff(l.tenant_id));
      if not exists (select 1 from public.units where tenant_id = l.tenant_id and id = (a->>'unit_id')::uuid and active) then
        raise exception 'Unidade não encontrada.' using errcode = 'P0002';
      end if;
      if length(btrim(coalesce(a->>'keyword', ''))) not between 2 and 60 then raise exception 'Palavra-chave deve ter de 2 a 60 caracteres.' using errcode = '22023'; end if;
      insert into public.delivery_keywords (tenant_id, unit_id, created_by, keyword, carrier, recipient_name, note)
      values (l.tenant_id, (a->>'unit_id')::uuid, l.user_id, btrim(a->>'keyword'), nullif(btrim(coalesce(a->>'carrier', '')), ''),
        nullif(btrim(coalesce(a->>'recipient', '')), ''), 'Cadastrada pelo assistente no WhatsApp.')
      returning jsonb_build_object('id', id, 'keyword', keyword) into r;
      perform app.audit(l.tenant_id, 'delivery_keyword.created', 'delivery_keyword', r->>'id', jsonb_build_object('unit_id', a->>'unit_id', 'via', 'whatsapp'));
    elsif p.action = 'keyword_cancel' then
      r := public.delivery_keyword_cancel(l.tenant_id, (a->>'keyword_id')::uuid);
    elsif p.action = 'invite_residents' then
      r := public.resident_invite_send(l.tenant_id, 'whatsapp', least(greatest(coalesce((a->>'limit')::int, 100), 1), 300), 20);
    elsif p.action = 'import_residents' then
      r := public.resident_import_save(l.tenant_id, a->'rows', coalesce(a->'stats', '{}'::jsonb));
    elsif p.action in ('bulk_resend', 'bulk_return') then
      for v_id in select jsonb_array_elements_text(a->'package_ids') limit 20 loop
        begin
          if p.action = 'bulk_resend' then perform app.assistant_resend(l.tenant_id, v_id::uuid);
          else perform public.resolve_package(l.tenant_id, v_id::uuid, 'DEVOLVIDA', a->>'reason'); end if;
          v_ok := v_ok + 1;
        exception when others then
          get stacked diagnostics v_msg = message_text;
          v_fail := v_fail || jsonb_build_object('ref', app.package_ref(v_id::uuid), 'error', left(v_msg, 120));
        end;
      end loop;
      r := jsonb_build_object('ok', v_ok, 'failed', v_fail);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    update public.assistant_pending set status = 'failed', decided_at = now(), result = jsonb_build_object('error', left(v_msg, 300)) where id = p.id;
    return jsonb_build_object('status', 'failed', 'error', left(v_msg, 300));
  end;
  -- Planilha: não guarda nomes/telefones depois de executar (só contagens).
  update public.assistant_pending set status = 'done', decided_at = now(), result = coalesce(r, '{}'::jsonb),
    params = case when p.action = 'import_residents' then jsonb_build_object('redacted', true, 'stats', a->'stats') else params end
   where id = p.id;
  insert into public.audit_logs (tenant_id, actor_id, action, target_type, target_id, data)
  values (l.tenant_id, l.user_id, 'assistant.' || p.action, 'assistant_pending', p.id::text,
    jsonb_build_object('via', 'Portaria Prime IA (WhatsApp)', 'phone_last4', right(l.phone, 4), 'level', l.level, 'summary', left(p.summary, 400)));
  return jsonb_build_object('status', 'done', 'result', coalesce(r, '{}'::jsonb));
end $$;

-- Mesmas permissões das versões anteriores (create or replace preserva, reafirmado aqui).
revoke all on function public.assistant_read(uuid, text, jsonb), public.assistant_propose(uuid, text, jsonb, text),
  public.assistant_confirm(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assistant_read(uuid, text, jsonb), public.assistant_propose(uuid, text, jsonb, text),
  public.assistant_confirm(uuid, uuid) to service_role;
