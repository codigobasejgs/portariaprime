import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScanText } from 'lucide-react';
import { useTenant } from '../../../lib/tenant';
import { useSession } from '../../../lib/session';
import { supabase } from '../../../lib/supabase';
import { useUnitLabels } from '../../../hooks/useUnitLabels';
import { api, rpc, newKey } from '../../../lib/api';
import { blobToDataUrl } from '../../../lib/files';
import { setCaptureBusy } from '../../../lib/capture';
import { CARRIERS, unitName } from '../../../lib/format';
import { loadAvailability, locationName, matchUnits, StorageLoc, UnitRow } from '../../../lib/packages';
import { Alert, Button, Card, Field, Input, Select, toast } from '../../../components/ui';
import { GalleryPhoto, PhotoGallery, uploadGallery } from '../../../components/PhotoGallery';

interface Match { status: 'matched' | 'unit_only' | 'conflict' | 'ambiguous' | 'name_only' | 'not_found'; unit_id: string | null; alerts: string[] }
interface Ocr {
  carrier: string; trackingCode: string | null; recipientName: string | null; senderName: string | null; block: string | null; unit: string | null;
  complement: string | null; orderNumber: string | null; invoiceNumber: string | null; evidence: { field: string; text: string }[]; alerts: string[];
  confidence: number; match: Match | null;
}
const MATCH_TEXT: Record<Match['status'], string> = {
  matched: 'Destinatário confere com um morador ativo da unidade.',
  unit_only: 'Unidade encontrada, mas o nome não confere com os moradores ativos. Confira com atenção.',
  conflict: 'O nome lido é de morador de outra unidade. Confirme a unidade antes de registrar.',
  ambiguous: 'Mais de uma possibilidade (homônimos ou bloco não lido). Escolha a unidade correta.',
  name_only: 'Unidade não lida: sugerida pelo nome. Confira a etiqueta.',
  not_found: 'Nenhum morador ativo corresponde à leitura. Escolha a unidade manualmente.',
};

interface BatchResult { key: string; ok: boolean; text: string }

/**
 * Recebimento: fotos (opcionais, até 8; a 1ª é a etiqueta e alimenta o OCR) →
 * OCR sugere → porteiro confirma unidade, destinatário e rastreio → servidor
 * grava encomenda + histórico + avisos numa transação. Chave de idempotência
 * por item evita duplicar em duplo clique/retry.
 * Registro rápido (lote): mantém unidade/transportadora/local entre itens;
 * destinatário obrigatório e guarda física confirmada em cada item; resultado
 * individual listado. Usa a mesma RPC (receive_and_store).
 */
export function ReceiveForm({ units, storage, onDone, preregistered }: {
  units: UnitRow[]; storage: StorageLoc[]; onDone: () => void;
  preregistered?: { id: string; tracking_code: string | null; carrier: string; unit_id: string | null; courier_name?: string | null } | null;
}) {
  const t = useTenant();
  const labels = useUnitLabels();
  const { session } = useSession();
  const [courier, setCourier] = useState(preregistered?.courier_name || '');
  const [receiver, setReceiver] = useState('');
  const receiverEdited = useRef(false);
  useEffect(() => {
    let active = true;
    if (session?.user.id) void supabase.from('profiles').select('full_name').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => { if (active && !receiverEdited.current) setReceiver(data?.full_name || ''); });
    return () => { active = false; };
  }, [session?.user.id]);
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [avail, setAvail] = useState<StorageLoc[] | null>(null);
  const [stored, setStored] = useState(false);
  const [batch, setBatch] = useState(false);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [saved, setSaved] = useState(false);
  const photo = photos[0]?.blob || null;
  const photoSha = photos[0]?.sha || null;
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
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (photos.length > 0) {
      setCaptureBusy(true);
      return () => setCaptureBusy(false);
    }
  }, [photos.length]);

  // Vagas reais calculadas no servidor; recarrega após cada registro.
  const refreshAvail = () => loadAvailability(t.tenant.id).then(setAvail).catch(() => setAvail(null));
  useEffect(() => { if (!preregistered) refreshAvail(); }, [t.tenant.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const locs = avail || storage;
  const suggested = locs.find((s) => (s.free ?? 1) > 0);
  useEffect(() => { if (!preregistered && !loc && suggested) setLoc(suggested.id); }, [suggested?.id, loc]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = locs.find((s) => s.id === loc);

  const candidates = useMemo(() => matchUnits(units, unitQuery), [units, unitQuery]);
  const unit = units.find((u) => u.id === unitId);
  const ocrEnabled = !!t.overview?.entitlements?.feature_ocr;

  // A primeira foto é a etiqueta: identifica a foto (dedupe no servidor) e alimenta o OCR.
  const firstId = photos[0]?.id;
  useEffect(() => {
    setOcr(null); setOcrMsg(null);
    // Leitura automática logo após a foto (plano com OCR); operador ainda confere tudo.
    if (photos[0] && ocrEnabled && !saved) void runOcr(photos[0].blob);
  }, [firstId]); // eslint-disable-line react-hooks/exhaustive-deps
  const updatePhoto = (id: string, p: Partial<GalleryPhoto>) => setPhotos((all) => all.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const runOcr = async (img: Blob | null = photo) => {
    if (!img) return;
    setOcrBusy(true);
    setOcrMsg(null);
    try {
      const r = await api<Ocr>('/api/ocr/analyze-label', { tenantId: t.tenant.id, imageBase64: await blobToDataUrl(img) });
      setOcr(r);
      if (r.carrier) setCarrier(CARRIERS.includes(r.carrier) ? r.carrier : 'Outra');
      if (r.trackingCode) setTracking(r.trackingCode);
      if (r.recipientName) setRecipient(r.recipientName);
      // Unidade só vem pré-selecionada quando o servidor encontrou morador ativo; demais casos exigem escolha humana.
      const hit = r.match?.unit_id ? units.find((u) => u.id === r.match!.unit_id) : null;
      if (hit && (r.match!.status === 'matched' || r.match!.status === 'name_only')) {
        setUnitId(hit.id); setUnitQuery(unitName(hit.block, hit.label, labels));
      } else {
        setUnitId(null); setUnitQuery([r.block, r.unit].filter(Boolean).join(' '));
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
    if (courier.trim().length < 2) return setError('Informe o nome do entregador.');
    if (receiver.trim().length < 2) return setError('Informe o nome do porteiro que está recebendo.');
    if (batch && !preregistered && recipient.trim().length < 2) return setError('No registro rápido, informe o destinatário de cada encomenda.');
    if (!preregistered && locs.length > 0 && (!loc || !stored)) return setError('Escolha o local e confirme que a encomenda foi guardada nele.');
    submitting.current = true;
    setBusy(true);
    setError(null);
    const itemKey = key.current;
    const where = unitName(unit?.block, unit?.label, labels);
    try {
      const pkg = savedPackage.current || (preregistered
        ? await rpc('confirm_preregistered', { p_tenant: t.tenant.id, p_package: preregistered.id, p_unit: unitId, p_tracking: tracking || null, p_carrier: carrier, p_storage_location: loc || null, p_courier: courier.trim(), p_received_by_name: receiver.trim() })
        : await rpc('receive_and_store', {
          p_tenant: t.tenant.id, p_idempotency_key: key.current, p_unit: unitId, p_tracking: tracking || null, p_carrier: carrier,
          p_recipient: recipient || null, p_notes: notes || null, p_storage_location: loc || null, p_label_sha256: photoSha,
          p_courier: courier.trim(), p_received_by_name: receiver.trim(),
        }));
      savedPackage.current = pkg;
      setSaved(true);
      // Fotos: cada uma falha/repete sozinha; a encomenda nunca é duplicada.
      if (photos.length && !(await uploadGallery(t.tenant.id, pkg.id, photos, updatePhoto))) {
        setError('Encomenda já registrada; alguma foto não foi enviada. Toque em “Registrar” (ou “Reenviar fotos com falha”) para reenviar só as fotos, sem duplicar a encomenda.');
        if (batch) setResults((r) => [{ key: itemKey, ok: false, text: `${where}: registrada, foto pendente` }, ...r.filter((x) => x.key !== itemKey)]);
        return;
      }
      const msg = `Encomenda registrada para ${where}${chosen ? ` em ${locationName(chosen)}` : pkg.storage_code ? ` — guardar em ${pkg.storage_code}` : ''}. Moradores da unidade avisados.`;
      toast.success(msg);
      if (batch) setResults((r) => [{ key: itemKey, ok: true, text: `${where} · ${recipient.trim()}${tracking ? ` · ${tracking}` : ''}${chosen ? ` · ${locationName(chosen)}` : ''}` }, ...r.filter((x) => x.key !== itemKey)]);
      key.current = newKey();
      savedPackage.current = null;
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      setPhotos([]); setSaved(false); setOcr(null); setOcrMsg(null); setStored(false);
      setTracking(''); setRecipient(''); setNotes(''); setCourier('');
      if (!preregistered) refreshAvail();
      // Registro rápido mantém unidade, transportadora e local; a guarda é confirmada de novo a cada item.
      if (!batch) {
        if (!preregistered) setLoc('');
        setUnitId(null); setUnitQuery('');
      } else trackingRef.current?.focus();
      onDone();
    } catch (err: any) {
      setError(err.message);
      if (batch && !savedPackage.current) setResults((r) => [{ key: itemKey, ok: false, text: `${where}: ${err.message}` }, ...r.filter((x) => x.key !== itemKey)]);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
      <Card className="space-y-3" data-tour="receber-foto">
        <p className="font-semibold">1. Fotos <span className="text-muted font-normal">(opcional, até 8 — a primeira é a etiqueta)</span></p>
        <PhotoGallery photos={photos} onChange={setPhotos} locked={saved || busy} label={ocrEnabled ? 'Escanear etiqueta (câmera)' : 'Fotografar etiqueta'}
          onRetry={savedPackage.current ? () => formRef.current?.requestSubmit() : undefined} />
        {photo && ocrEnabled && (
          <Button type="button" variant="secondary" onClick={() => runOcr()} loading={ocrBusy}><ScanText className="w-4 h-4" /> {ocr ? 'Ler etiqueta de novo' : 'Ler etiqueta automaticamente'}</Button>
        )}
        {photo && !ocrEnabled && <p className="text-xs text-muted">Leitura automática não incluída no plano. Preencha os dados ao lado.</p>}
        {ocrMsg && <Alert tone={ocr && ocr.confidence >= 70 ? 'info' : 'warning'}>{ocrMsg}</Alert>}
        {ocr?.match && <Alert tone={ocr.match.status === 'matched' ? 'success' : 'warning'}>{MATCH_TEXT[ocr.match.status]}</Alert>}
        {ocr && [...ocr.alerts, ...(ocr.match?.alerts || [])].length > 0 && (
          <ul className="text-xs list-disc pl-4" aria-label="Alertas da leitura">{[...ocr.alerts, ...(ocr.match?.alerts || [])].map((a, i) => <li key={i}>{a}</li>)}</ul>
        )}
        {ocr && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" aria-label="Campos lidos">
            {([['Destinatário', ocr.recipientName], ['Remetente', ocr.senderName], ['Complemento', ocr.complement], ['Rastreio', ocr.trackingCode],
              ['Pedido', ocr.orderNumber], ['Nota fiscal', ocr.invoiceNumber]] as const).map(([k, v]) => (
              <React.Fragment key={k}><dt className="text-muted">{k}</dt><dd className="break-all">{v || 'não identificado'}</dd></React.Fragment>
            ))}
          </dl>
        )}
        {ocr && ocr.evidence.length > 0 && (
          <details className="text-xs"><summary className="cursor-pointer text-muted">Evidências da leitura</summary>
            <ul className="mt-1 space-y-0.5">{ocr.evidence.map((e, i) => <li key={i}><span className="text-muted">{e.field}:</span> “{e.text}”</li>)}</ul>
          </details>
        )}
      </Card>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-semibold">2. Dados da encomenda</p>
          {!preregistered && (
            <label className="flex items-center gap-2 text-sm min-h-11">
              <input type="checkbox" checked={batch} onChange={(e) => { setBatch(e.target.checked); setResults([]); }} />
              Registro rápido (várias seguidas)
            </label>
          )}
        </div>
        {batch && <p className="text-xs text-muted">Unidade, transportadora e local ficam para o próximo item. Destinatário e confirmação da guarda são exigidos em cada encomenda.</p>}
        <div data-tour="receber-unidade"><Field label="Unidade de destino" hint={unit ? `Selecionada: ${unitName(unit.block, unit.label, labels)}` : `Digite ${labels.group.toLowerCase()} e ${labels.number.toLowerCase()}, ex.: "A 101", "Quadra B Lote 15" ou "Rua 3 Casa 12".`}>
          <Input value={unitQuery} onChange={(e) => { setUnitQuery(e.target.value); setUnitId(null); }} placeholder="Buscar unidade" autoComplete="off" />
        </Field></div>
        {!unitId && unitQuery && (
          <div className="flex flex-wrap gap-2" role="listbox" aria-label="Unidades encontradas">
            {candidates.length === 0 && <p className="text-sm text-muted">Nenhuma unidade encontrada.</p>}
            {candidates.map((u) => (
              <button type="button" role="option" aria-selected={false} key={u.id}
                onClick={() => { setUnitId(u.id); setUnitQuery(unitName(u.block, u.label, labels)); trackingRef.current?.focus(); }}
                className="min-h-10 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-sm">{unitName(u.block, u.label, labels)}</button>
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
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Nome do entregador (obrigatório)" hint="Ex.: João - Mercado Livre">
            <Input value={courier} onChange={(e) => setCourier(e.target.value)} required minLength={2} maxLength={80} autoComplete="off" />
          </Field>
          <Field label="Recebido por (porteiro, obrigatório)" hint="Preenchido com quem está logado. Altere se o terminal for compartilhado.">
            <Input value={receiver} onChange={(e) => { receiverEdited.current = true; setReceiver(e.target.value); }} required minLength={2} maxLength={120} autoComplete="name" />
          </Field>
        </div>
        {!preregistered && (
          <>
            <Field label="Destinatário (como está na etiqueta)"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={120} required={batch} /></Field>
            <Field label="Observações"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Ex.: caixa grande, frágil" /></Field>
          </>
        )}
        {locs.length > 0 && (
          <div data-tour="receber-local" className="space-y-2">
            <Field label="Local de guarda" hint={preregistered ? 'Vazio = automático (local com mais espaço).' : 'Sugerido: local com mais espaço livre. Contingência só quando os demais lotarem.'}>
              <Select value={loc} onChange={(e) => { setLoc(e.target.value); setStored(false); }}>
                <option value="">{preregistered ? 'Automático' : 'Selecione…'}</option>
                {locs.map((s) => <option key={s.id} value={s.id} disabled={s.free === 0}>
                  {locationName(s)}{s.is_contingency ? ' (contingência)' : ''}{s.free !== undefined ? ` — ${s.free} vaga(s)` : ''}
                </option>)}
              </Select>
            </Field>
            {!preregistered && avail && !suggested && <Alert tone="danger">Todos os locais estão lotados. O administrador precisa liberar espaço ou cadastrar uma área de contingência.</Alert>}
            {!preregistered && chosen && (
              <label className="flex items-start gap-2 text-sm min-h-11 rounded-xl border border-line p-3">
                <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} className="mt-1" />
                <span>Guardei fisicamente em <strong>{locationName(chosen)}</strong>.</span>
              </label>
            )}
          </div>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={busy} className="w-full" data-tour="receber-salvar">{preregistered ? 'Confirmar recebimento' : 'Registrar encomenda'}</Button>
        {batch && results.length > 0 && (
          <div className="space-y-1">
            <p className="text-sm font-medium">Nesta sequência: {results.filter((r) => r.ok).length} registrada(s){results.some((r) => !r.ok) ? `, ${results.filter((r) => !r.ok).length} com pendência` : ''}</p>
            <ul className="text-sm divide-y divide-line" aria-label="Resultado do registro rápido">
              {results.map((r) => <li key={r.key} className={`py-1 ${r.ok ? '' : 'text-danger'}`}>{r.ok ? '✓' : '!'} {r.text}</li>)}
            </ul>
          </div>
        )}
      </Card>
    </form>
  );
}
