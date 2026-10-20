import React, { useMemo, useRef, useState } from 'react';
import { ScanText, X } from 'lucide-react';
import { useTenant } from '../../../lib/tenant';
import { api, rpc, newKey } from '../../../lib/api';
import { blobToDataUrl, reencode, uploadPackageFile } from '../../../lib/files';
import { CARRIERS, unitName } from '../../../lib/format';
import { matchUnits, StorageLoc, UnitRow } from '../../../lib/packages';
import { Alert, Button, Card, Field, Input, Select, toast } from '../../../components/ui';
import { CameraCapture } from '../../../components/CameraCapture';

interface Ocr { carrier: string; trackingCode: string | null; recipientName: string | null; block: string | null; unit: string | null; confidence: number }

/**
 * Recebimento: foto (opcional) → OCR sugere → porteiro confirma unidade,
 * destinatário e rastreio → servidor grava encomenda + histórico + avisos numa
 * transação. Chave de idempotência evita duplicar em duplo clique/retry.
 */
export function ReceiveForm({ units, storage, onDone, preregistered }: {
  units: UnitRow[]; storage: StorageLoc[]; onDone: () => void;
  preregistered?: { id: string; tracking_code: string | null; carrier: string; unit_id: string | null } | null;
}) {
  const t = useTenant();
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ocr, setOcr] = useState<Ocr | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<string | null>(null);
  const [unitQuery, setUnitQuery] = useState('');
  const [unitId, setUnitId] = useState<string | null>(preregistered?.unit_id || null);
  const [tracking, setTracking] = useState(preregistered?.tracking_code || '');
  const [carrier, setCarrier] = useState(preregistered?.carrier || 'Correios');
  const [recipient, setRecipient] = useState('');
  const [notes, setNotes] = useState('');
  const [loc, setLoc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const savedPackage = useRef<any>(null);
  const submitting = useRef(false);
  const trackingRef = useRef<HTMLInputElement>(null);

  const candidates = useMemo(() => matchUnits(units, unitQuery), [units, unitQuery]);
  const unit = units.find((u) => u.id === unitId);
  const ocrEnabled = !!t.overview?.entitlements?.feature_ocr;

  const takePhoto = async (b: Blob) => {
    try {
      const jpg = await reencode(b, { max: 1600 });
      setPhoto(jpg);
      setPreview(URL.createObjectURL(jpg));
      setOcr(null);
      setOcrMsg(null);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const runOcr = async () => {
    if (!photo) return;
    setOcrBusy(true);
    setOcrMsg(null);
    try {
      const r = await api<Ocr>('/api/ocr/analyze-label', { tenantId: t.tenant.id, imageBase64: await blobToDataUrl(photo) });
      setOcr(r);
      if (r.carrier) setCarrier(CARRIERS.includes(r.carrier) ? r.carrier : 'Outra');
      if (r.trackingCode) setTracking(r.trackingCode);
      if (r.recipientName) setRecipient(r.recipientName);
      const q = [r.block, r.unit].filter(Boolean).join(' ');
      if (q) {
        setUnitQuery(q);
        const m = matchUnits(units, q);
        setUnitId(m.length === 1 ? m[0].id : null);
      }
      setOcrMsg(r.confidence < 70 ? 'Leitura com baixa confiança: confira todos os campos com atenção.' : 'Sugestão preenchida. Confira antes de salvar.');
    } catch (e: any) {
      setOcrMsg(e.message);
    } finally {
      setOcrBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    if (!unitId) return setError('Selecione a unidade de destino.');
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const pkg = savedPackage.current || (preregistered
        ? await rpc('confirm_preregistered', { p_tenant: t.tenant.id, p_package: preregistered.id, p_unit: unitId, p_tracking: tracking || null, p_carrier: carrier, p_storage_location: loc || null })
        : await rpc('receive_package', {
          p_tenant: t.tenant.id, p_idempotency_key: key.current, p_unit: unitId, p_tracking: tracking || null, p_carrier: carrier,
          p_recipient: recipient || null, p_notes: notes || null, p_concierge: null, p_storage_location: loc || null,
        }));
      savedPackage.current = pkg;
      if (photo) {
        try {
          const path = await uploadPackageFile(t.tenant.id, pkg.id, 'label_photo', photo);
          await rpc('attach_package_file', { p_tenant: t.tenant.id, p_package: pkg.id, p_kind: 'label_photo', p_path: path });
        } catch (err: any) {
          setError(`Encomenda já registrada; foto pendente. Tente registrar novamente para reenviar somente a foto, sem duplicar a encomenda. ${err.message}`);
          return;
        }
      }
      toast.success(`Encomenda registrada para ${unitName(unit?.block, unit?.label)}${pkg.storage_code ? ` — guardar em ${pkg.storage_code}` : ''}.`);
      key.current = newKey();
      savedPackage.current = null;
      if (preview) URL.revokeObjectURL(preview);
      setPhoto(null); setPreview(null); setOcr(null); setOcrMsg(null);
      setUnitId(null); setUnitQuery(''); setTracking(''); setRecipient(''); setNotes(''); setLoc('');
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-3">
        <p className="font-semibold">1. Foto da etiqueta <span className="text-muted font-normal">(opcional)</span></p>
        {preview ? (
          <div className="relative">
            <img src={preview} alt="Foto da etiqueta" className="w-full rounded-xl max-h-72 object-contain bg-surface-2" />
            <button type="button" onClick={() => { setPhoto(null); setPreview(null); setOcr(null); }} className="absolute top-2 right-2 p-2 rounded-full bg-surface" aria-label="Remover foto"><X className="w-4 h-4" /></button>
          </div>
        ) : <CameraCapture onCapture={takePhoto} label="Fotografar etiqueta" />}
        {photo && ocrEnabled && (
          <Button type="button" variant="secondary" onClick={runOcr} loading={ocrBusy}><ScanText className="w-4 h-4" /> Ler etiqueta automaticamente</Button>
        )}
        {photo && !ocrEnabled && <p className="text-xs text-muted">Leitura automática não incluída no plano. Preencha os dados ao lado.</p>}
        {ocrMsg && <Alert tone={ocr && ocr.confidence >= 70 ? 'info' : 'warning'}>{ocrMsg}</Alert>}
      </Card>

      <Card className="space-y-4">
        <p className="font-semibold">2. Dados da encomenda</p>
        <Field label="Unidade de destino" hint={unit ? `Selecionada: ${unitName(unit.block, unit.label)}` : 'Digite bloco e unidade, ex.: "A 101" ou "casa 12".'}>
          <Input value={unitQuery} onChange={(e) => { setUnitQuery(e.target.value); setUnitId(null); }} placeholder="Buscar unidade" autoComplete="off" />
        </Field>
        {!unitId && unitQuery && (
          <div className="flex flex-wrap gap-2" role="listbox" aria-label="Unidades encontradas">
            {candidates.length === 0 && <p className="text-sm text-muted">Nenhuma unidade encontrada.</p>}
            {candidates.map((u) => (
              <button type="button" role="option" aria-selected={false} key={u.id}
                onClick={() => { setUnitId(u.id); setUnitQuery(unitName(u.block, u.label)); trackingRef.current?.focus(); }}
                className="min-h-10 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-sm">{unitName(u.block, u.label)}</button>
            ))}
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Transportadora"><Select value={carrier} onChange={(e) => setCarrier(e.target.value)}>{CARRIERS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
          <Field label="Rastreio" hint="Leitor USB funciona aqui (digita e dá Enter).">
            <Input ref={trackingRef} value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={80} autoComplete="off"
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          </Field>
        </div>
        {!preregistered && (
          <>
            <Field label="Destinatário (como está na etiqueta)"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={120} /></Field>
            <Field label="Observações"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Ex.: caixa grande, frágil" /></Field>
          </>
        )}
        {storage.length > 0 && (
          <Field label="Local de guarda" hint="Automático escolhe o local com mais espaço livre.">
            <Select value={loc} onChange={(e) => setLoc(e.target.value)}>
              <option value="">Automático</option>
              {storage.map((s) => <option key={s.id} value={s.id}>{s.code}{s.is_contingency ? ' (contingência)' : ''}</option>)}
            </Select>
          </Field>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full">{preregistered ? 'Confirmar recebimento' : 'Registrar encomenda'}</Button>
      </Card>
    </form>
  );
}
