import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Layers, Loader2, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { useTenant } from '../../../lib/tenant';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';
import { api, newKey, rpc } from '../../../lib/api';
import { blobToDataUrl } from '../../../lib/files';
import { setCaptureBusy } from '../../../lib/capture';
import { CARRIERS, unitName } from '../../../lib/format';
import { listPackages, loadAvailability, matchUnits, type StorageLoc, type UnitRow } from '../../../lib/packages';
import { canonical, recall, remember, suggestions } from '../../../lib/recent';
import { DEMO } from '../../../demo/mode';
import { Alert, Badge, Button, Chips, Field, Input, Modal, Select } from '../../../components/ui';
import { CameraCapture } from '../../../components/CameraCapture';
import { preparePhoto, uploadGallery, type GalleryPhoto } from '../../../components/PhotoGallery';

/**
 * Recebimento em lote: o porteiro fotografa várias etiquetas seguidas e envia tudo de uma vez.
 * Cada foto passa pelo MESMO caminho do recebimento normal (OCR → correspondência no servidor → receive_and_store),
 * uma a uma, com chave de idempotência própria. Só é registrada sozinha quando o servidor confirma morador ativo
 * da unidade (status "matched"); o resto vai para a lista de pendências, com a foto, para resolver na hora.
 * Entregador e porteiro (logado, editável) valem para o lote todo. Local de guarda: o sugerido com vaga, um por item.
 */
type Status = 'queued' | 'reading' | 'saving' | 'done' | 'review' | 'error';
interface Item {
  key: string; photo: GalleryPhoto; status: Status; idempotency: string;
  ocr?: any; unitId?: string | null; unitText?: string; recipient?: string | null; carrier?: string; tracking?: string | null;
  reason?: string; storage?: string | null; packageId?: string;
}
const MAX = 40;
const CONCURRENCY = 3;
const REASON: Record<string, string> = {
  unit_only: 'Unidade lida, mas o nome não confere com os moradores', conflict: 'Nome de morador de outra unidade',
  ambiguous: 'Mais de uma unidade possível', name_only: 'Unidade não lida (sugerida pelo nome)', not_found: 'Unidade ou morador não identificado',
};

export function BatchReceive({ units, storage, onClose, onDone }: { units: UnitRow[]; storage: StorageLoc[]; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const { session } = useSession();
  const [courier, setCourier] = useState('');
  const [carrier, setCarrier] = useState('');
  const [receiver, setReceiver] = useState('');
  const edited = useRef(false);
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<Item | null>(null);
  const [recent, setRecent] = useState<{ courier_name: string | null; carrier: string; received_by_name?: string | null }[]>([]);
  const ocrEnabled = !!t.overview?.entitlements?.feature_ocr;

  // Porteiro logado já preenchido (editável, como no recebimento normal).
  useEffect(() => {
    let live = true;
    if (session?.user.id) void supabase.from('profiles').select('full_name').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => { if (live && !edited.current) setReceiver(data?.full_name || ''); });
    listPackages(t.tenant.id, { limit: 100 }).then((r) => live && setRecent(r)).catch(() => {});
    return () => { live = false; };
  }, [session?.user.id, t.tenant.id]);
  useEffect(() => { if (items.length) { setCaptureBusy(true); return () => setCaptureBusy(false); } }, [items.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const couriers = suggestions([], recent.map((p) => p.courier_name), [], 6);
  const carriers = suggestions(recall(t.tenant.id, 'carrier'), recent.map((p) => p.carrier), CARRIERS, 6);
  const porters = suggestions([], recent.map((p) => p.received_by_name), [], 6);
  const patch = (key: string, p: Partial<Item>) => setItems((all) => all.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const add = async (b: Blob) => {
    if (items.length >= MAX) { setError(`Até ${MAX} encomendas por lote. Envie este lote e comece outro.`); return; }
    try {
      const photo = await preparePhoto(b);
      // A mesma foto duas vezes no lote viraria duas encomendas: descarta a repetida.
      setItems((all) => (all.some((x) => x.photo.sha === photo.sha) ? all : [...all, { key: photo.id, photo, status: 'queued', idempotency: newKey() }]));
    } catch (e: any) { setError(e.message); }
  };
  const remove = (key: string) => setItems((all) => { const x = all.find((i) => i.key === key); if (x) URL.revokeObjectURL(x.photo.url); return all.filter((i) => i.key !== key); });

  /** Grava UMA encomenda (mesma RPC e regras do recebimento normal). Idempotente por item. */
  const save = async (it: Item, unitId: string, recipient: string | null, itemCarrier: string, tracking: string | null, locs: StorageLoc[]) => {
    const loc = locs.find((s) => (s.free ?? 1) > 0) || null;
    if (storage.length && !loc) throw new Error('Todos os locais de guarda estão lotados.');
    const pkg: any = await rpc('receive_and_store', {
      p_tenant: t.tenant.id, p_idempotency_key: it.idempotency, p_unit: unitId, p_tracking: tracking || null, p_carrier: itemCarrier,
      p_recipient: recipient || null, p_notes: 'Recebida no lote.', p_storage_location: loc?.id || null, p_label_sha256: it.photo.sha,
      p_courier: courier.trim(), p_received_by_name: receiver.trim(),
    });
    if (loc && loc.free !== undefined) loc.free -= 1;   // próxima do lote já vê a vaga ocupada
    await uploadGallery(t.tenant.id, pkg.id, [it.photo], () => {}).catch(() => false);   // foto não desfaz o registro
    return { id: pkg.id as string, storage: loc ? [loc.concierge, loc.rack, loc.shelf].filter(Boolean).join(' › ') || loc.code : pkg.storage_code || null };
  };

  const processOne = async (it: Item, locs: StorageLoc[], idx: number) => {
    patch(it.key, { status: 'reading', reason: undefined });
    let ocr: any = null;
    try {
      ocr = await api('/api/ocr/analyze-label', { tenantId: t.tenant.id, imageBase64: await blobToDataUrl(it.photo.blob), ...(DEMO ? { demoVariant: idx } : {}) });
    } catch (e: any) {
      return patch(it.key, { status: 'review', reason: e?.body?.manual ? 'Leitura automática indisponível (plano ou franquia)' : 'Não foi possível ler a etiqueta' });
    }
    const itemCarrier = carrier.trim() || (CARRIERS.includes(ocr.carrier) ? ocr.carrier : 'Outra');
    const base = { ocr, recipient: ocr.recipientName, carrier: itemCarrier, tracking: ocr.trackingCode, unitText: [ocr.block, ocr.unit].filter(Boolean).join(' ') };
    // Só registra sozinha com morador ativo confirmado na unidade. Qualquer dúvida = pendência com a foto.
    if (ocr.match?.status !== 'matched' || !ocr.match.unit_id) {
      return patch(it.key, { ...base, status: 'review', unitId: ocr.match?.unit_id || null, reason: REASON[ocr.match?.status] || 'Unidade ou morador não identificado' });
    }
    patch(it.key, { ...base, status: 'saving', unitId: ocr.match.unit_id });
    try {
      const r = await save(it, ocr.match.unit_id, ocr.recipientName, itemCarrier, ocr.trackingCode, locs);
      patch(it.key, { status: 'done', packageId: r.id, storage: r.storage });
    } catch (e: any) {
      patch(it.key, { status: 'error', unitId: ocr.match.unit_id, reason: e.message });
    }
  };

  const start = async () => {
    setError(null);
    if (courier.trim().length < 2) return setError('Informe o nome do entregador.');
    if (receiver.trim().length < 2) return setError('Informe o porteiro que está recebendo.');
    if (!ocrEnabled) return setError('A leitura automática não está no plano. Use “Receber encomenda” para registrar uma a uma.');
    const todo = items.filter((x) => x.status === 'queued');
    if (!todo.length) return setError('Fotografe pelo menos uma etiqueta.');
    setRunning(true);
    remember(t.tenant.id, 'carrier', carrier);
    const locs = await loadAvailability(t.tenant.id).catch(() => storage);
    // Poucas em paralelo: rápido sem estourar a conexão do celular nem a franquia de uma vez.
    let next = 0;
    const order = items.map((x) => x.key);
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
      while (next < todo.length) { const it = todo[next++]; await processOne(it, locs, order.indexOf(it.key)); }
    }));
    setRunning(false);
    setReport(true);
    onDone();
  };

  const done = items.filter((x) => x.status === 'done');
  const problems = items.filter((x) => x.status === 'review' || x.status === 'error');
  const pending = items.filter((x) => ['queued', 'reading', 'saving'].includes(x.status));
  const big = 'min-h-12 text-base';

  const footer = report
    ? <><Button key="mais" type="button" variant="secondary" className={big} onClick={() => setReport(false)}>Fotografar mais</Button>
      <Button key="fim" type="button" className={big} onClick={onClose}>Concluir</Button></>
    : <>{error && <div className="basis-full"><Alert tone="danger">{error}</Alert></div>}
      <Button key="enviar" type="button" className={big} loading={running} disabled={!pending.length && !running} onClick={start}>
        {running ? `Enviando… ${done.length + problems.length}/${items.length}` : `Enviar ${items.filter((x) => x.status === 'queued').length} encomenda(s)`}
      </Button></>;

  return (
    <>
    <Modal title="Receber várias encomendas" step={report ? 'Relatório do lote' : `${items.length} foto(s) · uma etiqueta por foto`} onClose={onClose} wide footer={footer}>
      {!report ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Field label="Entregador (obrigatório)"><Input value={courier} onChange={(e) => setCourier(e.target.value)} maxLength={80} autoComplete="off" placeholder="Ex.: João - Mercado Livre" /></Field>
              <Chips label="Entregadores recentes" options={couriers} selected={[courier]} onPick={(n) => { setCourier(n); const p = recent.find((x) => x.courier_name === n); if (p && !carrier) setCarrier(p.carrier); }} />
            </div>
            <div className="space-y-2">
              <Field label="Transportadora" hint="Vazio = a de cada etiqueta."><Input value={carrier} onChange={(e) => setCarrier(e.target.value)} onBlur={() => carrier && setCarrier(canonical(carrier, carriers))} maxLength={40} list="lote-transp" autoComplete="off" /></Field>
              <datalist id="lote-transp">{carriers.map((c) => <option key={c} value={c} />)}</datalist>
              <Chips label="Transportadoras frequentes" options={carriers.slice(0, 5)} selected={[carrier]} onPick={(c) => setCarrier(carrier === c ? '' : c)} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Field label="Recebido por (porteiro)" hint="Preenchido com quem está logado. Altere se o terminal for compartilhado.">
                <Input value={receiver} onChange={(e) => { edited.current = true; setReceiver(e.target.value); }} maxLength={120} autoComplete="name" />
              </Field>
              <Chips label="Porteiros recentes" options={porters} selected={[receiver]} onPick={(n) => { edited.current = true; setReceiver(n); }} />
            </div>
          </div>
          <Alert>Fotografe <strong>uma etiqueta por foto</strong>, bem de perto e sem reflexo. A câmera fica aberta: capture todas e toque em “Concluir”. Depois, “Enviar”.</Alert>
          {!running && <CameraCapture onCapture={add} label="Fotografar etiquetas" keepOpen multiple />}
          {DEMO && !running && <button type="button" className="min-h-11 rounded-xl border border-dashed border-line px-4 text-sm text-muted"
            onClick={async () => { for (let i = 0; i < 6; i++) await add(await demoLabel(i)); }}>Usar 6 etiquetas de exemplo</button>}
          {items.length > 0 && (
            <ol className="grid grid-cols-3 sm:grid-cols-5 gap-2" aria-label="Etiquetas do lote">
              {items.map((x, i) => (
                <li key={x.key} className="relative rounded-xl overflow-hidden bg-surface-2">
                  <img src={x.photo.url} alt={`Etiqueta ${i + 1}`} className="h-24 w-full object-cover" />
                  <span className="absolute top-1 left-1 text-[11px] px-1.5 rounded bg-surface">{i + 1}</span>
                  <StatusDot s={x.status} />
                  {x.status === 'queued' && !running && <button type="button" onClick={() => remove(x.key)} aria-label={`Remover etiqueta ${i + 1}`}
                    className="absolute top-1 right-1 p-1.5 rounded-full bg-surface"><Trash2 className="w-4 h-4" /></button>}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-line p-3"><p className="text-xs text-muted">Registradas e moradores avisados</p><p className="text-2xl font-semibold text-success">{done.length}</p></div>
            <div className="rounded-xl border border-line p-3"><p className="text-xs text-muted">Precisam de você</p><p className={`text-2xl font-semibold ${problems.length ? 'text-warning' : ''}`}>{problems.length}</p></div>
          </div>
          {problems.length > 0 && (
            <section aria-label="Pendências do lote" className="space-y-2">
              <p className="font-semibold">Pendências: toque para resolver</p>
              <ul className="space-y-2">
                {problems.map((x) => (
                  <li key={x.key} className="flex gap-3 items-center rounded-xl border border-warning/40 bg-warning-bg p-2">
                    <img src={x.photo.url} alt="Etiqueta com pendência" className="h-16 w-16 rounded-lg object-cover shrink-0" />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="font-medium">{x.reason}</p>
                      <p className="text-xs text-muted break-words">{[x.recipient && `Para: ${x.recipient}`, x.unitText && `Lido: ${x.unitText}`, x.tracking].filter(Boolean).join(' · ') || 'Nada lido'}</p>
                    </div>
                    <Button type="button" variant="secondary" onClick={() => setFix(x)}>Resolver</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {done.length > 0 && (
            <section aria-label="Registradas no lote" className="space-y-1">
              <p className="font-semibold">Registradas</p>
              <ul className="divide-y divide-line text-sm">
                {done.map((x) => {
                  const u = units.find((v) => v.id === x.unitId);
                  return <li key={x.key} className="py-2 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-success shrink-0" aria-hidden />
                    <span className="min-w-0">{u ? unitName(u.block, u.label, t.unitLabels) : x.unitText}{x.recipient ? ` · ${x.recipient}` : ''} · {x.carrier}{x.storage ? ` · guardar em ${x.storage}` : ''}</span></li>;
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
    {fix && <FixItem item={fix} units={units} onClose={() => setFix(null)} onSave={async (unitId, recipient) => {
      const locs = await loadAvailability(t.tenant.id).catch(() => storage);
      const r = await save(fix, unitId, recipient, fix.carrier || carrier || 'Outra', fix.tracking || null, locs);
      patch(fix.key, { status: 'done', unitId, recipient, packageId: r.id, storage: r.storage, reason: undefined });
      setFix(null); onDone();
    }} onDiscard={() => { remove(fix.key); setFix(null); }} />}
    </>
  );
}

function StatusDot({ s }: { s: Status }) {
  const map: Record<Status, [React.ReactNode, string]> = {
    queued: [null, ''], reading: [<Loader2 key="r" className="w-4 h-4 animate-spin" />, 'Lendo'], saving: [<Loader2 key="s" className="w-4 h-4 animate-spin" />, 'Registrando'],
    done: [<CheckCircle2 key="d" className="w-4 h-4 text-success" />, 'Registrada'], review: [<RotateCcw key="v" className="w-4 h-4 text-warning" />, 'Pendente'],
    error: [<XCircle key="e" className="w-4 h-4 text-danger" />, 'Erro'],
  };
  const [icon, label] = map[s];
  return icon ? <span className="absolute bottom-1 left-1 right-1 text-[11px] px-1.5 rounded bg-surface flex items-center gap-1">{icon}{label}</span> : null;
}

/** Pendência: escolher a unidade (e o destinatário) e registrar. Mesmas regras do recebimento normal. */
function FixItem({ item, units, onClose, onSave, onDiscard }: {
  item: Item; units: UnitRow[]; onClose: () => void; onSave: (unitId: string, recipient: string | null) => Promise<void>; onDiscard: () => void;
}) {
  const t = useTenant();
  const [q, setQ] = useState(item.unitText || '');
  const [unitId, setUnitId] = useState<string | null>(item.unitId || null);
  const [recipient, setRecipient] = useState(item.recipient || '');
  const [residents, setResidents] = useState<{ name: string; status: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unit = units.find((u) => u.id === unitId);
  useEffect(() => {
    setResidents([]);
    if (unitId) rpc<{ name: string; status: string }[]>('unit_residents_for_staff', { p_tenant: t.tenant.id, p_unit: unitId }).then((r) => setResidents(r.filter((x) => x.status === 'active'))).catch(() => {});
  }, [unitId, t.tenant.id]);
  const go = async () => {
    if (!unitId) return setError('Escolha a unidade.');
    setBusy(true); setError(null);
    try { await onSave(unitId, recipient.trim() || null); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Resolver pendência" onClose={onClose} footer={<>
      {error && <div className="basis-full"><Alert tone="danger">{error}</Alert></div>}
      <Button type="button" variant="secondary" className="min-h-12" onClick={onDiscard}>Tirar do lote</Button>
      <Button type="button" className="min-h-12" loading={busy} onClick={go}>Registrar</Button></>}>
      <div className="space-y-3">
        <img src={item.photo.url} alt="Etiqueta" className="w-full max-h-72 object-contain rounded-xl bg-surface-2" />
        <p className="text-sm"><Badge tone="warning">{item.reason}</Badge></p>
        <Field label="Unidade" hint={unit ? `Selecionada: ${unitName(unit.block, unit.label, t.unitLabels)}` : 'Digite bloco e número, ex.: “A 101”.'}>
          <Input value={q} onChange={(e) => { setQ(e.target.value); setUnitId(null); }} placeholder="Buscar unidade" autoComplete="off" />
        </Field>
        {!unitId && q && (
          <div className="flex flex-wrap gap-2" role="listbox" aria-label="Unidades encontradas">
            {matchUnits(units, q).slice(0, 12).map((u) => <button type="button" role="option" aria-selected={false} key={u.id} onClick={() => { setUnitId(u.id); setQ(unitName(u.block, u.label, t.unitLabels)); }}
              className="min-h-11 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-sm">{unitName(u.block, u.label, t.unitLabels)}</button>)}
          </div>
        )}
        <Field label="Destinatário"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={120} /></Field>
        <Chips label="Moradores da unidade" options={residents.map((r) => r.name)} selected={[recipient]} onPick={setRecipient} />
      </div>
    </Modal>
  );
}

/** Demonstração: etiquetas fictícias geradas no navegador (sem câmera). */
function demoLabel(i: number): Promise<Blob> {
  const c = document.createElement('canvas'); c.width = 480; c.height = 300;
  const g = c.getContext('2d')!;
  g.fillStyle = ['#fff8e7', '#eef6ff', '#f2fbf0', '#fff0f0', '#f6f0ff', '#f0fbff'][i % 6]; g.fillRect(0, 0, 480, 300);
  g.fillStyle = '#111'; g.font = 'bold 26px sans-serif'; g.fillText(`Etiqueta de exemplo ${i + 1}`, 24, 60);
  g.font = 'bold 18px sans-serif'; g.fillStyle = '#b91c1c'; g.fillText('DEMONSTRAÇÃO · DADOS FICTÍCIOS', 24, 270);
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('Falha ao gerar imagem.'))), 'image/jpeg', 0.85));
}

export const BatchIcon = Layers;
