import React, { useEffect, useState } from 'react';
import { useTenant } from '../../../lib/tenant';
import { api, rpc } from '../../../lib/api';
import { blobToDataUrl, reencode } from '../../../lib/files';
import { CARRIERS } from '../../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Select } from '../../../components/ui';
import { CameraCapture } from '../../../components/CameraCapture';
import { DemoCnhSample } from '../../../demo/samples';

interface Hit { id: string; full_name: string; carrier_default: string | null; document_hint: string | null }
interface Cnh { full_name: string | null; cpf: string | null; cnh_number: string | null; category: string | null; confidence: number; alerts: string[] }
const CATS = ['', 'A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'];
const noEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') e.preventDefault(); };
const display = (h: { full_name: string; carrier_default: string | null }) => (h.carrier_default ? `${h.full_name} - ${h.carrier_default}` : h.full_name).slice(0, 80);

/**
 * Entregador do recebimento: nome digitado (obrigatório, como sempre) + atalhos opcionais:
 * autocomplete de entregadores já cadastrados e leitura da CNH (OCR → revisão humana → cadastro).
 * O nome continua indo em courier_name; o vínculo (courierId) é gravado à parte pela tela.
 */
export function CourierPicker({ value, onChange, courierId, onSelect, carrier, onCarrier, ocrEnabled }: {
  value: string; onChange: (name: string) => void; courierId: string | null; onSelect: (id: string | null) => void;
  carrier: string; onCarrier?: (carrier: string) => void; ocrEnabled: boolean;
}) {
  const t = useTenant();
  const [hits, setHits] = useState<Hit[]>([]);
  const [typed, setTyped] = useState(false);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [review, setReview] = useState<Cnh | null>(null);
  const [img, setImg] = useState<Blob | null>(null);
  const [keepPhoto, setKeepPhoto] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);

  // Autocomplete só quando o porteiro digita (nome ou 3 primeiros dígitos do CPF).
  useEffect(() => {
    if (!typed || courierId || value.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(() => {
      rpc<Hit[]>('courier_search', { p_tenant: t.tenant.id, p_query: value.trim() }).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(id);
  }, [value, typed, courierId, t.tenant.id]);
  useEffect(() => { if (!courierId) setLinked(null); }, [courierId]);

  const pick = (h: Hit) => {
    onChange(display(h)); onSelect(h.id); setLinked(`${h.full_name}${h.document_hint ? ` · CPF ${h.document_hint}` : ''}`);
    setHits([]); setTyped(false);
    // Entregador conhecido: a transportadora habitual dele já vem escolhida.
    if (h.carrier_default && CARRIERS.includes(h.carrier_default)) onCarrier?.(h.carrier_default);
  };

  const read = async (b: Blob) => {
    setScan(false); setBusy(true); setMsg(null);
    try {
      const jpeg = await reencode(b, { max: 1600, type: 'image/jpeg', quality: 0.85 });
      setImg(jpeg);
      const r = await api<Cnh>('/api/ocr/analyze-label', { tenantId: t.tenant.id, imageBase64: await blobToDataUrl(jpeg), kind: 'cnh' });
      setReview({ ...r, cpf: r.cpf || '', cnh_number: r.cnh_number || '', full_name: r.full_name || '', category: r.category || '' });
      setMsg(r.confidence < 70 ? 'Leitura com baixa confiança: confira todos os campos com a CNH em mãos.' : 'Confira os dados com a CNH em mãos antes de confirmar.');
    } catch (e: any) {
      // Sem leitura (plano, franquia, rede): o porteiro pode digitar os dados do documento.
      setReview({ full_name: '', cpf: '', cnh_number: '', category: '', confidence: 0, alerts: [] });
      setMsg(e.message);
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!review) return;
    setBusy(true); setMsg(null);
    try {
      const c = await rpc<Hit & { created: boolean }>('courier_upsert_from_ocr', { p_tenant: t.tenant.id, p_full_name: review.full_name,
        p_cpf: review.cpf || null, p_cnh: review.cnh_number || null, p_category: review.category || null, p_carrier: carrier === 'Outra' ? null : carrier });
      pick(c);
      if (keepPhoto && img) {
        await api('/api/ocr/analyze-label', { tenantId: t.tenant.id, imageBase64: await blobToDataUrl(img), kind: 'cnh-photo', courierId: c.id })
          .catch(() => setMsg('Entregador confirmado, mas a foto do documento não foi guardada.'));
      }
      setReview(null); setImg(null); setKeepPhoto(false);
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };

  const set = (k: keyof Cnh) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setReview((r) => r && { ...r, [k]: e.target.value });

  return (
    <div className="space-y-2">
      <Field label="Nome do entregador (obrigatório)" hint="Ex.: João - Mercado Livre. Digite o nome ou os 3 primeiros dígitos do CPF para buscar.">
        <Input value={value} onChange={(e) => { onChange(e.target.value); onSelect(null); setTyped(true); }} required minLength={2} maxLength={80} autoComplete="off" />
      </Field>
      {hits.length > 0 && (
        <div className="flex flex-wrap gap-2" role="listbox" aria-label="Entregadores cadastrados">
          {hits.map((h) => (
            <button type="button" role="option" aria-selected={false} key={h.id} onClick={() => pick(h)}
              className="min-h-10 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-sm text-left">
              {display(h)}{h.document_hint && <span className="text-muted"> · {h.document_hint}</span>}
            </button>
          ))}
        </div>
      )}
      {courierId && linked && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="success">Entregador cadastrado</Badge><span className="break-all">{linked}</span>
          <button type="button" className="text-muted underline min-h-10" onClick={() => onSelect(null)}>Desvincular</button>
        </div>
      )}
      {ocrEnabled && !review && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" loading={busy} onClick={() => setScan((s) => !s)}>📷 Ler CNH do entregador (OCR)</Button>
          <DemoCnhSample onPick={read} />
        </div>
      )}
      {scan && !review && <CameraCapture onCapture={read} label="Fotografar CNH" />}
      {msg && <Alert tone={review && review.confidence >= 70 ? 'info' : 'warning'}>{msg}</Alert>}
      {review && (
        <Card className="space-y-3" aria-label="Revisão da CNH">
          <p className="font-medium text-sm">Dados da CNH (revise)</p>
          {review.alerts.length > 0 && <ul className="text-xs list-disc pl-4">{review.alerts.map((a, i) => <li key={i}>{a}</li>)}</ul>}
          <Field label="Nome na CNH"><Input value={review.full_name || ''} onChange={set('full_name')} onKeyDown={noEnter} maxLength={80} autoComplete="off" /></Field>
          <div className="grid gap-3">
            <Field label="CPF"><Input value={review.cpf || ''} onChange={set('cpf')} onKeyDown={noEnter} inputMode="numeric" maxLength={14} autoComplete="off" /></Field>
            <Field label="Nº registro da CNH"><Input value={review.cnh_number || ''} onChange={set('cnh_number')} onKeyDown={noEnter} inputMode="numeric" maxLength={11} autoComplete="off" /></Field>
            <Field label="Categoria"><Select value={review.category || ''} onChange={set('category')}>{CATS.map((c) => <option key={c} value={c}>{c || '—'}</option>)}</Select></Field>
          </div>
          {img && (
            <label className="flex items-start gap-2 text-sm min-h-11">
              <input type="checkbox" checked={keepPhoto} onChange={(e) => setKeepPhoto(e.target.checked)} className="mt-1" />
              <span>Guardar foto do documento <span className="text-muted">(opcional; só a administração com permissão acessa)</span></span>
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={confirm} loading={busy}>Confirmar entregador</Button>
            <Button type="button" variant="ghost" onClick={() => { setReview(null); setImg(null); setMsg(null); setKeepPhoto(false); }}>Descartar leitura</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
