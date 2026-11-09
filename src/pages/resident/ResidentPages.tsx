import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BellRing, ChevronRight, Filter, Inbox, Search, X } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useRealtime, useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { navigate, onLink, query } from '../../lib/router';
import { dateTime, unitName } from '../../lib/format';
import { Alert, Button, Field, Input, Modal, Select, Spinner } from '../../components/ui';
import { PackagePhotos } from '../../components/PhotoGallery';
import { Notif, useNotifications } from '../../components/NotificationBell';
import { useResident } from './ResidentShell';
import { ExceptionNote, HistoryItem, KeywordCard, pkgTitle, QrSheet, ReceiptActions, RejectButton, RejectedNote, ResidentPackage, StatusBadge, WAITING, WaitingCard } from './parts';

interface Home {
  name: string | null; waiting: ResidentPackage[]; recent: ResidentPackage[]; unread: number;
  channels: { push_devices: number; whatsapp: boolean; email: boolean; push_enabled: boolean };
}

const firstName = (n: string | null) => (n ? n.trim().split(/\s+/)[0] : null);
const greeting = (tz: string) => {
  const h = Number(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }));
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
};

/** Início: o que chegou e como retirar. Falha de consulta nunca vira "nada aguardando". */
export function InicioPage() {
  const t = useTenant();
  const r = useResident();
  const [d, setD] = useState<Home | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<ResidentPackage | null>(null);
  const load = useCallback(async () => {
    try { setD(await rpc('resident_home', { p_tenant: t.tenant.id, p_unit: r.unit })); setError(null); }
    catch (e: any) { setError(e.message); }
  }, [t.tenant.id, r.unit]);
  useEffect(() => { setD(null); void load(); }, [load]);
  useRealtime('packages', t.tenant.id, load);
  useRefreshWhileVisible(load);

  if (error && !d) return <div className="space-y-3"><Alert tone="danger">Não conseguimos verificar suas encomendas agora. Isso não significa que não há nada para retirar.</Alert><Button onClick={load}>Tentar novamente</Button></div>;
  if (!d) return <Spinner label="Verificando suas encomendas…" />;
  const n = d.waiting.length;
  const notified = d.channels.push_devices > 0 || d.channels.whatsapp || d.channels.email;
  const nm = firstName(r.name);
  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted">{greeting(t.tenant.timezone)}{nm ? `, ${nm}` : ''}</p>
        <h1 className="text-2xl font-semibold mt-0.5" data-tour="morador-aguardando">
          {n === 0 ? 'Nenhuma encomenda aguardando retirada' : n === 1 ? 'Você tem 1 encomenda para retirar' : `Você tem ${n} encomendas para retirar`}
        </h1>
      </div>
      {error && <Alert tone="warning">Não foi possível atualizar agora. Mostrando a última consulta.</Alert>}

      {n > 0 ? (
        <ul className="space-y-3" aria-label="Encomendas para retirar">
          {d.waiting.map((p) => <WaitingCard key={p.id} p={p} multiUnit={r.units.length > 1 && !r.unit} onQr={() => setQr(p)} onChange={load} />)}
        </ul>
      ) : (
        <div className="rounded-2xl border border-line bg-surface p-4 flex gap-3 items-start">
          <Inbox className="w-6 h-6 text-muted shrink-0" aria-hidden />
          <div className="text-sm space-y-1">
            <p className="font-medium">Suas próximas encomendas aparecerão aqui.</p>
            {notified ? <p className="text-muted">Quando algo chegar, avisamos por {[d.channels.push_devices > 0 && 'notificação neste aparelho', d.channels.whatsapp && 'WhatsApp', d.channels.email && 'e-mail'].filter(Boolean).join(', ')}.</p>
              : <p className="text-muted">Você ainda não tem um canal de aviso ativo. <a href={`${r.base}/conta#notificacoes`} onClick={onLink} className="underline text-text">Configurar notificações</a></p>}
          </div>
        </div>
      )}

      {n > 0 && !notified && (
        <a href={`${r.base}/conta#notificacoes`} onClick={onLink} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3 text-sm">
          <BellRing className="w-5 h-5 shrink-0" aria-hidden /><span className="flex-1">Quer ser avisado quando chegar algo? Configure as notificações.</span><ChevronRight className="w-4 h-4" aria-hidden />
        </a>
      )}

      <KeywordCard units={r.units} unit={r.unit} />

      <section className="space-y-2" data-tour="morador-historico">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Recentes</h2><a href={`${r.base}/historico`} onClick={onLink} className="text-sm underline min-h-11 inline-flex items-center">Ver histórico</a></div>
        {d.recent.length === 0 ? <p className="text-sm text-muted">Encomendas retiradas aparecem aqui com o comprovante.</p>
          : <ul className="space-y-2">{d.recent.map((p) => <HistoryItem key={p.id} p={p} />)}</ul>}
      </section>
      {qr && <QrSheet p={qr} onClose={() => { setQr(null); void load(); }} />}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = { rejected_by_resident: 'Recusada pelo morador', received: 'Chegou na portaria', stored: 'Guardada pela portaria', picked_up: 'Retirada', devolvida: 'Devolvida ao remetente', cancelada: 'Registro cancelado', extraviada: 'Registrada como extraviada' };

/** Detalhe: resumo, ação principal, linha do tempo real e comprovante. Acesso revalidado no servidor. */
export function EncomendaPage() {
  const t = useTenant();
  const r = useResident();
  const id = query('p');
  const [p, setP] = useState<ResidentPackage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState(false);
  const valid = !!id && /^[0-9a-f-]{36}$/i.test(id);
  const load = useCallback(async () => {
    if (!valid) return;
    try { setP(await rpc('resident_package', { p_tenant: t.tenant.id, p_package: id })); setError(null); } catch (e: any) { setError(e.message); }
  }, [id, valid, t.tenant.id]);
  useEffect(() => { setP(null); void load(); }, [load]);
  useRealtime('packages', t.tenant.id, load);
  useRefreshWhileVisible(load);

  if (!valid || (error && !p)) return (
    <div className="space-y-3"><h1 className="text-2xl font-semibold">Encomenda</h1>
      <Alert tone="warning">{!valid ? 'Link de encomenda inválido.' : 'Esta encomenda não foi encontrada ou não está disponível para o seu cadastro.'}</Alert>
      {valid && <Button variant="secondary" onClick={load}>Tentar novamente</Button>}
      <a href={`${r.base}/inicio`} onClick={onLink} className="underline inline-flex min-h-11 items-center">Voltar ao início</a></div>
  );
  if (!p) return <Spinner />;
  const waiting = WAITING.includes(p.status);
  return (
    <div className="space-y-5">
      <a href={`${r.base}/${waiting ? 'inicio' : 'historico'}`} onClick={onLink} className="text-sm text-muted inline-flex items-center min-h-11">‹ {waiting ? 'Início' : 'Histórico'}</a>
      <div className="rounded-2xl border border-line bg-surface p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h1 className="text-xl font-semibold">{pkgTitle(p)}</h1>{p.tracking_code && <p className="text-sm text-muted break-all">Rastreio {p.tracking_code}</p>}</div>
          <StatusBadge status={p.status} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">Unidade</dt><dd>{unitName(p.unit_block, p.unit_label, t.unitLabels)}</dd>
          {p.recipient_name && <><dt className="text-muted">Para</dt><dd className="break-words">{p.recipient_name}</dd></>}
          {p.concierge_name && <><dt className="text-muted">{waiting ? 'Retirar em' : 'Portaria'}</dt><dd>{p.concierge_name}</dd></>}
          {p.received_by_name && <><dt className="text-muted">Recebida por</dt><dd>{p.received_by_name}</dd></>}
          {p.courier_name && <><dt className="text-muted">Entregador</dt><dd className="break-words">{p.courier_name}</dd></>}
          {p.picked_up_by_name && <><dt className="text-muted">Retirada por</dt><dd>{p.picked_up_by_name}</dd></>}
        </dl>
        <RejectedNote p={p} />
        <div className="flex flex-col sm:flex-row gap-2">
          {waiting && !p.rejected_at && <Button onClick={() => setQr(true)} className="w-full sm:w-auto">Mostrar QR de retirada</Button>}
          <RejectButton p={p} onDone={load} />
        </div>
        <ExceptionNote status={p.status} />
        {p.status === 'RETIRADA' && <ReceiptActions p={p} />}
        <PackagePhotos key={p.id} packageId={p.id} />
      </div>
      <section className="space-y-2">
        <h2 className="font-semibold">Linha do tempo</h2>
        <ol className="relative border-l-2 border-line ml-2 space-y-4 pl-5">
          {(p.timeline || []).map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full bg-secondary ring-4 ring-bg" aria-hidden />
              <p className="font-medium text-sm">{EVENT_LABEL[e.kind] || e.kind}</p>
              <p className="text-xs text-muted">{dateTime(e.at, t.tenant.timezone)}</p>
            </li>
          ))}
          {waiting && <li className="relative"><span className="absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-line bg-surface" aria-hidden /><p className="text-sm text-muted">Aguardando retirada na portaria</p></li>}
        </ol>
        <p className="text-xs text-muted">Mostramos apenas fatos registrados pela portaria. O envio de avisos não significa que a mensagem foi lida.</p>
      </section>
      {qr && <QrSheet p={p} onClose={() => { setQr(false); void load(); }} />}
    </div>
  );
}

const STATUS_FILTERS: [string, string][] = [['', 'Todas'], ['RETIRADA', 'Retiradas'], ['DEVOLVIDA', 'Devolvidas'], ['CANCELADA', 'Canceladas'], ['EXTRAVIADA', 'Extraviadas']];

/** Histórico com busca, filtros (drawer no celular) e carregamento progressivo por cursor. */
export function HistoricoPage() {
  const t = useTenant();
  const r = useResident();
  const [q, setQ] = useState(''); const [debounced, setDebounced] = useState('');
  const [f, setF] = useState({ status: '', from: '', to: '' });
  const [draft, setDraft] = useState(f);
  const [drawer, setDrawer] = useState(false);
  const [rows, setRows] = useState<ResidentPackage[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { const id = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(id); }, [q]);
  const args = useMemo(() => ({ p_tenant: t.tenant.id, p_unit: r.unit, p_search: debounced || null, p_status: f.status || null, p_from: f.from || null, p_to: f.to || null, p_limit: 20 }), [t.tenant.id, r.unit, debounced, f]);
  const load = useCallback(async () => {
    setError(null);
    try { const x = await rpc<ResidentPackage[]>('resident_history', args); setRows(x); setMore(x.length === 20); } catch (e: any) { setError(e.message); }
  }, [args]);
  useEffect(() => { setRows(null); void load(); }, [load]);
  const loadMore = async () => {
    const last = rows![rows!.length - 1];
    setLoadingMore(true);
    try { const x = await rpc<ResidentPackage[]>('resident_history', { ...args, p_cursor_at: last.received_at, p_cursor_id: last.id }); setRows([...rows!, ...x]); setMore(x.length === 20); }
    catch (e: any) { setError(e.message); } finally { setLoadingMore(false); }
  };
  const active = [f.status && STATUS_FILTERS.find(([v]) => v === f.status)?.[1], f.from && `desde ${new Date(`${f.from}T12:00`).toLocaleDateString('pt-BR')}`, f.to && `até ${new Date(`${f.to}T12:00`).toLocaleDateString('pt-BR')}`].filter(Boolean) as string[];
  const clear = () => { const z = { status: '', from: '', to: '' }; setF(z); setDraft(z); };
  const filters = (
    <div className="space-y-3">
      <Field label="Situação"><Select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Chegou de"><Input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
        <Field label="até"><Input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
      </div>
    </div>
  );
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Histórico</h1>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
          <Input aria-label="Pesquisar por transportadora, rastreio ou número" placeholder="Transportadora, rastreio ou nº" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="secondary" onClick={() => { setDraft(f); setDrawer(true); }} aria-label={`Filtros${active.length ? `, ${active.length} ativos` : ''}`}><Filter className="w-4 h-4" aria-hidden /><span className="hidden sm:inline">Filtros</span>{active.length > 0 && <span className="rounded-full bg-primary text-primary-fg text-[11px] px-1.5">{active.length}</span>}</Button>
      </div>
      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {active.map((a) => <span key={a} className="rounded-full bg-surface-2 px-3 py-1">{a}</span>)}
          <button onClick={clear} className="inline-flex items-center gap-1 underline min-h-9"><X className="w-3 h-3" aria-hidden />Limpar</button>
        </div>
      )}
      {error ? <div className="space-y-2"><Alert tone="danger">Não foi possível carregar o histórico. {error}</Alert><Button variant="secondary" onClick={load}>Tentar novamente</Button></div>
        : !rows ? <Spinner />
        : rows.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">{debounced || active.length ? 'Nada encontrado com essa busca ou filtros.' : 'Ainda não há encomendas retiradas ou encerradas.'}</p>
        : <ul className="space-y-2">{rows.map((p) => <HistoryItem key={p.id} p={p} />)}</ul>}
      {more && rows && <Button variant="secondary" className="w-full" onClick={loadMore} loading={loadingMore}>Carregar mais</Button>}
      {drawer && (
        <Modal title="Filtros" onClose={() => setDrawer(false)}>
          {filters}
          <div className="flex gap-2 mt-4"><Button variant="ghost" onClick={() => { clear(); setDrawer(false); }}>Limpar</Button><Button className="flex-1" onClick={() => { setF(draft); setDrawer(false); }}>Aplicar</Button></div>
        </Modal>
      )}
    </div>
  );
}

type RNotif = Notif & { package_status?: string | null };

/** Notificações com ação direta conforme o estado ATUAL da encomenda. */
export function NotificacoesPage() {
  const t = useTenant();
  const r = useResident();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const { data, error, load, markRead } = useNotifications(onlyUnread);
  const [older, setOlder] = useState<RNotif[]>([]);
  const [more, setMore] = useState(true);
  useEffect(() => { setOlder([]); setMore(true); }, [onlyUnread, data]);
  const rows = data ? [...(data.items as RNotif[]), ...older] : null;
  const read = async (id?: string) => { await markRead(id); await r.refreshUnread(); };
  const loadMore = async () => {
    const last = rows![rows!.length - 1];
    const x = await rpc<{ items: RNotif[] }>('my_notifications', { p_tenant: t.tenant.id, p_unread: onlyUnread, p_before: last.created_at, p_limit: 20 });
    setOlder((o) => [...o, ...x.items]); setMore(x.items.length === 20);
  };
  const action = (n: RNotif): [string, string] | null => {
    if (!n.package_id) return n.kind === 'access_decision' ? ['Ver início', `${r.base}/inicio`] : null;
    if (n.package_status === undefined || n.package_status === null) return null; // sem acesso atual: sem link
    if (WAITING.includes(n.package_status)) return ['Ver encomenda e QR', `${r.base}/encomenda?p=${n.package_id}`];
    if (n.package_status === 'RETIRADA') return ['Ver comprovante', `${r.base}/encomenda?p=${n.package_id}`];
    return ['Ver encomenda', `${r.base}/encomenda?p=${n.package_id}`];
  };
  const stateLine = (n: RNotif) => {
    if (!n.package_id) return null;
    if (n.package_status == null) return 'Esta encomenda não está mais disponível para o seu cadastro.';
    if (n.kind === 'package_received' && !WAITING.includes(n.package_status)) return n.package_status === 'RETIRADA' ? 'Situação atual: já foi retirada.' : 'Situação atual: não está mais aguardando retirada.';
    return null;
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Notificações</h1>
        <Button variant="ghost" disabled={!data?.unread} onClick={() => read()}>Marcar todas como lidas</Button>
      </div>
      <div role="radiogroup" aria-label="Filtro" className="inline-flex rounded-xl border border-line bg-surface p-1">
        <button role="radio" aria-checked={!onlyUnread} onClick={() => setOnlyUnread(false)} className={`px-4 min-h-10 rounded-lg text-sm ${!onlyUnread ? 'bg-surface-2 font-semibold' : ''}`}>Todas</button>
        <button role="radio" aria-checked={onlyUnread} onClick={() => setOnlyUnread(true)} className={`px-4 min-h-10 rounded-lg text-sm ${onlyUnread ? 'bg-surface-2 font-semibold' : ''}`}>Não lidas{data?.unread ? ` (${data.unread > 99 ? '99+' : data.unread})` : ''}</button>
      </div>
      {error ? <div className="space-y-2"><Alert tone="danger">Não foi possível carregar as notificações.</Alert><Button variant="secondary" onClick={load}>Tentar novamente</Button></div>
        : !rows ? <Spinner />
        : rows.length === 0 ? <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">{onlyUnread ? 'Tudo lido.' : 'Nenhuma notificação ainda.'}</p>
        : (
          <ul className="space-y-2">
            {rows.map((n) => {
              const a = action(n); const s = stateLine(n);
              return (
                <li key={n.id} className={`rounded-2xl border bg-surface p-4 ${n.read_at ? 'border-line' : 'border-primary/40'}`}>
                  <div className="flex items-start gap-3">
                    <span className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${n.read_at ? 'bg-transparent' : 'bg-primary'}`} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-medium">{n.title}{!n.read_at && <span className="sr-only"> (não lida)</span>}</p>
                      <p className="text-sm text-muted">{n.body}</p>
                      {s && <p className="text-sm">{s}</p>}
                      <p className="text-xs text-muted">{dateTime(n.created_at, t.tenant.timezone)}</p>
                      <div className="flex flex-wrap gap-3 pt-1">
                        {a && <a href={a[1]} onClick={(e) => { if (!n.read_at) void read(n.id); onLink(e); }} className="inline-flex items-center min-h-11 font-semibold underline">{a[0]}</a>}
                        {!n.read_at && <button className="text-sm text-muted underline min-h-11" onClick={() => read(n.id)}>Marcar como lida</button>}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      {rows && rows.length >= 20 && more && <Button variant="secondary" className="w-full" onClick={loadMore}>Carregar mais</Button>}
    </div>
  );
}

/** Link antigo de comprovante (mensagens já enviadas) → detalhe atual da encomenda. */
export function ComprovanteRedirect() {
  const r = useResident();
  const id = query('p');
  useEffect(() => { navigate(id ? `${r.base}/encomenda?p=${encodeURIComponent(id)}` : `${r.base}/historico`, true); }, [id, r.base]);
  return <Spinner />;
}
