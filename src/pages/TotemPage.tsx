import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Field, Input, Select } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';
import { CARRIERS, unitName } from '../lib/format';

// Credencial restrita ao dispositivo; nunca uma sessão Auth de funcionário.
export default function TotemPage({ slug }: { slug: string }) {
  const [secret, setSecret] = useState(() => { try { return localStorage.getItem(`pp_device:${slug}`) || ''; } catch { return ''; } });
  const [code, setCode] = useState('');
  const [units, setUnits] = useState<{ id: string; block: string; label: string }[]>([]);
  const [unit, setUnit] = useState('');
  const [tracking, setTracking] = useState('');
  const [carrier, setCarrier] = useState('Correios');
  const [courier, setCourier] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const key = useRef(crypto.randomUUID());
  async function call(action: string, body = {}, credential = secret) {
    const response = await fetch(`/api/totem/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Secret': credential },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Totem indisponível. Procure a portaria.');
    return data;
  }
  useEffect(() => {
    let active = true;
    if (secret) call('context').then(d => { if (active) setUnits(d.units); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [secret]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 6000);
    return () => clearTimeout(timer);
  }, [done]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!secret) {
        const result = await call('pair', { code });
        if (result.tenantSlug !== slug) throw new Error('Código de outro condomínio. Abra a rota correta no dispositivo.');
        try { localStorage.setItem(`pp_device:${slug}`, result.deviceSecret); } catch { /* Pareamento vale nesta sessão. */ }
        setSecret(result.deviceSecret); setCode('');
      } else {
        await call('preregister', { idempotencyKey: key.current, unitId: unit || null, trackingCode: tracking, carrier, courierName: courier });
        setUnit(''); setTracking(''); setCourier(''); setCarrier('Correios'); key.current = crypto.randomUUID(); setDone(true);
      }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <main className="min-h-dvh flex items-center justify-center px-4 py-8"><Card className="max-w-xl w-full space-y-5">
    <PortariaPrimeLogo /><h1 className="text-2xl font-semibold">Entrega na portaria</h1>
    {done ? <Alert tone="success">Pré-registro recebido. Entregue a encomenda ao porteiro para conferência. O aviso ao morador será feito depois da conferência.</Alert> : <form onSubmit={submit} className="space-y-4">
      {!secret ? <><p>Peça ao administrador um código de pareamento para este dispositivo.</p><Field label="Código de pareamento"><Input required value={code} maxLength={8} onChange={e => setCode(e.target.value.toUpperCase())} /></Field></> : <>
        <Field label="Unidade"><Select required value={unit} onChange={e => setUnit(e.target.value)}><option value="">Selecione…</option>{units.map(u => <option key={u.id} value={u.id}>{unitName(u.block, u.label)}</option>)}</Select></Field>
        <Field label="Transportadora"><Select value={carrier} onChange={e => setCarrier(e.target.value)}>{CARRIERS.map(c => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Rastreio"><Input value={tracking} maxLength={80} onChange={e => setTracking(e.target.value)} /></Field>
        <Field label="Nome do entregador"><Input value={courier} maxLength={80} onChange={e => setCourier(e.target.value)} /></Field>
      </>}
      {error && <Alert tone="danger">{error}</Alert>}<Button type="submit" className="w-full" loading={busy}>{secret ? 'Pré-registrar entrega' : 'Parear dispositivo'}</Button>
    </form>}
    <p className="text-xs text-muted">Sem acesso a moradores, telefones ou histórico. Operações administrativas exigem autenticação na área do condomínio.</p>
  </Card></main>;
}
