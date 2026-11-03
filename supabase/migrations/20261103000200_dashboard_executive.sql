-- =============================================================================
-- Dashboard executivo do síndico (aba Análise). Somente admin do condomínio,
-- somente agregados (exceto listas limitadas: ranking paginado e as 20 mais
-- antigas aguardando). dashboard_analysis continua intacta.
--
-- Base: encomendas do condomínio, exceto PRE_REGISTRADA, com filtros opcionais
-- (p_filters: block, unit, status [situação atual ou PENDENTES], carrier).
-- Período [início, fim+1) no fuso do condomínio; anterior = mesma duração antes.
--
--  Recebidas      : received_at no período.
--  Entregues      : picked_up_at no período (independe de quando chegou).
--  Coorte         : das recebidas no período, quantas já foram retiradas até
--                   agora; taxa = retiradas da coorte / recebidas (0 -> null).
--  Aguardando     : app.occupies_space(status) agora (não depende do período).
--  Atrasadas      : aguardando com received_at <= agora - 72 h. Não há prazo
--                   operacional configurável (reminder_after_hours é só o
--                   lembrete ao morador); 72 h = mesmo limite da aba Operação.
--  Tempo retirada : picked_up_at - received_at das entregues no período (h).
--  Saldo (série)  : recebidas até o fim do intervalo - encerradas até o fim
--                   (retirada em picked_up_at; exceção em resolved_at).
--  Eficiência     : recebimento -> primeiro aviso aceito (notified_at), aviso
--                   -> retirada, % entregues em até 24/48 h. Sem notified_at,
--                   a encomenda fica fora da amostra (nunca inventa horário).
--
-- Índices: (tenant_id, received_at desc) e (tenant_id, picked_up_at) já
-- existem (20261019000200, 20261022000700). Nenhum índice novo.
-- =============================================================================

create or replace function app.dash_packages(p_tenant uuid, p_filters jsonb)
returns table (unit_id uuid, block text, label text, status text, carrier text,
  received_at timestamptz, picked_up_at timestamptz, notified_at timestamptz, closed_at timestamptz)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
declare f jsonb := coalesce(p_filters, '{}'::jsonb); v_status text; v_unit uuid; v_block text; v_carrier text;
begin
  if jsonb_typeof(f) <> 'object' then raise exception 'Filtros inválidos.' using errcode = '22023'; end if;
  v_status := nullif(f->>'status', '');
  v_block := nullif(btrim(f->>'block'), '');
  v_carrier := nullif(f->>'carrier', '');
  if v_status is not null and v_status not in ('RECEBIDA', 'ARMAZENADA', 'RETIRADA', 'CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA', 'PENDENTES') then
    raise exception 'Filtro de situação inválido.' using errcode = '22023';
  end if;
  begin v_unit := nullif(f->>'unit', '')::uuid;
  exception when invalid_text_representation then raise exception 'Filtro de unidade inválido.' using errcode = '22023'; end;
  return query
    select p.unit_id, u.block, u.label, p.status, p.carrier, p.received_at, p.picked_up_at, p.notified_at,
           case when p.status = 'RETIRADA' then p.picked_up_at
                when p.status in ('CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA') then coalesce(p.resolved_at, p.received_at) end
      from public.packages p
      join public.units u on u.tenant_id = p.tenant_id and u.id = p.unit_id
     where p.tenant_id = p_tenant and p.status <> 'PRE_REGISTRADA'
       and (v_unit is null or p.unit_id = v_unit)
       and (v_block is null or upper(btrim(u.block)) = upper(v_block))
       and (v_carrier is null or p.carrier = v_carrier)
       and (v_status is null or (v_status = 'PENDENTES' and app.occupies_space(p.status)) or p.status = v_status);
end $$;

create or replace function app.dash_check_period(p_from date, p_to date) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'Período inválido (máximo de 1 ano).' using errcode = '22023';
  end if;
end $$;

create or replace function public.dashboard_executive(p_tenant uuid, p_from date, p_to date, p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; a timestamptz; b timestamptz; pa timestamptz; v_days int; v_now timestamptz := app.now();
  v_gran text; v_overdue int := 72;
begin
  perform app.require(app.is_admin(p_tenant));
  perform app.dash_check_period(p_from, p_to);
  select timezone into v_tz from public.tenants where id = p_tenant;
  a := p_from::timestamp at time zone v_tz;
  b := (p_to + 1)::timestamp at time zone v_tz;
  v_days := p_to - p_from + 1;
  pa := (p_from - v_days)::timestamp at time zone v_tz;
  v_gran := case when v_days <= 62 then 'day' when v_days <= 190 then 'week' else 'month' end;
  return (
    with x as (
      select d.*, extract(epoch from d.picked_up_at - d.received_at) / 3600 dwell_h,
             extract(epoch from d.notified_at - d.received_at) / 3600 r2n_h,
             extract(epoch from d.picked_up_at - d.notified_at) / 3600 n2p_h,
             (d.received_at >= a and d.received_at < b) as in_cur, (d.received_at >= pa and d.received_at < a) as in_prev,
             coalesce(d.picked_up_at >= a and d.picked_up_at < b, false) as out_cur,
             coalesce(d.picked_up_at >= pa and d.picked_up_at < a, false) as out_prev
        from app.dash_packages(p_tenant, p_filters) d),
    k as (
      select count(*) filter (where in_cur) rc, count(*) filter (where in_prev) rp,
             count(*) filter (where out_cur) dc, count(*) filter (where out_prev) dp,
             count(*) filter (where in_cur and picked_up_at is not null) coh_picked,
             count(*) filter (where in_cur and closed_at is not null and picked_up_at is null) coh_exception,
             count(distinct unit_id) filter (where in_cur or out_cur) uc,
             count(distinct unit_id) filter (where in_prev or out_prev) up,
             count(*) filter (where app.occupies_space(status)) pend,
             count(*) filter (where app.occupies_space(status) and received_at <= v_now - make_interval(hours => v_overdue)) overdue,
             avg(dwell_h) filter (where out_cur) avg_c, avg(dwell_h) filter (where out_prev) avg_p,
             percentile_cont(0.5) within group (order by dwell_h) filter (where out_cur) med_c,
             count(*) filter (where out_cur and dwell_h <= 24) w24, count(*) filter (where out_cur and dwell_h <= 48) w48,
             count(*) filter (where out_prev and dwell_h <= 48) w48p,
             count(*) filter (where in_cur and r2n_h >= 0) r2n_n,
             avg(r2n_h) filter (where in_cur and r2n_h >= 0) r2n_avg,
             percentile_cont(0.5) within group (order by r2n_h) filter (where in_cur and r2n_h >= 0) r2n_med,
             count(*) filter (where out_cur and n2p_h >= 0) n2p_n,
             avg(n2p_h) filter (where out_cur and n2p_h >= 0) n2p_avg,
             percentile_cont(0.5) within group (order by n2p_h) filter (where out_cur and n2p_h >= 0) n2p_med
        from x),
    -- Eventos para a série: +1 ao receber, -1 ao encerrar; antes do período vira saldo de abertura (k = null).
    ev as (
      select received_at t, 1 rin, 0 rout, 1 bal from x
      union all select picked_up_at, 0, 1, 0 from x where picked_up_at is not null
      union all select closed_at, 0, 0, -1 from x where closed_at is not null),
    agg as (
      select case when t < a then null else greatest(date_trunc(v_gran, t at time zone v_tz)::date, p_from) end bk,
             sum(rin) rin, sum(rout) rout, sum(bal) bal
        from ev where t < b group by 1),
    s as (
      select greatest(g::date, p_from) bk,
             least((g + ('1 ' || v_gran)::interval)::date, p_to + 1) - 1 bend
        from generate_series(date_trunc(v_gran, p_from::timestamp), p_to::timestamp, ('1 ' || v_gran)::interval) g),
    series as (
      select s.bk, s.bend, coalesce(g.rin, 0) rin, coalesce(g.rout, 0) rout,
             (select coalesce(sum(o.bal), 0) from agg o where o.bk is null) + sum(coalesce(g.bal, 0)) over (order by s.bk) balance
        from s left join agg g on g.bk = s.bk),
    top5 as (
      select count(*) n, coalesce(sum(r), 0) r from (
        select count(*) r from x where in_cur group by unit_id order by 1 desc limit 5) t)
    select jsonb_build_object(
      'timezone', v_tz, 'from', p_from, 'to', p_to, 'days', v_days, 'as_of', v_now,
      'previous', jsonb_build_object('from', p_from - v_days, 'to', p_from - 1),
      'filters', coalesce(p_filters, '{}'::jsonb), 'granularity', v_gran, 'overdue_hours', v_overdue,
      'received', jsonb_build_object('value', k.rc, 'previous', k.rp, 'change', case when k.rp = 0 then null else round((k.rc - k.rp)::numeric / k.rp, 3) end),
      'delivered', jsonb_build_object('value', k.dc, 'previous', k.dp, 'change', case when k.dp = 0 then null else round((k.dc - k.dp)::numeric / k.dp, 3) end),
      'units_moved', jsonb_build_object('value', k.uc, 'previous', k.up, 'change', case when k.up = 0 then null else round((k.uc - k.up)::numeric / k.up, 3) end),
      'cohort', jsonb_build_object('received', k.rc, 'picked', k.coh_picked, 'exceptions', k.coh_exception,
        'rate', case when k.rc = 0 then null else round(k.coh_picked::numeric / k.rc, 3) end),
      'pending_now', k.pend, 'overdue_now', k.overdue,
      'pickup_time', jsonb_build_object('n', k.dc, 'avg_h', round(k.avg_c::numeric, 1), 'median_h', round(k.med_c::numeric, 1),
        'avg_h_previous', round(k.avg_p::numeric, 1),
        'change', case when coalesce(k.avg_p, 0) = 0 or k.avg_c is null then null else round(((k.avg_c - k.avg_p) / k.avg_p)::numeric, 3) end),
      'efficiency', jsonb_build_object(
        'receipt_to_notice', jsonb_build_object('n', k.r2n_n, 'without_notice', k.rc - k.r2n_n, 'avg_h', round(k.r2n_avg::numeric, 1), 'median_h', round(k.r2n_med::numeric, 1)),
        'notice_to_pickup', jsonb_build_object('n', k.n2p_n, 'avg_h', round(k.n2p_avg::numeric, 1), 'median_h', round(k.n2p_med::numeric, 1)),
        'within_24h', case when k.dc = 0 then null else round(k.w24::numeric / k.dc, 3) end,
        'within_48h', case when k.dc = 0 then null else round(k.w48::numeric / k.dc, 3) end,
        'within_48h_previous', case when k.dp = 0 then null else round(k.w48p::numeric / k.dp, 3) end),
      'series', (select coalesce(jsonb_agg(jsonb_build_object('start', bk, 'end', bend, 'received', rin, 'delivered', rout, 'balance', balance) order by bk), '[]'::jsonb) from series),
      'heatmap', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'hour', hr, 'n', n)), '[]'::jsonb) from (
          select extract(isodow from received_at at time zone v_tz)::int dow, extract(hour from received_at at time zone v_tz)::int hr, count(*) n
            from x where in_cur group by 1, 2) h),
      'aging_now', (select jsonb_build_object(
          'lt24', count(*) filter (where received_at > v_now - interval '24 hours'),
          'h24_48', count(*) filter (where received_at <= v_now - interval '24 hours' and received_at > v_now - interval '48 hours'),
          'h48_72', count(*) filter (where received_at <= v_now - interval '48 hours' and received_at > v_now - interval '72 hours'),
          'gt72', count(*) filter (where received_at <= v_now - interval '72 hours'))
        from x where app.occupies_space(status)),
      'oldest_waiting', (select coalesce(jsonb_agg(jsonb_build_object('block', block, 'unit', label, 'received_at', received_at,
          'hours', round((extract(epoch from v_now - received_at) / 3600)::numeric, 1), 'status', status) order by received_at), '[]'::jsonb)
        from (select * from x where app.occupies_space(status) order by received_at limit 20) o),
      'blocks', (select coalesce(jsonb_agg(jsonb_build_object('block', block, 'received', r, 'pending', p) order by r desc, block), '[]'::jsonb) from (
          select block, count(*) filter (where in_cur) r, count(*) filter (where app.occupies_space(status)) p
            from x where block is not null group by block) bl where r > 0 or p > 0),
      'concentration', jsonb_build_object('top_units', (select n from top5), 'top_received', (select r from top5), 'total_received', k.rc),
      'carriers', (select coalesce(jsonb_agg(jsonb_build_object('carrier', carrier, 'n', n) order by n desc, carrier), '[]'::jsonb) from (
          select carrier, count(*) n from x where in_cur group by 1) c),
      'exceptions', (select coalesce(jsonb_agg(jsonb_build_object('status', status, 'n', n) order by n desc), '[]'::jsonb) from (
          select status, count(*) n from x where status in ('CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA') and closed_at >= a and closed_at < b group by 1) e),
      -- Sem identificação confiável do destinatário (recipient_name vem da etiqueta/OCR, sem vínculo com morador).
      'recipients', jsonb_build_object('available', false, 'reason', 'A encomenda não tem vínculo confiável com o morador destinatário; o nome vem da etiqueta.'),
      -- Contexto do condomínio (não depende dos filtros de encomenda).
      'channels', (select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'state', st, 'n', n)), '[]'::jsonb) from (
          select channel, case when status = 'failed' and attempts >= 5 then 'failed_final' when status = 'failed' then 'failed_retryable'
                               when status in ('queued', 'sending', 'hold') then 'pending' else status end st, count(*) n
            from public.notification_jobs where tenant_id = p_tenant and created_at >= a and created_at < b group by 1, 2) ch),
      'adoption', jsonb_build_object(
          'units_active', (select count(*) from public.units where tenant_id = p_tenant and active),
          'units_with_resident', (select count(distinct um.unit_id) from public.unit_memberships um join public.units u on u.id = um.unit_id and u.active
                                    join public.tenant_memberships m on m.tenant_id = um.tenant_id and m.user_id = um.user_id and m.role = 'morador' and m.status = 'active'
                                   where um.tenant_id = p_tenant and um.status = 'active')),
      -- Opções dos filtros: só valores que existem nas encomendas do condomínio (sem filtros aplicados).
      'options', (with o as (select * from app.dash_packages(p_tenant, '{}'::jsonb)) select jsonb_build_object(
          'blocks', (select coalesce(jsonb_agg(distinct block order by block), '[]'::jsonb) from o where block is not null),
          'units', (select coalesce(jsonb_agg(jsonb_build_object('id', unit_id, 'block', block, 'label', label) order by block nulls first, label), '[]'::jsonb)
                      from (select distinct unit_id, block, label from o) u),
          'statuses', (select coalesce(jsonb_agg(distinct status order by status), '[]'::jsonb) from o),
          'carriers', (select coalesce(jsonb_agg(distinct carrier order by carrier), '[]'::jsonb) from o))))
      from k);
end $$;

-- Ranking de unidades, paginado (p_limit 1..200). Ordem: recebidas, entregues, pendentes, bloco, unidade.
-- Entra a unidade com recebida ou entregue no período, ou aguardando agora.
create or replace function public.dashboard_unit_ranking(p_tenant uuid, p_from date, p_to date, p_filters jsonb default '{}'::jsonb,
  p_limit int default 10, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; a timestamptz; b timestamptz; pa timestamptz; v_days int;
  v_lim int := least(greatest(coalesce(p_limit, 10), 1), 200); v_off int := greatest(coalesce(p_offset, 0), 0);
begin
  perform app.require(app.is_admin(p_tenant));
  perform app.dash_check_period(p_from, p_to);
  select timezone into v_tz from public.tenants where id = p_tenant;
  a := p_from::timestamp at time zone v_tz;
  b := (p_to + 1)::timestamp at time zone v_tz;
  v_days := p_to - p_from + 1;
  pa := (p_from - v_days)::timestamp at time zone v_tz;
  return (
    with r as (
      select d.unit_id, max(d.block) block, max(d.label) label,
             count(*) filter (where d.received_at >= a and d.received_at < b) rc,
             count(*) filter (where d.received_at >= pa and d.received_at < a) rp,
             count(*) filter (where d.picked_up_at >= a and d.picked_up_at < b) dc,
             count(*) filter (where app.occupies_space(d.status)) pend,
             avg(extract(epoch from d.picked_up_at - d.received_at) / 3600) filter (where d.picked_up_at >= a and d.picked_up_at < b) avg_h
        from app.dash_packages(p_tenant, p_filters) d group by d.unit_id),
    f as (select * from r where rc > 0 or dc > 0 or pend > 0),
    tot as (select coalesce(sum(rc), 0) t, count(*) n from f)
    select jsonb_build_object('total', tot.n, 'received_total', tot.t, 'limit', v_lim, 'offset', v_off,
      'items', coalesce((select jsonb_agg(jsonb_build_object('unit_id', z.unit_id, 'block', z.block, 'unit', z.label,
          'received', z.rc, 'delivered', z.dc, 'pending', z.pend, 'received_previous', z.rp,
          'share', case when tot.t = 0 then null else round(z.rc::numeric / tot.t, 4) end,
          'change', case when z.rp = 0 then null else round((z.rc - z.rp)::numeric / z.rp, 3) end,
          'avg_pickup_h', round(z.avg_h::numeric, 1)) order by z.ord)
        from (select f.*, row_number() over (order by f.rc desc, f.dc desc, f.pend desc, f.block nulls first, f.label) ord
                from f order by ord limit v_lim offset v_off) z), '[]'::jsonb))
      from tot);
end $$;

revoke all on function app.dash_packages(uuid, jsonb), app.dash_check_period(date, date) from public, anon, authenticated;
revoke all on function public.dashboard_executive(uuid, date, date, jsonb), public.dashboard_unit_ranking(uuid, date, date, jsonb, int, int) from public, anon;
grant execute on function public.dashboard_executive(uuid, date, date, jsonb), public.dashboard_unit_ranking(uuid, date, date, jsonb, int, int) to authenticated, service_role;
