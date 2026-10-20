import React, { useState } from 'react';
import { QrCode } from 'lucide-react';
import { useTenant } from '../../../lib/tenant';
import { rpc } from '../../../lib/api';
import { reencode, uploadPackageFile } from '../../../lib/files';
import { dateTime, unitName } from '../../../lib/format';
import type { PackageRow } from '../../../lib/packages';
import { Alert, Button, Field, Input, Modal, toast } from '../../../components/ui';
import { QrCodeScanner } from '../../../components/QrCodeScanner';
import { SignaturePad } from '../../../components/SignaturePad';
import { CameraCapture } from '../../../components/CameraCapture';

/** Lê o QR do morador e devolve a encomenda correspondente (validação no servidor). */
export function ScanToPickup({ onFound }: { onFound: (pkg: PackageRow, qr: string) => void }) {
  const t = useTenant();
  const [scan, setScan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decode = async (text: string) => {
    setScan(false);
    try {
      const pkg = await rpc('lookup_pickup_token', { p_tenant: t.tenant.id, p_qr: text });
      setError(null);
      onFound(pkg, text);
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="space-y-2">
      {scan ? <QrCodeScanner onDecode={decode} onClose={() => setScan(false)} /> : (
        <Button onClick={() => setScan(true)} className="w-full sm:w-auto"><QrCode className="w-4 h-4" /> Ler QR Code do morador</Button>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

/**
 * Retirada: quem retira + assinatura (+ foto opcional). Sem QR, exige
 * justificativa e fica auditado. Assinatura é enviada ao bucket privado
 * antes; a RPC confere que o arquivo existe e grava tudo em uma transação.
 */
export function PickupModal({ pkg, qr, onClose, onDone }: { pkg: PackageRow; qr: string | null; onClose: () => void; onDone: (protocol: string, packageId: string) => void }) {
  const t = useTenant();
  const [who, setWho] = useState(pkg.recipient_name || '');
  const [sig, setSig] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manual = !qr;

  const confirm = async () => {
    if (who.trim().length < 2) return setError('Informe o nome de quem está retirando.');
    if (!sig) return setError('Colete a assinatura de quem está retirando.');
    if (manual && reason.trim().length < 10) return setError('Explique por que a retirada é sem QR (mín. 10 caracteres).');
    setBusy(true);
    setError(null);
    try {
      const sigBlob = await (await fetch(sig)).blob();
      const sigPath = await uploadPackageFile(t.tenant.id, pkg.id, 'signature', new Blob([sigBlob], { type: 'image/png' }));
      const handPath = photo ? await uploadPackageFile(t.tenant.id, pkg.id, 'handover', await reencode(photo, { max: 1280 })) : null;
      const r = await rpc('confirm_pickup', {
        p_tenant: t.tenant.id, p_package: pkg.id, p_method: manual ? 'manual' : 'qr', p_qr: qr,
        p_picked_up_by: who.trim(), p_signature_path: sigPath, p_handover_path: handPath, p_manual_reason: manual ? reason.trim() : null,
      });
      toast.success(`Entrega registrada. Protocolo ${r.protocol}.`);
      onDone(r.protocol, pkg.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Entregar encomenda" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-xl bg-surface-2 p-3 text-sm">
          <p className="font-semibold">{unitName(pkg.unit_block, pkg.unit_label)} · {pkg.carrier}</p>
          <p className="text-muted">{pkg.tracking_code || 'Sem rastreio'} · recebida {dateTime(pkg.received_at, t.tenant.timezone)}{pkg.storage_code ? ` · local ${pkg.storage_code}` : ''}</p>
        </div>
        {manual ? (
          <Alert tone="warning">Retirada sem QR Code: confira o documento de quem retira. A justificativa fica registrada na auditoria.</Alert>
        ) : <Alert tone="success">QR Code válido para esta encomenda.</Alert>}
        <Field label="Quem está retirando"><Input value={who} onChange={(e) => setWho(e.target.value)} maxLength={120} /></Field>
        {manual && <Field label="Justificativa"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Ex.: morador sem celular, documento conferido" /></Field>}
        <div>
          <p className="text-sm font-medium mb-1.5">Assinatura</p>
          <SignaturePad onSignatureChange={setSig} />
          <p className="text-xs text-muted mt-1">Assinatura desenhada para registro interno; não é assinatura digital certificada.</p>
        </div>
        <div>
          <p className="text-sm font-medium mb-1.5">Foto da entrega <span className="text-muted font-normal">(opcional)</span></p>
          {photo ? <p className="text-sm text-success">Foto capturada. <button className="underline" onClick={() => setPhoto(null)}>Remover</button></p> : <CameraCapture onCapture={setPhoto} />}
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button className="w-full" loading={busy} onClick={confirm}>Confirmar entrega</Button>
      </div>
    </Modal>
  );
}
