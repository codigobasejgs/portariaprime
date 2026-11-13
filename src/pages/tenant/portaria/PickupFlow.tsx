import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, QrCode } from 'lucide-react';
import { useTenant } from '../../../lib/tenant';
import { supabase } from '../../../lib/supabase';
import { newKey, rpc } from '../../../lib/api';
import { reencode, signedUrl, uploadPackageFile } from '../../../lib/files';
import { dateTime, unitName } from '../../../lib/format';
import { locationName, matchUnits, type PackageRow } from '../../../lib/packages';
import { setCaptureBusy } from '../../../lib/capture';
import { Alert, Button, Field, Input, Modal, Select } from '../../../components/ui';
import { QrCodeScanner } from '../../../components/QrCodeScanner';
import { SignaturePad } from '../../../components/SignaturePad';
import { CameraCapture } from '../../../components/CameraCapture';
import { PackagePhotos } from '../../../components/PhotoGallery';
import { DemoPhotoSample, DemoQrSample } from '../../../demo/samples';

export type PickupPackage = PackageRow & {
  storage_rack?: string | null; storage_shelf?: string | null; concierge_name?: string | null;
  label_photo_path?: string | null; moved?: boolean;
};

/** Lê o QR do morador: só CONSULTA (não consome). O consumo acontece na confirmação. */
export function ScanToPickup({ onFound }: { onFound: (pkg: PickupPackage, qr: string) => void }) {
  const t = useTenant();
  const [scan, setScan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decode = async (text: string) => {
    setScan(false);
    try {
      const pkg = await rpc('lookup_pickup_token', { p_tenant: t.tenant.id, p_qr: text.trim() });
      setError(null);
      onFound(pkg, text.trim());
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="space-y-2">
      {scan ? <QrCodeScanner onDecode={decode} onClose={() => setScan(false)} /> : (
        <><Button onClick={() => setScan(true)} className="w-full sm:w-auto min-h-14 text-base"><QrCode className="w-5 h-5" /> Ler QR Code do morador</Button> <DemoQrSample onPick={decode} /></>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

/** Local atual e foto da etiqueta da encomenda (RLS de equipe), para conferência visual antes de entregar. */
function PackageSummary({ pkg }: { pkg: PickupPackage }) {
  const t = useTenant();
  const [info, setInfo] = useState<Pick<PickupPackage, 'storage_rack' | 'storage_shelf' | 'concierge_name' | 'label_photo_path' | 'storage_code'>>(pkg);
  const [labelUrl, setLabelUrl] = useState<string | null>(null);
  useEffect(() => {
    if (pkg.storage_shelf !== undefined) return;
    (async () => {
      const [{ data: loc }, { data: att }] = await Promise.all([
        pkg.storage_location_id
          ? supabase.from('storage_locations').select('code, rack, shelf, concierge_locations(name)').eq('id', pkg.storage_location_id).maybeSingle()
          : Promise.resolve({ data: null }),
        // Galeria: a foto da posição 1 é a etiqueta.
        supabase.from('package_attachments').select('object_path').eq('package_id', pkg.id).eq('kind', 'label_photo')
          .order('position', { ascending: true, nullsFirst: false }).order('created_at').limit(1).maybeSingle(),
      ]);
      setInfo({ storage_code: loc?.code ?? pkg.storage_code, storage_rack: loc?.rack, storage_shelf: loc?.shelf,
        concierge_name: (loc as any)?.concierge_locations?.name, label_photo_path: att?.object_path });
    })().catch(() => { /* mantém o código do local */ });
  }, [pkg]);
  useEffect(() => {
    if (info.label_photo_path) signedUrl(info.label_photo_path).then(setLabelUrl).catch(() => setLabelUrl(null));
  }, [info.label_photo_path]);
  const place = locationName({ code: info.storage_code || '—', rack: info.storage_rack, shelf: info.storage_shelf, concierge: info.concierge_name });
  return (
    <>
      <div className="rounded-xl bg-surface-2 p-3 text-sm flex gap-3">
        {labelUrl && <img src={labelUrl} alt="Foto da etiqueta no recebimento" className="h-24 w-24 rounded-lg object-cover shrink-0" />}
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">{unitName(pkg.unit_block, pkg.unit_label, t.unitLabels)} · {pkg.carrier}</p>
          <p className="text-muted break-all">{pkg.tracking_code || 'Sem rastreio'} · recebida {dateTime(pkg.received_at, t.tenant.timezone)}</p>
          {pkg.recipient_name && <p>Etiqueta: {pkg.recipient_name}</p>}
          <p className="font-semibold flex items-center gap-1"><MapPin className="w-4 h-4" aria-hidden /> Buscar em: {place}</p>
          {pkg.moved && <p className="text-xs text-muted">Local atualizado após o recebimento.</p>}
        </div>
      </div>
      <PackagePhotos packageId={pkg.id} />
    </>
  );
}

export interface PickupStart { pkg?: PickupPackage; qr?: string | null }

/**
 * Entrega em etapas, cada uma numa tela com os botões fixos embaixo:
 *   1 unidade e quem retira (QR opcional) → 2 encomendas da unidade a entregar → 3 confirmação de cada uma
 *   (assinatura colhida uma vez + foto do item de cada encomenda) → resumo com os protocolos.
 * Cada encomenda é confirmada sozinha no servidor (deliver_package), idempotente por request id:
 * retry após queda devolve o mesmo protocolo. O QR só é consumido na confirmação da encomenda dele.
 */
export function PickupModal({ start, waiting, onClose, onDone, onReceipt }: {
  start: PickupStart; waiting: PackageRow[]; onClose: () => void; onDone: () => void; onReceipt: (packageId: string) => void;
}) {
  const t = useTenant();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [unitId, setUnitId] = useState<string | null>(start.pkg?.unit_id || null);
  const [unitQuery, setUnitQuery] = useState('');
  const [extra, setExtra] = useState<PickupPackage[]>(start.pkg ? [start.pkg] : []);
  const [qrs, setQrs] = useState<Record<string, string>>(start.pkg && start.qr ? { [start.pkg.id]: start.qr } : {});
  const [picked, setPicked] = useState<string[]>(start.pkg ? [start.pkg.id] : []);
  const [who, setWho] = useState(start.pkg?.recipient_name || '');
  const [kind, setKind] = useState<'morador' | 'autorizado'>('morador');
  const [reason, setReason] = useState('');
  const [residents, setResidents] = useState<{ name: string; status: string }[]>([]);
  const [queue, setQueue] = useState<PickupPackage[]>([]);
  const [idx, setIdx] = useState(0);
  const [sig, setSig] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [results, setResults] = useState<{ id: string; text: string; protocol: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef<Record<string, string>>({});
  const uploaded = useRef<Record<string, { sig?: string; photo?: string; sigSrc?: string; photoSrc?: Blob }>>({});

  // Captura em andamento: o aviso de nova versão não recarrega a página.
  useEffect(() => { setCaptureBusy(true); return () => setCaptureBusy(false); }, []);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  // Encomendas entregáveis: a lista da tela + a que veio do QR (pode não estar na página carregada).
  const pool = useMemo<PickupPackage[]>(() => [...extra, ...waiting.filter((p) => !extra.some((x) => x.id === p.id))], [extra, waiting]);
  const units = useMemo(() => [...new Map(pool.filter((p) => p.unit_id).map((p) => [p.unit_id!, { id: p.unit_id!, block: p.unit_block, label: p.unit_label || '', active: true }])).values()], [pool]);
  const ofUnit = pool.filter((p) => p.unit_id === unitId);
  const needsReason = picked.some((id) => !qrs[id]);

  // Moradores da unidade (só nome e situação): um toque preenche quem retira.
  useEffect(() => {
    setResidents([]);
    if (!unitId) return;
    let live = true;
    rpc<{ name: string; status: string }[]>('unit_residents_for_staff', { p_tenant: t.tenant.id, p_unit: unitId })
      .then((r) => live && setResidents(r.filter((x) => x.status === 'active'))).catch(() => {});
    return () => { live = false; };
  }, [unitId, t.tenant.id]);

  const fromQr = (pkg: PickupPackage, qr: string) => {
    setExtra((x) => [pkg, ...x.filter((p) => p.id !== pkg.id)]);
    setQrs((q) => ({ ...q, [pkg.id]: qr }));
    setUnitId(pkg.unit_id); setPicked([pkg.id]); setError(null);
    if (!who.trim()) setWho(pkg.recipient_name || '');
  };
  const chooseUnit = (id: string | null) => { setUnitId(id); setPicked([]); setUnitQuery(''); setError(null); };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const takePhoto = async (b: Blob) => {
    try {
      const jpg = await reencode(b, { max: 1280 });
      setPhoto(jpg);
      setPhotoUrl(URL.createObjectURL(jpg));
    } catch (e: any) { setError(e.message); }
  };

  const next = () => {
    if (step === 1) {
      if (!unitId) return setError('Leia o QR do morador ou escolha a unidade.');
      if (who.trim().length < 2) return setError('Informe o nome de quem está retirando.');
      if (picked.length === 0 && ofUnit.length === 1) setPicked([ofUnit[0].id]);
    } else {
      if (picked.length === 0) return setError('Marque pelo menos uma encomenda.');
      if (needsReason && reason.trim().length < 10) return setError('Explique por que a retirada é sem QR (mín. 10 caracteres).');
      setQueue(ofUnit.filter((p) => picked.includes(p.id))); setIdx(0);
    }
    setError(null); setStep(step === 1 ? 2 : 3);
  };

  const current = queue[idx];
  const confirm = async () => {
    if (!current) return;
    if (!navigator.onLine) return setError('Sem conexão. A entrega só é confirmada com o servidor; tente quando a internet voltar.');
    if (!sig) return setError('Colete a assinatura de quem está retirando.');
    if (!photo) return setError('Fotografe o item entregue.');
    setBusy(true);
    setError(null);
    try {
      // Reenvia só o que mudou; retry reaproveita uploads anteriores. A assinatura é a mesma, gravada em cada encomenda.
      const up = (uploaded.current[current.id] ||= {});
      if (up.sigSrc !== sig) {
        up.sig = await uploadPackageFile(t.tenant.id, current.id, 'signature', new Blob([await (await fetch(sig)).blob()], { type: 'image/png' }));
        up.sigSrc = sig;
      }
      if (up.photoSrc !== photo) {
        up.photo = await uploadPackageFile(t.tenant.id, current.id, 'handover', photo);
        up.photoSrc = photo;
      }
      const qr = qrs[current.id] || null;
      const r = await rpc('deliver_package', {
        p_tenant: t.tenant.id, p_package: current.id, p_request: (requests.current[current.id] ||= newKey()), p_qr: qr, p_picked_up_by: who.trim(),
        p_recipient_kind: kind, p_signature_path: up.sig, p_item_photo_path: up.photo, p_manual_reason: qr ? null : reason.trim(),
      });
      setResults((x) => [...x, { id: current.id, protocol: r.protocol, text: `${current.carrier}${current.tracking_code ? ` · ${current.tracking_code}` : ''}` }]);
      setPhoto(null); setPhotoUrl(null);
      onDone();
      if (idx + 1 < queue.length) setIdx(idx + 1); else setStep(4);
    } catch (e: any) {
      setError(`${e.message} Nada foi confirmado; você pode tentar de novo com segurança.`);
    } finally {
      setBusy(false);
    }
  };

  // A unidade some da lista quando a última encomenda dela é entregue: o nome vem da própria encomenda.
  const sample = queue[0] || ofUnit[0];
  const where = sample ? unitName(sample.unit_block, sample.unit_label, t.unitLabels) : '';
  const stepText = step === 4 ? 'Resumo da entrega'
    : step === 3 ? `Etapa 3 de 3 · Confirmação${queue.length > 1 ? ` · encomenda ${idx + 1} de ${queue.length}` : ''}`
    : `Etapa ${step} de 3 · ${step === 1 ? 'Unidade e quem retira' : 'Encomendas'}`;
  const problem = error && <div className="basis-full"><Alert tone="danger">{error}</Alert></div>;
  const big = 'min-h-12 text-base';
  const footer = step === 1 ? <>{problem}<Button key="avancar" type="button" className={big} onClick={next}>Avançar</Button></>
    : step === 2 ? <>{problem}
      <Button key="voltar" type="button" variant="secondary" className={big} onClick={() => { setError(null); setStep(1); }}>Voltar</Button>
      <Button key="avancar" type="button" className={big} onClick={next}>Avançar</Button></>
    : step === 3 ? <>{problem}
      {results.length === 0 && <Button key="voltar" type="button" variant="secondary" className={big} disabled={busy} onClick={() => { setError(null); setSig(null); setStep(2); }}>Voltar</Button>}
      <Button key="salvar" type="button" className={big} loading={busy} onClick={confirm} disabled={!sig || !photo}>Confirmar entrega</Button></>
    : <Button key="fim" type="button" className={big} onClick={onClose}>Encerrar entrega</Button>;

  return (
    <Modal title="Entregar encomenda" step={stepText} onClose={onClose} wide footer={footer}>
      {step === 1 && (
        <div className="space-y-4">
          {!unitId ? (
            <>
              <ScanToPickup onFound={fromQr} />
              <Field label="Ou escolha a unidade" hint="Só aparecem unidades com encomenda aguardando retirada.">
                <Input value={unitQuery} onChange={(e) => setUnitQuery(e.target.value)} placeholder="Buscar unidade" autoComplete="off" />
              </Field>
              <div className="flex flex-wrap gap-2" role="listbox" aria-label="Unidades com encomenda">
                {units.length === 0 && <p className="text-sm text-muted">Nenhuma encomenda aguardando retirada.</p>}
                {matchUnits(units, unitQuery).map((u) => (
                  <button type="button" role="option" aria-selected={false} key={u.id} onClick={() => chooseUnit(u.id)}
                    className="min-h-11 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-sm">
                    {unitName(u.block, u.label, t.unitLabels)} <span className="text-muted">({pool.filter((p) => p.unit_id === u.id).length})</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2 p-3">
                <p className="font-semibold">{where} <span className="text-muted font-normal">· {ofUnit.length} aguardando</span></p>
                <Button type="button" variant="ghost" onClick={() => chooseUnit(null)}>Trocar unidade</Button>
              </div>
              {picked.some((id) => qrs[id])
                ? <Alert tone="success">QR Code válido para esta encomenda. Ele só é usado ao confirmar.</Alert>
                : <Alert tone="warning">Retirada sem QR Code: confira o documento de quem retira. A justificativa fica registrada na auditoria.</Alert>}
              <Field label="Quem está retirando"><Input value={who} onChange={(e) => setWho(e.target.value)} maxLength={120} autoComplete="off" /></Field>
              {residents.length > 0 && (
                <div className="flex flex-wrap gap-2" aria-label="Moradores da unidade">
                  {residents.map((r, i) => <button type="button" key={i} onClick={() => { setWho(r.name); setKind('morador'); }}
                    className="min-h-11 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-sm">{r.name}</button>)}
                </div>
              )}
              <Field label="Relação"><Select value={kind} onChange={(e) => setKind(e.target.value as any)}>
                <option value="morador">Morador da unidade</option><option value="autorizado">Recebedor autorizado</option>
              </Select></Field>
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{where} · retirada por <span className="text-text font-medium">{who}</span></p>
          <ul className="space-y-2" aria-label="Encomendas da unidade">
            {ofUnit.map((p) => (
              <li key={p.id}>
                <label className={`flex items-start gap-3 rounded-xl border p-3 min-h-14 ${picked.includes(p.id) ? 'border-primary bg-surface-2' : 'border-line'}`}>
                  <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} className="mt-1 w-5 h-5" />
                  <span className="min-w-0 text-sm">
                    <span className="font-medium">{p.carrier}{p.recipient_name ? ` · ${p.recipient_name}` : ''}</span>
                    <span className="block text-xs text-muted break-all">{p.tracking_code || 'sem rastreio'} · {dateTime(p.received_at, t.tenant.timezone)}{p.storage_code ? ` · ${p.storage_code}` : ''}{qrs[p.id] ? ' · QR lido' : ''}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {needsReason && <Field label="Justificativa" hint="Obrigatória para encomenda entregue sem QR. Fica no histórico.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ex.: morador sem celular, documento conferido" />
          </Field>}
        </div>
      )}

      {step === 3 && current && (
        <div className="space-y-4">
          {results.length > 0 && <Alert tone="success">{results.length} de {queue.length} entregue(s). Protocolo {results[results.length - 1].protocol}. Agora a próxima encomenda.</Alert>}
          <PackageSummary key={current.id} pkg={current} />
          <div>
            <p className="text-sm font-medium mb-1.5">Foto do item entregue <span className="text-danger">(obrigatória)</span></p>
            {photoUrl ? (
              <div className="flex items-center gap-3">
                <img src={photoUrl} alt="Foto do item entregue" className="h-24 w-24 rounded-lg object-cover" />
                <Button type="button" variant="ghost" onClick={() => { setPhoto(null); setPhotoUrl(null); }}>Refazer foto</Button>
              </div>
            ) : <><CameraCapture onCapture={takePhoto} label="Fotografar item entregue" /><DemoPhotoSample onPick={takePhoto} /></>}
          </div>
          <div>
            <p className="text-sm font-medium mb-1.5">Assinatura de quem retira{queue.length > 1 && <span className="text-muted font-normal"> (vale para todas as encomendas desta entrega)</span>}</p>
            <SignaturePad onSignatureChange={setSig} />
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-3">
          <Alert tone="success">Entrega registrada. Moradores da unidade avisados.</Alert>
          <p className="text-sm">{where} · retirada por <strong>{who}</strong></p>
          <ul className="divide-y divide-line text-sm" aria-label="Encomendas entregues">
            {results.map((r) => (
              <li key={r.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                <span>{r.text}<span className="block text-xs text-muted">Protocolo {r.protocol}</span></span>
                <Button type="button" variant="secondary" onClick={() => onReceipt(r.id)}>Ver comprovante</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
