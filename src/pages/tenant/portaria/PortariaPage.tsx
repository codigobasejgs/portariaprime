import React, { useCallback, useEffect, useState } from 'react';
import { ArrowRightLeft, FileText, PackageCheck, PackagePlus, Search } from 'lucide-react';
import { useRealtime, useTenant } from '../../../lib/tenant';
import { rpc } from '../../../lib/api';
import { dateTime, STATUS_LABEL, unitName } from '../../../lib/format';
import { listPackages, loadStorage, loadUnits, PackageRow, StorageLoc, UnitRow } from '../../../lib/packages';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast } from '../../../components/ui';
import { ReceiveForm } from './ReceiveForm';
import { PickupModal, ScanToPickup } from './PickupFlow';
import { ReceiptModal } from '../Receipt';

type Tab = 'receber' | 'entregar' | 'buscar';

export function PortariaPage() {
  const t = useTenant();
  const [tab, setTab] = useState<Tab>('receber');
  const [units, setUnits] = useState<UnitRow[] | null>(null);
  const [storage, setStorage] = useState<StorageLoc[]>([]);
  const [pending, setPending] = useState<PackageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickup, setPickup] = useState<{ pkg: PackageRow; qr: string | null } | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [confirmPre, setConfirmPre] = useState<PackageRow | null>(null);
  const [move, setMove] = useState<PackageRow | null>(null);
  const [resolve, setResolve] = useState<PackageRow | null>(null);
  const [search, setSearch] = useState('');

  const refresh = useCallback(async () => {
    try {
      setPending(await listPackages(t.tenant.id, { status: 'PENDENTES', limit: 300 }));
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
  const filtered = q ? waiting.filter((p) => `${p.unit_block || ''} ${p.unit_label || ''} ${p.tracking_code || ''} ${p.recipient_name || ''}`.toLowerCase().includes(q)) : waiting;

  const tabs: [Tab, string, React.ElementType][] = [['receber', 'Receber', PackagePlus], ['entregar', 'Entregar', PackageCheck], ['buscar', 'Buscar', Search]];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Portaria</h1>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid grid-cols-3 gap-2" role="tablist">
        {tabs.map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`min-h-14 rounded-2xl border text-base font-semibold flex items-center justify-center gap-2 ${tab === id ? 'bg-primary text-primary-fg border-transparent' : 'bg-surface border-line'}`}>
            <Icon className="w-5 h-5" aria-hidden /> {label}
          </button>
        ))}
      </div>

      {pre.length > 0 && (
        <Card className="space-y-2">
          <p className="font-semibold">Deixadas no totem — confira antes de avisar ({pre.length})</p>
          {pre.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
              <span className="text-sm">{p.carrier} · {p.tracking_code || 'sem rastreio'} · {p.unit_label ? unitName(p.unit_block, p.unit_label) : 'unidade não informada'} · {p.courier_name || ''}</span>
              <Button variant="secondary" onClick={() => setConfirmPre(p)}>Conferir</Button>
            </div>
          ))}
        </Card>
      )}

      {tab === 'receber' && (units ? (
        units.length === 0 ? <Alert tone="warning">Nenhuma unidade cadastrada ainda. O administrador cadastra em “Unidades e pessoas”.</Alert>
          : <ReceiveForm units={units} storage={storage} onDone={refresh} />
      ) : <Spinner />)}

      {tab === 'entregar' && (
        <Card className="space-y-4">
          <ScanToPickup onFound={(pkg, qr) => setPickup({ pkg, qr })} />
          <p className="text-sm text-muted">Sem QR? Encontre a encomenda em “Buscar” e use “Entregar sem QR”.</p>
        </Card>
      )}

      {(tab === 'buscar' || tab === 'entregar') && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-end gap-3 justify-between">
            <p className="font-semibold">Aguardando retirada ({waiting.length})</p>
            <div className="w-full sm:w-72"><Input aria-label="Buscar por unidade, rastreio ou nome" placeholder="Unidade, rastreio ou nome" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          </div>
          {!pending ? <Spinner /> : filtered.length === 0 ? <Empty title="Nada aguardando retirada" /> : (
            <ul className="divide-y divide-line">
              {filtered.map((p) => (
                <li key={p.id} className="py-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{unitName(p.unit_block, p.unit_label)} <span className="text-muted font-normal">· {p.carrier}</span></p>
                    <p className="text-xs text-muted">{p.tracking_code || 'sem rastreio'} · {dateTime(p.received_at, t.tenant.timezone)}{p.storage_code ? ` · ${p.storage_code}` : ''}{p.notified_at ? ' · avisado' : ''}</p>
                  </div>
                  <div className="flex gap-2">
                    {storage.length > 0 && <Button variant="ghost" onClick={() => setMove(p)} aria-label="Mover"><ArrowRightLeft className="w-4 h-4" /></Button>}
                    <Button variant="ghost" onClick={() => setResolve(p)}>Exceção</Button>
                    <Button variant="secondary" onClick={() => setPickup({ pkg: p, qr: null })}>Entregar sem QR</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'buscar' && <HistorySearch onReceipt={setReceipt} />}

      {pickup && <PickupModal pkg={pickup.pkg} qr={pickup.qr} onClose={() => setPickup(null)} onDone={(_, id) => { setPickup(null); refresh(); setReceipt(id); }} />}
      {receipt && <ReceiptModal packageId={receipt} onClose={() => setReceipt(null)} />}
      {confirmPre && units && (
        <Modal title="Conferir pré-registro" onClose={() => setConfirmPre(null)} wide>
          <ReceiveForm units={units} storage={storage} preregistered={confirmPre} onDone={() => { setConfirmPre(null); refresh(); }} />
        </Modal>
      )}
      {move && <MoveModal pkg={move} storage={storage} onClose={() => setMove(null)} onDone={() => { setMove(null); refresh(); }} />}
      {resolve && <ResolveModal pkg={resolve} onClose={() => setResolve(null)} onDone={() => { setResolve(null); refresh(); }} />}
    </div>
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
    <Card className="space-y-3">
      <form onSubmit={run} className="flex gap-2 items-end">
        <div className="flex-1"><Field label="Histórico completo"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rastreio, unidade ou nome" /></Field></div>
        <Button type="submit" variant="secondary">Buscar</Button>
      </form>
      {rows && (rows.length === 0 ? <Empty title="Nada encontrado" /> : (
        <ul className="divide-y divide-line">
          {rows.map((p) => (
            <li key={p.id} className="py-2 flex flex-wrap justify-between gap-2 text-sm">
              <span>{unitName(p.unit_block, p.unit_label)} · {p.carrier} · {p.tracking_code || '—'} · {dateTime(p.received_at, t.tenant.timezone)}</span>
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

function ResolveModal({ pkg, onClose, onDone }: { pkg: PackageRow; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [status, setStatus] = useState('DEVOLVIDA');
  const [reason, setReason] = useState('');
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
