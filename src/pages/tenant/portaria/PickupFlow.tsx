import React, { useEffect, useRef, useState } from 'react';
import { MapPin, QrCode } from 'lucide-react';
import { useTenant } from '../../../lib/tenant';
import { supabase } from '../../../lib/supabase';
import { newKey, rpc } from '../../../lib/api';
import { reencode, signedUrl, uploadPackageFile } from '../../../lib/files';
import { dateTime, unitName } from '../../../lib/format';
import { locationName, type PackageRow } from '../../../lib/packages';
import { setCaptureBusy } from '../../../lib/capture';
import { Alert, Button, Field, Input, Modal, Select, toast } from '../../../components/ui';
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

/**
 * Entrega: conferência visual (foto da etiqueta + local atual) → quem retira →
 * assinatura → foto do item entregue (obrigatória) → confirmação atômica no
 * servidor, idempotente por request id (retry após queda devolve o mesmo protocolo).
 */
export function PickupModal({ pkg, qr, onClose, onDone }: { pkg: PickupPackage; qr: string | null; onClose: () => void; onDone: (protocol: string, packageId: string) => void }) {
  const t = useTenant();
  const [who, setWho] = useState(pkg.recipient_name || '');
  const [kind, setKind] = useState<'morador' | 'autorizado'>('morador');
  const [sig, setSig] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [labelUrl, setLabelUrl] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(newKey());
  const uploaded = useRef<{ sig?: string; photo?: string; sigSrc?: string; photoSrc?: Blob }>({});
  const manual = !qr;

  // Captura em andamento: o aviso de nova versão não recarrega a página.
  useEffect(() => { setCaptureBusy(true); return () => setCaptureBusy(false); }, []);
  // Entrega aberta pela lista: busca local ATUAL e foto da etiqueta (RLS de equipe).
  const [info, setInfo] = useState<Pick<PickupPackage, 'storage_rack' | 'storage_shelf' | 'concierge_name' | 'label_photo_path' | 'storage_code'>>(pkg);
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
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  const takePhoto = async (b: Blob) => {
    try {
      const jpg = await reencode(b, { max: 1280 });
      setPhoto(jpg);
      setPhotoUrl(URL.createObjectURL(jpg));
    } catch (e: any) { toast.error(e.message); }
  };

  const confirm = async () => {
    if (!navigator.onLine) return setError('Sem conexão. A entrega só é confirmada com o servidor; tente quando a internet voltar.');
    if (who.trim().length < 2) return setError('Informe o nome de quem está retirando.');
    if (!sig) return setError('Colete a assinatura de quem está retirando.');
    if (!photo) return setError('Fotografe o item entregue.');
    if (manual && reason.trim().length < 10) return setError('Explique por que a retirada é sem QR (mín. 10 caracteres).');
    setBusy(true);
    setError(null);
    try {
      // Reenvia só o que mudou; retry reaproveita uploads anteriores.
      const up = uploaded.current;
      if (up.sigSrc !== sig) {
        up.sig = await uploadPackageFile(t.tenant.id, pkg.id, 'signature', new Blob([await (await fetch(sig)).blob()], { type: 'image/png' }));
        up.sigSrc = sig;
      }
      if (up.photoSrc !== photo) {
        up.photo = await uploadPackageFile(t.tenant.id, pkg.id, 'handover', photo);
        up.photoSrc = photo;
      }
      const r = await rpc('deliver_package', {
        p_tenant: t.tenant.id, p_package: pkg.id, p_request: request.current, p_qr: qr, p_picked_up_by: who.trim(),
        p_recipient_kind: kind, p_signature_path: up.sig, p_item_photo_path: up.photo, p_manual_reason: manual ? reason.trim() : null,
      });
      toast.success(`Entrega registrada. Protocolo ${r.protocol}. Moradores da unidade avisados.`);
      onDone(r.protocol, pkg.id);
    } catch (e: any) {
      setError(`${e.message} Nada foi confirmado; você pode tentar de novo com segurança.`);
    } finally {
      setBusy(false);
    }
  };

  const place = locationName({ code: info.storage_code || '—', rack: info.storage_rack, shelf: info.storage_shelf, concierge: info.concierge_name });
  return (
    <Modal title="Entregar encomenda" onClose={onClose} wide>
      <div className="space-y-4">
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
        {manual ? (
          <Alert tone="warning">Retirada sem QR Code: confira o documento de quem retira. A justificativa fica registrada na auditoria.</Alert>
        ) : <Alert tone="success">QR Code válido para esta encomenda. Ele só é usado ao confirmar.</Alert>}
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Quem está retirando"><Input value={who} onChange={(e) => setWho(e.target.value)} maxLength={120} autoComplete="off" /></Field>
          <Field label="Relação"><Select value={kind} onChange={(e) => setKind(e.target.value as any)}>
            <option value="morador">Morador da unidade</option><option value="autorizado">Recebedor autorizado</option>
          </Select></Field>
        </div>
        {manual && <Field label="Justificativa"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ex.: morador sem celular, documento conferido" /></Field>}
        <div>
          <p className="text-sm font-medium mb-1.5">Assinatura de quem retira</p>
          <SignaturePad onSignatureChange={setSig} />
          <p className="text-xs text-muted mt-1">Assinatura desenhada para registro interno; não é assinatura digital certificada.</p>
        </div>
        <div>
          <p className="text-sm font-medium mb-1.5">Foto do item entregue <span className="text-danger">(obrigatória)</span></p>
          {photoUrl ? (
            <div className="flex items-center gap-3">
              <img src={photoUrl} alt="Foto do item entregue" className="h-24 w-24 rounded-lg object-cover" />
              <Button variant="ghost" onClick={() => { setPhoto(null); setPhotoUrl(null); }}>Refazer foto</Button>
            </div>
          ) : <><CameraCapture onCapture={takePhoto} label="Fotografar item entregue" /><DemoPhotoSample onPick={takePhoto} /></>}
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button className="w-full min-h-14 text-base" loading={busy} onClick={confirm} disabled={!sig || !photo}>Confirmar entrega</Button>
      </div>
    </Modal>
  );
}
