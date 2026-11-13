import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, FileText, MoreVertical, PackageCheck, PackagePlus, Tablet, Undo2 } from 'lucide-react';
import { navigate, query } from '../../../lib/router';
import { useRealtime, useTenant } from '../../../lib/tenant';
import { rpc } from '../../../lib/api';
import { dateTime, STATUS_LABEL, unitName } from '../../../lib/format';
import { listPackages, loadStorage, loadUnits, PackageRow, StorageLoc, UnitRow } from '../../../lib/packages';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast } from '../../../components/ui';
import { ReceiveForm } from './ReceiveForm';
import { PickupModal, type PickupStart } from './PickupFlow';
import { ReceiptModal } from '../Receipt';

/**
 * Tela inicial da portaria: duas ações grandes (Receber, Entregar) que abrem o passo a passo em pop-up,
 * e embaixo só a lista do que aguarda retirada. Histórico fica numa aba à parte.
 * `totem` = balcão da equipe logada: mesmos fluxos, botões maiores, sem histórico.
 */
export function PortariaPage({ totem = false }: { totem?: boolean }) {
  const t = useTenant();
  const [view, setView] = useState<'aguardando' | 'historico'>('aguardando');
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [storage, setStorage] = useState<StorageLoc[]>([]);
  const [pending, setPending] = useState<PackageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receive, setReceive] = useState(() => query('aba') === 'receber');
  const [pickup, setPickup] = useState<PickupStart | null>(() => (query('aba') === 'entregar' ? {} : null));
  const [receipt, setReceipt] = useState<string | null>(null);
  const [confirmPre, setConfirmPre] = useState<PackageRow | null>(null);
  const [actions, setActions] = useState<PackageRow | null>(null);
  const [move, setMove] = useState<PackageRow | null>(null);
  const [resolve, setResolve] = useState<PackageRow | null>(null);
  const [search, setSearch] = useState('');
  const [flags, setFlags] = useState<Record<string, PackageFlag>>({});

  const refresh = useCallback(async () => {
    try {
      setPending(await listPackages(t.tenant.id, { status: 'PENDENTES', limit: 300 }));
      const f = await rpc<PackageFlag[]>('staff_package_flags', { p_tenant: t.tenant.id }).catch(() => []);
      setFlags(Object.fromEntries(f.map((x) => [x.id, x])));
    } catch (e: any) {
      setError(e.message);
    }
  }, [t.tenant.id]);

  useEffect(() => {
    Promise.all([loadUnits(t.tenant.id), loadStorage(t.tenant.id)])
      .then(([u, s]) => { setUnits(u); setStorage(s); })
      .catch((e) => setError(e.message));
    refresh();
  }, [t.tenant.id, refresh]);
  useRealtime('packages', t.tenant.id, refresh);

  const pre = (pending || []).filter((p) => p.status === 'PRE_REGISTRADA');
  const waiting = (pending || []).filter((p) => p.status !== 'PRE_REGISTRADA');
  const q = search.trim().toLowerCase();
  // Recusadas pelo morador primeiro (precisam de devolução).
  const filtered = (q ? waiting.filter((p) => `${p.unit_block || ''} ${p.unit_label || ''} ${p.tracking_code || ''} ${p.recipient_name || ''}`.toLowerCase().includes(q)) : waiting)
    .slice().sort((a, b) => Number(!!flags[b.id]?.rejected_at) - Number(!!flags[a.id]?.rejected_at));
  const noUnits = units?.length === 0;
  const big = `${totem ? 'min-h-24 text-xl' : 'min-h-16 text-base'} rounded-2xl font-semibold flex items-center justify-center gap-2`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{totem ? 'Totem da portaria' : 'Encomendas'}</h1>
        {totem ? <Button variant="ghost" onClick={() => navigate(`/c/${t.tenant.slug}/portaria`)}>Voltar às encomendas</Button>
          : <Button variant="ghost" onClick={() => navigate(`/c/${t.tenant.slug}/totem-equipe`)}><Tablet className="w-4 h-4" /> Abrir totem</Button>}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {noUnits && <Alert tone="warning">Nenhuma unidade cadastrada ainda. O administrador cadastra em “Unidades e moradores”.</Alert>}
      <div className="grid grid-cols-2 gap-3" data-tour="portaria-abas">
        <button type="button" disabled={!units || noUnits} onClick={() => setReceive(true)} className={`${big} bg-primary text-primary-fg disabled:opacity-50`}>
          <PackagePlus className="w-6 h-6 shrink-0" aria-hidden /> Receber encomenda
        </button>
        <button type="button" onClick={() => setPickup({})} className={`${big} bg-surface border border-line`}>
          <PackageCheck className="w-6 h-6 shrink-0" aria-hidden /> Entregar ao morador
        </button>
      </div>

      {!totem && pre.length > 0 && (
        <Card className="space-y-2">
          <p className="font-semibold">Deixadas no totem — confira antes de avisar ({pre.length})</p>
          {pre.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
              <span className="text-sm">{p.carrier} · {p.tracking_code || 'sem rastreio'} · {p.unit_label ? unitName(p.unit_block, p.unit_label, t.unitLabels) : 'unidade não informada'} · {p.courier_name || ''}</span>
              <Button variant="secondary" onClick={() => setConfirmPre(p)}>Conferir</Button>
            </div>
          ))}
        </Card>
      )}

      {!totem && (
        <div className="flex gap-1 border-b border-line" role="tablist" aria-label="Listas de encomendas">
          {([['aguardando', `Aguardando retirada (${waiting.length})`], ['historico', 'Histórico']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)} data-tour={id === 'historico' ? 'historico-busca' : undefined}
              className={`min-h-11 px-3 text-sm font-semibold border-b-2 -mb-px ${view === id ? 'border-primary text-text' : 'border-transparent text-muted'}`}>{label}</button>
          ))}
        </div>
      )}

      {view === 'aguardando' && (
        <Card className="space-y-3" data-tour="aguardando-lista">
          {totem && <p className="font-semibold">Aguardando retirada ({waiting.length})</p>}
          <Input aria-label="Buscar por unidade, rastreio ou nome" placeholder="Buscar por unidade, rastreio ou nome" value={search} onChange={(e) => setSearch(e.target.value)} />
          {!pending ? <Spinner /> : filtered.length === 0 ? <Empty title="Nada aguardando retirada" /> : (
            <ul className="divide-y divide-line">
              {filtered.map((p) => { const f = flags[p.id]; return (
                <li key={p.id} className={`py-3 flex items-center justify-between gap-2 ${f?.rejected_at ? 'border-l-4 border-danger bg-danger-bg pl-3 -ml-1 rounded-r-lg' : ''}`}>
                  <div className="min-w-0">
                    <p className="font-medium">{unitName(p.unit_block, p.unit_label, t.unitLabels)} <span className="text-muted font-normal">· {p.carrier}</span>
                      {f?.unidentified_reason && <> <Badge tone="warning">Morador não identificado</Badge></>}</p>
                    {f?.rejected_at && <p className="text-sm font-semibold text-danger">🚫 Recusada pelo morador: {REJECTION_TEXT[f.rejection_reason || 'other']}{f.rejection_note ? ` — ${f.rejection_note}` : ''}.</p>}
                    <p className="text-xs text-muted break-words">{[p.recipient_name, p.tracking_code || 'sem rastreio', dateTime(p.received_at, t.tenant.timezone), p.storage_code].filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {f?.rejected_at ? <Button variant="danger" onClick={() => setResolve(p)}><Undo2 className="w-4 h-4" /> Devolver</Button>
                      : <Button variant="secondary" onClick={() => setPickup({ pkg: p })}>Entregar</Button>}
                    <Button variant="ghost" className="px-2" aria-label={`Mais ações de ${unitName(p.unit_block, p.unit_label, t.unitLabels)}`} onClick={() => setActions(p)}><MoreVertical className="w-5 h-5" /></Button>
                  </div>
                </li>
              ); })}
            </ul>
          )}
        </Card>
      )}
      {view === 'aguardando' && <KeywordsCard />}
      {view === 'historico' && <HistorySearch onReceipt={setReceipt} />}

      {receive && units && !noUnits && <ReceiveForm units={units} storage={storage} onDone={refresh} onClose={() => setReceive(false)} />}
      {confirmPre && units && <ReceiveForm units={units} storage={storage} preregistered={confirmPre} onDone={refresh} onClose={() => setConfirmPre(null)} />}
      {pickup && <PickupModal start={pickup} waiting={waiting.filter((p) => !flags[p.id]?.rejected_at)} onClose={() => setPickup(null)} onDone={refresh} onReceipt={setReceipt} />}
      {receipt && <ReceiptModal packageId={receipt} onClose={() => setReceipt(null)} />}
      {actions && (
        <Modal title={`${unitName(actions.unit_block, actions.unit_label, t.unitLabels)} · ${actions.carrier}`} onClose={() => setActions(null)}>
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {actions.received_by_name && <>Recebido por {actions.received_by_name}. </>}{actions.courier_name && <>Entregador: {actions.courier_name}. </>}{actions.notified_at ? 'Moradores avisados.' : 'Aviso ainda não enviado.'}
            </p>
            {storage.length > 0 && <Button variant="secondary" className="w-full" onClick={() => { setMove(actions); setActions(null); }}><ArrowRightLeft className="w-4 h-4" /> Mover de local</Button>}
            <Button variant="secondary" className="w-full" onClick={() => { setResolve(actions); setActions(null); }}>Registrar exceção (devolução, extravio…)</Button>
          </div>
        </Modal>
      )}
      {move && <MoveModal pkg={move} storage={storage} onClose={() => setMove(null)} onDone={() => { setMove(null); refresh(); }} />}
      {resolve && <ResolveModal pkg={resolve} initialReason={flags[resolve.id]?.rejected_at ? `Recusada pelo morador: ${REJECTION_TEXT[flags[resolve.id].rejection_reason || 'other']}${flags[resolve.id].rejection_note ? ` — ${flags[resolve.id].rejection_note}` : ''}`.slice(0, 300) : ''}
        onClose={() => setResolve(null)} onDone={() => { setResolve(null); refresh(); }} />}
    </div>
  );
}

interface PackageFlag { id: string; rejected_at: string | null; rejection_reason: string | null; rejection_note: string | null; unidentified_reason: string | null }
export const REJECTION_TEXT: Record<string, string> = { wrong_unit: 'não é desta unidade', cancelled: 'compra cancelada', other: 'outro motivo' };
interface KeywordRow { id: string; keyword: string; carrier: string | null; recipient_name: string | null; note: string | null; valid_until: string | null; expires_at: string | null;
  unit_block: string | null; unit_label: string; created_by_name: string | null }

/** Palavras-chave ativas informadas pelos moradores (RLS/RPC: só equipe do condomínio e a própria unidade). */
function KeywordsCard() {
  const t = useTenant();
  const [rows, setRows] = useState<KeywordRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => rpc<KeywordRow[]>('list_delivery_keywords', { p_tenant: t.tenant.id }).then(setRows).catch(() => setRows([])), [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  const use = async (k: KeywordRow) => {
    setBusy(k.id);
    try { await rpc('delivery_keyword_mark_used', { p_tenant: t.tenant.id, p_id: k.id }); toast.success('Palavra-chave marcada como utilizada.'); load(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  if (!rows || rows.length === 0) return null;
  return (
    <Card className="space-y-2" role="region" aria-label="Palavras-chave dos moradores">
      <p className="font-semibold">🔑 Palavras-chave dos moradores ({rows.length})</p>
      <ul className="divide-y divide-line">
        {rows.map((k) => (
          <li key={k.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 text-sm">
              <p><strong>{unitName(k.unit_block, k.unit_label, t.unitLabels)}</strong>{k.created_by_name ? ` · ${k.created_by_name}` : ''}{k.carrier ? ` · ${k.carrier}` : ''}</p>
              <p className="text-xl font-bold tracking-wide text-secondary">{k.keyword}</p>
              {(k.recipient_name || k.note || k.valid_until || k.expires_at) && <p className="text-xs text-muted">{[k.recipient_name && `Para ${k.recipient_name}`, k.note,
                k.expires_at ? `até ${dateTime(k.expires_at, t.tenant.timezone)}` : k.valid_until && `até ${k.valid_until.split('-').reverse().join('/')}`].filter(Boolean).join(' · ')}</p>}
            </div>
            <Button variant="secondary" loading={busy === k.id} onClick={() => use(k)}>Marcar como utilizada</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HistorySearch({ onReceipt }: { onReceipt: (id: string) => void }) {
  const t = useTenant();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PackageRow[] | null>(null);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    try { setRows(await listPackages(t.tenant.id, { search: q, limit: 50 })); } catch (err: any) { toast.error(err.message); }
  };
  return (
    <Card className="space-y-3" data-tour="historico-busca">
      <form onSubmit={run} className="flex gap-2 items-end">
        <div className="flex-1"><Field label="Histórico completo"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rastreio, unidade ou nome" /></Field></div>
        <Button type="submit" variant="secondary">Buscar</Button>
      </form>
      {rows && (rows.length === 0 ? <Empty title="Nada encontrado" /> : (
        <ul className="divide-y divide-line">
          {rows.map((p) => (
            <li key={p.id} className="py-2 flex flex-wrap justify-between gap-2 text-sm">
              <span>{unitName(p.unit_block, p.unit_label, t.unitLabels)} · {p.carrier} · {p.tracking_code || '—'} · {dateTime(p.received_at, t.tenant.timezone)}</span>
              <span className="flex items-center gap-2">
                <Badge tone={p.status === 'RETIRADA' ? 'success' : ['CANCELADA', 'DEVOLVIDA', 'EXTRAVIADA'].includes(p.status) ? 'danger' : 'warning'}>{STATUS_LABEL[p.status]}</Badge>
                {p.status === 'RETIRADA' && <button className="text-secondary underline inline-flex items-center gap-1" onClick={() => onReceipt(p.id)}><FileText className="w-3 h-3" />Comprovante</button>}
              </span>
            </li>
          ))}
        </ul>
      ))}
    </Card>
  );
}

function MoveModal({ pkg, storage, onClose, onDone }: { pkg: PackageRow; storage: StorageLoc[]; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await rpc('move_package', { p_tenant: t.tenant.id, p_package: pkg.id, p_storage_location: to, p_reason: null });
      toast.success('Encomenda movida.');
      onDone();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Mover encomenda" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Novo local"><Select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Selecione…</option>{storage.filter((s) => s.id !== pkg.storage_location_id).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</Select></Field>
        <Button disabled={!to} loading={busy} onClick={go} className="w-full">Mover</Button>
      </div>
    </Modal>
  );
}

function ResolveModal({ pkg, initialReason = '', onClose, onDone }: { pkg: PackageRow; initialReason?: string; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [status, setStatus] = useState('DEVOLVIDA');
  const [reason, setReason] = useState(initialReason);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await rpc('resolve_package', { p_tenant: t.tenant.id, p_package: pkg.id, p_status: status, p_reason: reason });
      toast.success('Exceção registrada.');
      onDone();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Registrar exceção" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Situação">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="DEVOLVIDA">Devolvida ao remetente/transportadora</option>
            {t.link.role === 'admin' && <option value="CANCELADA">Cancelada (registro indevido)</option>}
            {t.link.role === 'admin' && <option value="EXTRAVIADA">Extraviada</option>}
          </Select>
        </Field>
        <Field label="Motivo" hint="Mínimo de 10 caracteres. Fica no histórico."><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        <Button loading={busy} onClick={go} disabled={reason.trim().length < 10} className="w-full">Registrar</Button>
      </div>
    </Modal>
  );
}
