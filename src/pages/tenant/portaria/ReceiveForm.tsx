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
import { listPackages, loadAvailability, locationName, matchUnits, type PackageRow, StorageLoc, UnitRow } from '../../../lib/packages';
import { canonical, recall, remember, suggestions } from '../../../lib/recent';
import { Alert, Badge, Button, Chips, Field, Input, Modal, Select, toast } from '../../../components/ui';
import { GalleryPhoto, PhotoGallery, preparePhoto, uploadGallery } from '../../../components/PhotoGallery';
import { DemoLabelSample } from '../../../demo/samples';
import { CourierPicker } from './CourierPicker';

interface Match {
  status: 'matched' | 'unit_only' | 'conflict' | 'ambiguous' | 'name_only' | 'not_found'; unit_id: string | null; alerts: string[];
  people?: { unit_id: string; name: string; score: number }[];
}
export const UNIDENTIFIED_REASONS = {
  unregistered_resident: 'Morador não cadastrado na unidade',
  incomplete_or_unknown_name: 'Nome incompleto ou desconhecido',
} as const;
export type UnidentifiedReason = keyof typeof UNIDENTIFIED_REASONS;
const PERSON_STATUS: Record<string, string> = { active: 'ativo', pending: 'pendente', revoked: 'revogado' };
interface Keyword { id: string; keyword: string; carrier: string | null; recipient_name: string | null }
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

/**
 * Recebimento em etapas, cada uma numa tela com os botões fixos embaixo:
 *   1 entregador → 2 encomenda (foto/OCR, unidade, destinatário, rastreio, guarda) → 3 confirmação
 *   ("Cadastrar próxima" volta à 2 com o mesmo entregador) → resumo de tudo que o entregador deixou.
 * O servidor grava encomenda + histórico + avisos numa transação (receive_and_store); a chave de
 * idempotência por item evita duplicar em duplo toque/retry. Pré-registro do totem: só etapas 1 e 2.
 */
export function ReceiveForm({ units, storage, onDone, onClose, preregistered }: {
  units: UnitRow[]; storage: StorageLoc[]; onDone: () => void; onClose: () => void;
  preregistered?: { id: string; tracking_code: string | null; carrier: string; unit_id: string | null; courier_name?: string | null } | null;
}) {
  const t = useTenant();
  const labels = useUnitLabels();
  const { session } = useSession();
  const [courier, setCourier] = useState(preregistered?.courier_name || '');
  const [courierId, setCourierId] = useState<string | null>(null);
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
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [done, setDone] = useState<string[]>([]);
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
  const [volume, setVolume] = useState('');
  const [customCarrier, setCustomCarrier] = useState(false);
  const [recent, setRecent] = useState<PackageRow[]>([]);
  useEffect(() => {
    let live = true;
    listPackages(t.tenant.id, { limit: 100 }).then((rows) => { if (live) setRecent(rows); }).catch(() => {});
    return () => { live = false; };
  }, [t.tenant.id]);
  const carrierOptions = suggestions(recall(t.tenant.id, 'carrier'), recent.map((p) => p.carrier), CARRIERS, 30);
  const courierOptions = suggestions([], recent.map((p) => p.courier_name));
  // Porteiros que receberam encomendas recentemente (o porteiro não lê a lista da equipe; o histórico já traz os nomes).
  const receiverOptions = suggestions([], recent.map((p) => p.received_by_name), [], 6);
  const volumeOptions = suggestions(recall(t.tenant.id, 'volume'), [], ['Caixa', 'Envelope', 'Pacote', 'Sacola', 'Volume grande']);
  const [loc, setLoc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const savedPackage = useRef<any>(null);
  const submitting = useRef(false);
  const trackingRef = useRef<HTMLInputElement>(null);
  const unitRef = useRef<HTMLInputElement>(null);
  const [ocrConfirm, setOcrConfirm] = useState(false);
  const [unidentified, setUnidentified] = useState<UnidentifiedReason | ''>('');
  const [residents, setResidents] = useState<{ name: string; status: string }[] | null>(null);
  const [keywords, setKeywords] = useState<Keyword[]>([]);

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

  // Unidade escolhida: moradores (nome + situação, sem contato) e palavras-chave ativas.
  useEffect(() => {
    setResidents(null); setKeywords([]);
    if (!unitId) return;
    let live = true;
    rpc<{ name: string; status: string }[]>('unit_residents_for_staff', { p_tenant: t.tenant.id, p_unit: unitId })
      .then((r) => live && setResidents(r)).catch(() => live && setResidents(null));
    rpc<Keyword[]>('list_delivery_keywords', { p_tenant: t.tenant.id, p_unit: unitId })
      .then((r) => live && setKeywords(r)).catch(() => live && setKeywords([]));
    return () => { live = false; };
  }, [unitId, t.tenant.id]);

  // "Alterar": fecha e leva ao campo da unidade (depois do Modal devolver o foco ao elemento anterior).
  const editOcr = () => { setOcrConfirm(false); setTimeout(() => { unitRef.current?.focus(); unitRef.current?.select(); }, 0); };

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
      setOcrConfirm(true);
    } catch (e: any) {
      setOcrMsg(e.message);
    } finally {
      setOcrBusy(false);
    }
  };

  const next = () => {
    if (courier.trim().length < 2) return setError('Informe o nome do entregador.');
    if (receiver.trim().length < 2) return setError('Informe o nome do porteiro que está recebendo.');
    if (!carrier.trim() || carrier.trim().length > 40) return setError('Informe a transportadora (até 40 caracteres).');
    setCarrier(canonical(carrier, carrierOptions));
    setError(null); setStep(2);
  };

  const save = async () => {
    if (submitting.current || ocrBusy) return;
    // ponytail: tipo de volume fica nas observações; coluna própria só quando houver filtro/relatório por tipo.
    const itemNotes = [volume.trim() ? `Volume: ${volume.trim()}` : '', notes.trim()].filter(Boolean).join('\n');
    if (itemNotes.length > 500) return setError('Tipo de volume e observações devem somar até 500 caracteres.');
    if (!unitId) return setError('Selecione a unidade de destino.');
    if (!preregistered && locs.length > 0 && (!loc || !stored)) return setError('Escolha o local e confirme que a encomenda foi guardada nele.');
    submitting.current = true;
    setBusy(true);
    setError(null);
    const where = unitName(unit?.block, unit?.label, labels);
    try {
      const pkg = savedPackage.current || (preregistered
        ? await rpc('confirm_preregistered', { p_tenant: t.tenant.id, p_package: preregistered.id, p_unit: unitId, p_tracking: tracking || null, p_carrier: carrier, p_storage_location: loc || null, p_courier: courier.trim(), p_received_by_name: receiver.trim() })
        : await rpc('receive_and_store', {
          p_tenant: t.tenant.id, p_idempotency_key: key.current, p_unit: unitId, p_tracking: tracking || null, p_carrier: carrier,
          p_recipient: recipient || null, p_notes: itemNotes || null, p_storage_location: loc || null, p_label_sha256: photoSha,
          p_courier: courier.trim(), p_received_by_name: receiver.trim(),
        }));
      savedPackage.current = pkg;
      // Vínculo com o entregador cadastrado (opcional): o nome já foi gravado; falha aqui não desfaz o recebimento.
      if (courierId) await rpc('package_set_courier', { p_tenant: t.tenant.id, p_package: pkg.id, p_courier: courierId }).catch(() => {});
      setSaved(true);
      // Chamada separada e idempotente (receive_and_store mantém a assinatura usada por totens/clientes antigos).
      if (unidentified) await rpc('package_mark_unidentified', { p_tenant: t.tenant.id, p_package: pkg.id, p_reason: unidentified });
      // Fotos: cada uma falha/repete sozinha; a encomenda nunca é duplicada.
      if (photos.length && !(await uploadGallery(t.tenant.id, pkg.id, photos, updatePhoto))) {
        setError('Encomenda já registrada; alguma foto não foi enviada. Toque em “Reenviar fotos” para reenviar só as fotos, sem duplicar a encomenda.');
        return;
      }
      setDone((d) => [...d, `${where}${recipient.trim() ? ` · ${recipient.trim()}` : ''}${volume.trim() ? ` · ${volume.trim()}` : ''}${tracking ? ` · ${tracking}` : ''}${chosen ? ` · ${locationName(chosen)}` : pkg.storage_code ? ` · ${pkg.storage_code}` : ''}`]);
      remember(t.tenant.id, 'carrier', carrier);
      remember(t.tenant.id, 'volume', volume);
      key.current = newKey();
      savedPackage.current = null;
      photos.forEach((p) => URL.revokeObjectURL(p.url));
      // Entregador, transportadora e porteiro ficam para a próxima encomenda da mesma entrega.
      setPhotos([]); setSaved(false); setOcr(null); setOcrMsg(null); setStored(false);
      setTracking(''); setRecipient(''); setNotes(''); setVolume(''); setUnidentified(''); setUnitId(null); setUnitQuery('');
      if (!preregistered) { setLoc(''); refreshAvail(); }
      onDone();
      if (preregistered) { toast.success(`Recebimento confirmado para ${where}. Moradores da unidade avisados.`); onClose(); } else setStep(3);
    } catch (err: any) {
      setError(err.message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const total = preregistered ? 2 : 3;
  const stepText = step === 4 ? 'Resumo do recebimento' : `Etapa ${step} de ${total} · ${['Entregador', 'Encomenda', 'Confirmação'][step - 1]}`;
  const problem = error && <div className="basis-full"><Alert tone="danger">{error}</Alert></div>;
  const big = 'min-h-12 text-base';
  const footer = step === 1 ? <>{problem}<Button key="avancar" type="button" className={big} onClick={next}>Avançar</Button></>
    : step === 2 ? <>{problem}
      <Button key="voltar" type="button" variant="secondary" className={big} disabled={busy || saved} onClick={() => { setError(null); setStep(1); }}>Voltar</Button>
      <Button key="salvar" type="button" className={big} loading={busy} onClick={save}>{saved ? 'Reenviar fotos' : preregistered ? 'Confirmar recebimento' : 'Salvar e avançar'}</Button></>
    : step === 3 ? <>
      <Button key="proxima" type="button" variant="secondary" className={big} onClick={() => setStep(2)}>Cadastrar próxima encomenda</Button>
      <Button key="encerrar" type="button" className={big} onClick={() => setStep(4)}>Encerrar recebimento</Button></>
    : <Button key="fim" type="button" className={big} onClick={onClose}>Finalizar</Button>;

  return (
    <>
    <Modal title={preregistered ? 'Conferir pré-registro' : 'Receber encomenda'} step={stepText} onClose={onClose} footer={footer}>
      {step === 1 && (
        <div className="space-y-4">
          <CourierPicker value={courier} onChange={setCourier} courierId={courierId} onSelect={setCourierId} carrier={carrier} onCarrier={setCarrier} ocrEnabled={ocrEnabled}
            recent={courierOptions} onRecent={(name) => { const previous = recent.find((p) => p.courier_name === name); if (previous) setCarrier(previous.carrier); }} />
          <Field label="Transportadora">{customCarrier
            ? <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} list="carriers-recentes" maxLength={40} autoComplete="off" />
            : <Select value={carrier} onChange={(e) => setCarrier(e.target.value)}>{suggestions([carrier], [], carrierOptions, 40).map((c) => <option key={c}>{c}</option>)}</Select>}
          </Field>
          <datalist id="carriers-recentes">{carrierOptions.map((c) => <option key={c} value={c} />)}</datalist>
          <Chips label="Transportadoras frequentes" options={carrierOptions.slice(0, 5)} selected={[carrier]} onPick={setCarrier} />
          <Button type="button" variant="ghost" onClick={() => setCustomCarrier((v) => !v)}>{customCarrier ? 'Escolher da lista' : 'Digitar outra transportadora'}</Button>
          <Field label="Recebido por (porteiro, obrigatório)" hint="Preenchido com quem está logado. Altere se o terminal for compartilhado.">
            <Input value={receiver} onChange={(e) => { receiverEdited.current = true; setReceiver(e.target.value); }} required minLength={2} maxLength={120} autoComplete="name" />
          </Field>
          <Chips label="Porteiros recentes" options={receiverOptions} selected={[receiver]} onPick={(name) => { receiverEdited.current = true; setReceiver(name); }} />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <p className="text-sm text-muted">Entregador: <span className="text-text font-medium">{courier}</span> · {carrier}{done.length > 0 && ` · ${done.length} já registrada(s)`}</p>
          <div className="space-y-2">
            <p className="text-sm font-medium">Foto da etiqueta <span className="text-muted font-normal">(opcional, até 8 fotos)</span></p>
            <PhotoGallery photos={photos} onChange={setPhotos} locked={saved || busy} label={ocrEnabled ? 'Escanear etiqueta (câmera)' : 'Fotografar etiqueta'}
              onRetry={savedPackage.current ? save : undefined} />
            {!saved && !busy && photos.length < 8 && <DemoLabelSample onPick={async (b) => setPhotos([...photos, await preparePhoto(b)])} />}
            {photo && ocrEnabled && (
              <Button type="button" variant="secondary" onClick={() => runOcr()} loading={ocrBusy}><ScanText className="w-4 h-4" /> {ocr ? 'Ler etiqueta de novo' : 'Ler etiqueta automaticamente'}</Button>
            )}
            {ocrMsg && <Alert tone={ocr && ocr.confidence >= 70 ? 'info' : 'warning'}>{ocrMsg}</Alert>}
            {ocr?.match && <Alert tone={ocr.match.status === 'matched' ? 'success' : 'warning'}>{MATCH_TEXT[ocr.match.status]}</Alert>}
            {ocr && [...ocr.alerts, ...(ocr.match?.alerts || [])].length > 0 && (
              <ul className="text-xs list-disc pl-4" aria-label="Alertas da leitura">{[...ocr.alerts, ...(ocr.match?.alerts || [])].map((a, i) => <li key={i}>{a}</li>)}</ul>
            )}
            {ocr && (
              <details className="text-xs"><summary className="cursor-pointer text-muted min-h-8">Detalhes da leitura</summary>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" aria-label="Campos lidos">
                  {([['Destinatário', ocr.recipientName], ['Remetente', ocr.senderName], ['Complemento', ocr.complement], ['Rastreio', ocr.trackingCode],
                    ['Pedido', ocr.orderNumber], ['Nota fiscal', ocr.invoiceNumber]] as const).map(([k, v]) => (
                    <React.Fragment key={k}><dt className="text-muted">{k}</dt><dd className="break-all">{v || 'não identificado'}</dd></React.Fragment>
                  ))}
                </dl>
                <ul className="mt-1 space-y-0.5">{ocr.evidence.map((e, i) => <li key={i}><span className="text-muted">{e.field}:</span> “{e.text}”</li>)}</ul>
              </details>
            )}
          </div>

          <Field label="Unidade de destino" hint={unit ? `Selecionada: ${unitName(unit.block, unit.label, labels)}` : `Digite ${labels.group.toLowerCase()} e ${labels.number.toLowerCase()}, ex.: "A 101", "Quadra B Lote 15" ou "Rua 3 Casa 12".`}>
            <Input ref={unitRef} value={unitQuery} onChange={(e) => { setUnitQuery(e.target.value); setUnitId(null); }} placeholder="Buscar unidade" autoComplete="off" />
          </Field>
          {!unitId && unitQuery && (
            <div className="flex flex-wrap gap-2" role="listbox" aria-label="Unidades encontradas">
              {candidates.length === 0 && <p className="text-sm text-muted">Nenhuma unidade encontrada.</p>}
              {candidates.map((u) => (
                <button type="button" role="option" aria-selected={false} key={u.id}
                  onClick={() => { setUnitId(u.id); setUnitQuery(unitName(u.block, u.label, labels)); }}
                  className="min-h-11 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-sm">{unitName(u.block, u.label, labels)}</button>
              ))}
            </div>
          )}
          {unitId && keywords.length > 0 && (
            <div className="rounded-xl border-2 border-secondary p-3 text-sm" role="status" aria-label="Palavra-chave da unidade">
              <Badge tone="accent">🔑 Unidade com palavra-chave de entrega</Badge>
              <ul className="mt-2 space-y-1">{keywords.map((k) => (
                <li key={k.id}><strong className="text-base tracking-wide">{k.keyword}</strong>{k.carrier ? ` · ${k.carrier}` : ''}{k.recipient_name ? ` · ${k.recipient_name}` : ''}</li>
              ))}</ul>
              <p className="text-xs text-muted mt-1">Peça a palavra ao entregador antes de receber. Depois, marque como utilizada em “Palavras-chave dos moradores”, na tela de Encomendas.</p>
            </div>
          )}
          {unitId && residents && (
            <div className="text-sm" aria-label="Moradores da unidade">
              <p className="text-muted text-xs mb-1">Moradores desta unidade:</p>
              {residents.length === 0 ? <p className="text-warning">Nenhum morador cadastrado nesta unidade.</p> : (
                <ul className="flex flex-wrap gap-2">{residents.map((r, i) => (
                  <li key={i}><button type="button" disabled={r.status !== 'active' || saved || !!preregistered} onClick={() => { setRecipient(r.name); setUnidentified(''); }}
                    className="min-h-11 rounded-lg border border-line px-3 py-1 disabled:opacity-60" aria-pressed={recipient === r.name}>
                    {r.name} <Badge tone={r.status === 'active' ? 'success' : r.status === 'pending' ? 'warning' : 'neutral'}>{PERSON_STATUS[r.status] || r.status}</Badge>
                  </button></li>
                ))}</ul>
              )}
            </div>
          )}
          {!preregistered && <Field label="Destinatário (como está na etiqueta)"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={120} /></Field>}
          <Field label="Rastreio" hint="Leitor USB funciona aqui (digita e dá Enter).">
            <Input ref={trackingRef} value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={80} autoComplete="off" />
          </Field>
          {!preregistered && (
            <div className="space-y-2">
              <Field label="Tipo de volume (opcional)" hint="Toque numa opção ou digite um tipo novo; ele aparece nas próximas vezes.">
                <Input value={volume} onChange={(e) => setVolume(e.target.value)} list="volumes-recentes" maxLength={60} autoComplete="off" />
              </Field>
              <datalist id="volumes-recentes">{volumeOptions.map((v) => <option key={v} value={v} />)}</datalist>
              <Chips label="Tipos de volume" options={volumeOptions} selected={[volume]} onPick={(v) => setVolume(volume === v ? '' : v)} />
            </div>
          )}
          {locs.length > 0 && (
            <div className="space-y-2">
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
          {!preregistered && (
            <details className="rounded-xl border border-line px-3">
              <summary className="cursor-pointer text-sm min-h-11 flex items-center">Mais opções (observações, morador não identificado)</summary>
              <div className="space-y-3 pb-3">
                <Field label="Observações"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Ex.: caixa grande, frágil" /></Field>
                <label className="flex items-center gap-2 text-sm min-h-11">
                  <input type="checkbox" checked={!!unidentified} onChange={(e) => setUnidentified(e.target.checked ? 'unregistered_resident' : '')} />
                  Morador não identificado
                </label>
                {unidentified && (
                  <Field label="Motivo" hint="A encomenda fica guardada normalmente e o síndico é avisado para destinar.">
                    <Select value={unidentified} onChange={(e) => setUnidentified(e.target.value as UnidentifiedReason)}>
                      {Object.entries(UNIDENTIFIED_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </Field>
                )}
              </div>
            </details>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Alert tone="success">Encomenda registrada para {done[done.length - 1]}. Moradores da unidade avisados.</Alert>
          <p className="text-sm text-muted">{done.length} encomenda(s) de <span className="text-text font-medium">{courier}</span> até agora. Tem mais alguma deste entregador?</p>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-3">
          <p className="text-sm">Entregador: <strong>{courier}</strong> · {carrier}<br />Recebido por: {receiver}</p>
          <p className="font-semibold">{done.length} encomenda(s) recebida(s)</p>
          <ol className="divide-y divide-line text-sm list-decimal pl-5" aria-label="Encomendas recebidas">
            {done.map((d, i) => <li key={i} className="py-2">{d}</li>)}
          </ol>
        </div>
      )}
    </Modal>
    {ocrConfirm && ocr && <OcrConfirm ocr={ocr} unit={unit} labels={labels} onConfirm={() => setOcrConfirm(false)} onEdit={editOcr} />}
    </>
  );
}

/** Confirmação da leitura: texto grande e alto contraste. Esc / “Alterar” levam ao campo da unidade. */
function OcrConfirm({ ocr, unit, labels, onConfirm, onEdit }: {
  ocr: Ocr; unit: UnitRow | undefined; labels: ReturnType<typeof useUnitLabels>; onConfirm: () => void; onEdit: () => void;
}) {
  const linked = ocr.match?.status === 'matched' || ocr.match?.status === 'name_only'
    ? ocr.match.people?.find((p) => p.unit_id === ocr.match!.unit_id)?.name || ocr.recipientName : null;
  const row = (k: string, v: string | null | undefined) => (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-line py-2">
      <dt className="text-base text-muted">{k}</dt>
      <dd className="text-2xl font-bold text-text break-all">{v || '—'}</dd>
    </div>
  );
  return (
    <Modal title="Confira a leitura da etiqueta" onClose={onEdit}>
      <div className="space-y-4">
        <dl aria-label="Dados lidos">
          {row(labels.group, unit?.block ?? ocr.block)}
          {row(labels.number, unit?.label ?? ocr.unit)}
          {row('Destinatário lido', ocr.recipientName)}
        </dl>
        {linked
          ? <p className="rounded-xl border-2 border-success p-3 text-lg font-semibold text-success">✔ Morador vinculado na unidade: {linked}</p>
          : <p className="rounded-xl border-2 border-warning bg-warning-bg p-3 text-lg font-semibold text-warning" role="alert">⚠ Morador não identificado na unidade. Confira antes de registrar.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Button type="button" className="min-h-14 text-lg" onClick={onConfirm}>✅ Confirmar</Button>
          <Button type="button" variant="secondary" className="min-h-14 text-lg" onClick={onEdit}>✏️ Alterar</Button>
        </div>
      </div>
    </Modal>
  );
}
