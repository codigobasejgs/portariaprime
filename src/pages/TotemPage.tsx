import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Field, Input, Select } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';
import { CARRIERS, DEFAULT_UNIT_LABELS, unitName, type UnitLabels } from '../lib/format';
import { CameraCapture } from '../components/CameraCapture';
import { blobToDataUrl, reencode } from '../lib/files';

// Credencial restrita ao dispositivo; nunca uma sessão Auth de funcionário.
export default function TotemPage({ slug }: { slug: string }) {
  const [secret, setSecret] = useState(() => { try { return localStorage.getItem(`pp_device:${slug}`) || ''; } catch { return ''; } });
  const [code, setCode] = useState('');
  const [units, setUnits] = useState<{ id: string; block: string; label: string }[]>([]);
  const [unit, setUnit] = useState('');
  const [labels, setLabels] = useState<UnitLabels>(DEFAULT_UNIT_LABELS);
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState('Correios');
  const [courier, setCourier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ location: string } | null>(null);
  const submitting = useRef(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrMessage, setOcrMessage] = useState('');
  const reading = useRef(false);
  async function scanLabel(photo: Blob) {
    if (reading.current) return;
    reading.current = true; setOcrBusy(true); setError(''); setOcrMessage('');
    try {
      const result = await call('ocr', { imageBase64: await blobToDataUrl(await reencode(photo, { max: 1600 })) });
      setTracking(result.trackingCode || '');
      setCarrier(CARRIERS.includes(result.carrier) ? result.carrier : 'Outra');
      // Apenas unidades já disponíveis no contexto do dispositivo; nunca consulta moradores.
      const norm = (v: string | null) => (v || '').trim().toLocaleUpperCase('pt-BR');
      const matches = units.filter(u => norm(u.label) === norm(result.unit) && (!result.block || norm(u.block) === norm(result.block)));
      setUnit(matches.length === 1 ? matches[0].id : '');
      setOcrMessage(matches.length === 1 ? 'Etiqueta lida. Confira unidade, transportadora e rastreio antes de enviar.' : 'Confira os dados lidos e selecione a unidade. A leitura não identificou uma unidade única.');
    } catch (e: any) { setError(e.message); }
    finally { reading.current = false; setOcrBusy(false); }
  }
  const key = useRef(crypto.randomUUID());
  async function call(action: string, body = {}, credential = secret) {
    const response = await fetch(`/api/totem/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Secret': credential },
      body: JSON.stringify(body), signal: AbortSignal.timeout(action === 'ocr' ? 35000 : 15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Totem indisponível. Procure a portaria.');
    return data;
  }
  useEffect(() => {
    let active = true;
    if (secret) call('context').then(d => { if (active) { setUnits(d.units); if (d.labels) setLabels(d.labels); } }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [secret]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current || reading.current) return;
    if (!navigator.onLine) return setError('Sem conexão. Aguarde a internet voltar para registrar.');
    submitting.current = true; setBusy(true); setError('');
    try {
      if (!secret) {
        const result = await call('pair', { code });
        if (result.tenantSlug !== slug) throw new Error('Código de outro condomínio. Abra a rota correta no dispositivo.');
        try { localStorage.setItem(`pp_device:${slug}`, result.deviceSecret); } catch { /* Pareamento vale nesta sessão. */ }
        setSecret(result.deviceSecret); setCode('');
      } else {
        if (courier.trim().length < 2) throw new Error('Informe o nome do entregador.');
        const result = await call('receive', { idempotencyKey: key.current, unitId: unit || null, trackingCode: tracking, carrier, courierName: courier });
        const location = [result.concierge_name, result.storage_rack, result.storage_shelf, result.storage_code].filter(Boolean).join(' · ');
        setUnit(''); setTracking(''); setCourier(''); setCarrier('Correios'); setOcrMessage(''); key.current = crypto.randomUUID(); setDone({ location });
      }
    } catch (e: any) { setError(e.message); } finally { submitting.current = false; setBusy(false); }
  }
  return <main className="min-h-dvh flex items-center justify-center px-4 py-4 sm:py-8"><Card className="max-w-xl w-full space-y-5">
    <PortariaPrimeLogo /><h1 className="text-2xl font-semibold">Entrega na portaria</h1>
    {done ? <div className="space-y-4">
      <Alert tone="success">Encomenda registrada e disponível para os moradores da unidade. Avisos colocados na fila de envio.</Alert>
      <p className="text-lg font-semibold">Deposite a encomenda em: {done.location}</p>
      <Button className="w-full" onClick={() => setDone(null)}>Registrar outra encomenda</Button>
    </div> : <form onSubmit={submit} className="space-y-4">
      {!secret ? <><p>Peça ao administrador um código de pareamento para este dispositivo.</p><Field label="Código de pareamento"><Input required value={code} maxLength={8} onChange={e => setCode(e.target.value.toUpperCase())} /></Field></> : <>
        <fieldset disabled={busy || ocrBusy} className="space-y-3">
          <p className="font-semibold">Leitura de etiqueta com OCR</p>
          <CameraCapture onCapture={scanLabel} label="Escanear etiqueta (câmera)" />
        </fieldset>
        {ocrBusy && <p role="status">Lendo etiqueta…</p>}
        {ocrMessage && <Alert>{ocrMessage}</Alert>}
        <Field label="Unidade"><Select required value={unit} onChange={e => setUnit(e.target.value)}><option value="">Selecione…</option>{units.map(u => <option key={u.id} value={u.id}>{unitName(u.block, u.label, labels)}</option>)}</Select></Field>
        <Field label="Transportadora"><Select value={carrier} onChange={e => setCarrier(e.target.value)}>{CARRIERS.map(c => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Rastreio"><Input value={tracking} maxLength={80} onChange={e => setTracking(e.target.value)} /></Field>
        <Field label="Nome do entregador (obrigatório)" hint="Ex.: João - Mercado Livre"><Input required minLength={2} value={courier} maxLength={80} onChange={e => setCourier(e.target.value)} /></Field>
      </>}
      <div className="sticky bottom-0 -mx-4 sm:-mx-5 space-y-2 border-t border-line bg-surface px-4 sm:px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full min-h-12 text-base" loading={busy} disabled={ocrBusy}>{secret ? 'Registrar encomenda e avisar moradores' : 'Parear dispositivo'}</Button>
      </div>
    </form>}
    <p className="text-xs text-muted">Sem acesso a moradores, telefones ou histórico. Operações administrativas exigem autenticação na área do condomínio.</p>
    <p className="text-xs text-muted">O leitor de etiqueta funciona neste dispositivo pareado, sem conta de porteiro ou administrador.</p>
  </Card></main>;
}
