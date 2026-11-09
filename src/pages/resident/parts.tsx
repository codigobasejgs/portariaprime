import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight, Clock, Download, FileText, PackageX, QrCode, RefreshCw, WifiOff } from 'lucide-react';
import { api, rpc } from '../../lib/api';
import { useRealtime, useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { onLink } from '../../lib/router';
import { dateTime, unitName } from '../../lib/format';
import { Alert, Badge, Button, Modal } from '../../components/ui';
import { QRCodeDisplay } from '../../components/VisualCodes';

export interface ResidentPackage {
  id: string; ref: string; status: string; carrier: string; tracking_code: string | null; recipient_name: string | null;
  unit_id: string; unit_block: string | null; unit_label: string;
  received_at: string; stored_at: string | null; picked_up_at: string | null; picked_up_by_name: string | null; resolved_at: string | null;
  courier_name?: string | null; received_by_name?: string | null;
  concierge_name: string | null; receipt: { protocol: string; pdf_status: 'pending' | 'processing' | 'ready' | 'failed' } | null;
  timeline?: { kind: string; at: string }[];
  rejected_at?: string | null; rejection_reason?: string | null; rejection_note?: string | null;
}

export const REJECT_REASONS: [string, string][] = [['wrong_unit', 'Não é desta unidade'], ['cancelled', 'Compra cancelada'], ['other', 'Outro']];

/** Aviso de recusa já registrada: QR desativado, portaria devolve. */
export function RejectedNote({ p }: { p: ResidentPackage }) {
  if (!p.rejected_at) return null;
  const why = REJECT_REASONS.find(([v]) => v === p.rejection_reason)?.[1] || 'Outro';
  return <Alert tone="danger">🚫 Você recusou esta encomenda ({why}{p.rejection_note ? `: ${p.rejection_note}` : ''}). O QR de retirada foi desativado e a portaria fará a devolução.</Alert>;
}

/** Botão + modal "Recusar encomenda": só morador ativo da unidade (validado no servidor), idempotente. */
export function RejectButton({ p, onDone }: { p: ResidentPackage; onDone: () => void }) {
  const t = useTenant();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (p.rejected_at || !WAITING.includes(p.status)) return null;
  const ok = reason && (reason !== 'other' || note.trim().length >= 3);
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      await rpc('resident_reject_package', { p_tenant: t.tenant.id, p_package: p.id, p_reason: reason, p_note: note.trim() || null });
      setOpen(false); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <Button variant="ghost" className="w-full sm:w-auto whitespace-nowrap text-danger" onClick={() => setOpen(true)}>🚫 Recusar encomenda</Button>
      {open && (
        <Modal title="Recusar encomenda" onClose={() => setOpen(false)}>
          <div className="space-y-4">
            <p className="text-sm">{pkgTitle(p)}. A portaria será avisada e fará a devolução. O QR de retirada deixa de funcionar.</p>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium mb-1">Motivo</legend>
              {REJECT_REASONS.map(([v, l]) => (
                <label key={v} className="flex items-center gap-2 min-h-11 rounded-xl border border-line px-3 cursor-pointer">
                  <input type="radio" name="reject-reason" value={v} checked={reason === v} onChange={() => setReason(v)} /> {l}
                </label>
              ))}
            </fieldset>
            {reason === 'other' && (
              <label className="block text-sm space-y-1"><span className="font-medium">Descreva o motivo</span>
                <textarea className="w-full rounded-xl border border-line bg-surface p-2" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            )}
            {err && <Alert tone="danger">{err}</Alert>}
            <Button variant="danger" className="w-full" disabled={!ok} loading={busy} onClick={go}>Confirmar recusa</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface Keyword { id: string; unit_id: string; unit_block: string | null; unit_label: string; keyword: string; carrier: string | null; recipient_name: string | null;
  note: string | null; valid_until: string | null; expires_at: string | null; status: 'active' | 'used' | 'cancelled'; created_at: string }
const KW_STATUS: Record<string, [string, 'accent' | 'success' | 'neutral']> = { active: ['Ativa', 'accent'], used: ['Utilizada', 'success'], cancelled: ['Cancelada', 'neutral'] };

/** Palavra-chave de entrega: visível só para a própria unidade e a equipe do condomínio (RLS). */
export function KeywordCard({ units, unit }: { units: { id: string; block: string | null; label: string }[]; unit: string | null }) {
  const t = useTenant();
  const [rows, setRows] = useState<Keyword[] | null>(null);
  const [edit, setEdit] = useState<(Partial<Keyword> & { until?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => rpc<Keyword[]>('list_delivery_keywords', { p_tenant: t.tenant.id, p_unit: unit }).then(setRows).catch(() => setRows([])), [t.tenant.id, unit]);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      // ponytail: datetime-local no fuso do aparelho; servidor valida instante futuro.
      await rpc('delivery_keyword_save_v2', { p_tenant: t.tenant.id, p_id: edit!.id || null, p_unit: edit!.unit_id || null, p_keyword: (edit!.keyword || '').trim(),
        p_carrier: edit!.carrier?.trim() || null, p_recipient: edit!.recipient_name?.trim() || null, p_note: edit!.note?.trim() || null,
        p_expires_at: edit!.until ? new Date(edit!.until).toISOString() : null });
      setEdit(null); void load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const act = async (fn: string, k: Keyword) => {
    try { await rpc(fn, { p_tenant: t.tenant.id, p_id: k.id }); void load(); } catch (e: any) { setErr(e.message); }
  };
  const local = (iso: string | null) => iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  if (!units.length) return null;
  const set = (k: keyof Keyword) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setEdit({ ...edit!, [k]: e.target.value });
  const inp = 'w-full rounded-xl border border-line bg-surface px-3 min-h-11';
  return (
    <section className="space-y-2 rounded-2xl border border-line bg-surface p-4" aria-label="Palavra-chave de entrega">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">🔑 Palavra-chave de entrega</h2>
        <Button variant="secondary" onClick={() => { setErr(null); setEdit({ unit_id: unit || units[0].id }); }}>🔑 Informar palavra-chave de entrega</Button>
      </div>
      <p className="text-xs text-muted">Para entregas que pedem código (iFood, mercado, farmácia). Só você e a portaria veem.</p>
      {rows && rows.length > 0 && (
        <ul className="divide-y divide-line">
          {rows.map((k) => (
            <li key={k.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0"><strong className="text-base">{k.keyword}</strong>{k.carrier ? ` · ${k.carrier}` : ''}{units.length > 1 ? ` · ${unitName(k.unit_block, k.unit_label, t.unitLabels)}` : ''}
                {k.expires_at ? <span className="text-muted"> · até {dateTime(k.expires_at, t.tenant.timezone)}</span>
                  : k.valid_until ? <span className="text-muted"> · até {k.valid_until.split('-').reverse().join('/')}</span> : null}</span>
              <span className="flex items-center gap-2"><Badge tone={KW_STATUS[k.status][1]}>{KW_STATUS[k.status][0]}</Badge>
                {k.status === 'active' && <><button className="underline min-h-10" onClick={() => { setErr(null); setEdit({ ...k, until: local(k.expires_at) }); }}>Editar</button>
                  <button className="underline min-h-10" onClick={() => act('delivery_keyword_mark_used', k)}>Já recebi</button>
                  <button className="underline min-h-10 text-danger" onClick={() => act('delivery_keyword_cancel', k)}>Cancelar</button></>}</span>
            </li>
          ))}
        </ul>
      )}
      {err && !edit && <Alert tone="danger">{err}</Alert>}
      {edit && (
        <Modal title={edit.id ? 'Editar palavra-chave' : 'Informar palavra-chave de entrega'} onClose={() => setEdit(null)}>
          <div className="space-y-3 text-sm">
            {!edit.id && units.length > 1 && <label className="block space-y-1"><span className="font-medium">Unidade</span>
              <select className={inp} value={edit.unit_id} onChange={set('unit_id')}>{units.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}</select></label>}
            <label className="block space-y-1"><span className="font-medium">Palavra-chave</span><input className={inp} maxLength={60} value={edit.keyword || ''} onChange={set('keyword')} autoFocus /></label>
            <label className="block space-y-1"><span className="font-medium">Loja / aplicativo (opcional)</span><input className={inp} maxLength={40} value={edit.carrier || ''} onChange={set('carrier')} /></label>
            <label className="block space-y-1"><span className="font-medium">Em nome de (opcional)</span><input className={inp} maxLength={120} value={edit.recipient_name || ''} onChange={set('recipient_name')} /></label>
            <label className="block space-y-1"><span className="font-medium">Observação (opcional)</span><input className={inp} maxLength={300} value={edit.note || ''} onChange={set('note')} /></label>
            <label className="block space-y-1"><span className="font-medium">Válida até (opcional, ex.: hoje 18:00)</span><input type="datetime-local" className={inp} value={edit.until || ''} onChange={(e) => setEdit({ ...edit, until: e.target.value })} /></label>
            {err && <Alert tone="danger">{err}</Alert>}
            <Button className="w-full" disabled={(edit.keyword || '').trim().length < 2} loading={busy} onClick={save}>Salvar palavra-chave</Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export const WAITING = ['RECEBIDA', 'ARMAZENADA'];
/** Situação em texto para o morador (nunca só cor). */
export const RES_STATUS: Record<string, [string, 'accent' | 'success' | 'warning' | 'danger' | 'neutral']> = {
  RECEBIDA: ['Aguardando retirada', 'accent'], ARMAZENADA: ['Aguardando retirada', 'accent'], RETIRADA: ['Retirada', 'success'],
  DEVOLVIDA: ['Devolvida ao remetente', 'neutral'], CANCELADA: ['Registro cancelado', 'neutral'], EXTRAVIADA: ['Extraviada', 'danger'],
};
/** Explicação das exceções: o que aconteceu e o que fazer. */
export const EXCEPTION_TEXT: Record<string, string> = {
  DEVOLVIDA: 'A portaria devolveu esta encomenda ao remetente. Não há retirada. Em caso de dúvida, fale com a portaria.',
  CANCELADA: 'Este registro foi cancelado pela portaria (por exemplo, cadastro feito por engano). Não há retirada.',
  EXTRAVIADA: 'A portaria registrou esta encomenda como extraviada. Procure a portaria ou a administração.',
};

export const pkgTitle = (p: ResidentPackage) => `${p.carrier} · #${p.ref}`;

export function StatusBadge({ status }: { status: string }) {
  const [l, tone] = RES_STATUS[status] || [status, 'neutral'];
  return <Badge tone={tone}>{l}</Badge>;
}

/** Cartão de encomenda aguardando: identificação, recebimento explícito, ação principal QR. */
export function WaitingCard({ p, multiUnit, onQr, onChange }: { p: ResidentPackage; multiUnit: boolean; onQr: () => void; onChange?: () => void }) {
  const t = useTenant();
  const href = `/c/${t.tenant.slug}/encomenda?p=${p.id}`;
  return (
    <li className={`rounded-2xl border bg-surface p-4 space-y-3 ${p.rejected_at ? 'border-danger' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{p.carrier} <span className="text-muted font-normal">#{p.ref}</span></p>
          {p.tracking_code && <p className="text-xs text-muted break-all">Rastreio {p.tracking_code}</p>}
        </div>
        <StatusBadge status={p.status} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted">Chegou em</dt><dd>{dateTime(p.received_at, t.tenant.timezone)}</dd>
        {p.recipient_name && <><dt className="text-muted">Para</dt><dd className="break-words">{p.recipient_name}</dd></>}
        {multiUnit && <><dt className="text-muted">Unidade</dt><dd>{unitName(p.unit_block, p.unit_label, t.unitLabels)}</dd></>}
        {p.concierge_name && <><dt className="text-muted">Retirar em</dt><dd>{p.concierge_name}</dd></>}
      </dl>
      <RejectedNote p={p} />
      <div className="flex flex-col sm:flex-row gap-2">
        {!p.rejected_at && <Button onClick={onQr} className="w-full sm:w-auto whitespace-nowrap" data-tour="morador-qr"><QrCode className="w-4 h-4" aria-hidden /> Mostrar QR de retirada</Button>}
        <RejectButton p={p} onDone={() => onChange?.()} />
        <a href={href} onClick={onLink} className="inline-flex items-center justify-center gap-1 rounded-xl px-4 min-h-11 text-sm font-semibold hover:bg-surface-2">Ver detalhes <ChevronRight className="w-4 h-4" aria-hidden /></a>
      </div>
    </li>
  );
}

/** Linha do histórico: datas rotuladas, situação em texto, comprovante quando existir. */
export function HistoryItem({ p }: { p: ResidentPackage }) {
  const t = useTenant();
  return (
    <li>
      <a href={`/c/${t.tenant.slug}/encomenda?p=${p.id}`} onClick={onLink} className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2">
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{p.carrier} <span className="text-muted font-normal">#{p.ref}</span></span><StatusBadge status={p.status} /></span>
          <span className="block text-sm text-muted">Chegou em {dateTime(p.received_at, t.tenant.timezone)}</span>
          {p.picked_up_at && <span className="block text-sm">Retirada em {dateTime(p.picked_up_at, t.tenant.timezone)}{p.picked_up_by_name ? ` por ${p.picked_up_by_name}` : ''}</span>}
          {p.receipt && <span className="flex items-center gap-1 text-xs text-muted"><FileText className="w-3 h-3" aria-hidden />{p.receipt.pdf_status === 'ready' ? 'Comprovante disponível' : p.receipt.pdf_status === 'failed' ? 'Comprovante com falha na geração' : 'Comprovante em processamento'}</span>}
        </span>
        <ChevronRight className="w-5 h-5 text-muted shrink-0 mt-0.5" aria-hidden />
      </a>
    </li>
  );
}

/**
 * QR de retirada em tela dedicada. Token só em memória; validade do servidor;
 * a tela acompanha a encomenda em tempo real e se fecha sozinha ao ser retirada.
 */
export function QrSheet({ p, onClose }: { p: ResidentPackage; onClose: () => void }) {
  const t = useTenant();
  const [qr, setQr] = useState<{ token: string; expires: string } | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'expired' | 'gone' | 'offline' | 'error'>('loading');
  const [msg, setMsg] = useState('');
  const [now, setNow] = useState(Date.now());
  const issued = useRef(false);

  const issue = useCallback(async () => {
    setState('loading');
    if (!navigator.onLine) { setQr(null); setState('offline'); return; }
    try {
      const r = await rpc<{ token: string; expires_at: string }>('issue_pickup_token', { p_tenant: t.tenant.id, p_package: p.id });
      setQr({ token: r.token, expires: r.expires_at }); setState('ok');
    } catch (e: any) {
      setQr(null);
      if (/não está disponível/i.test(e.message)) setState('gone');
      else if (!navigator.onLine) setState('offline');
      else { setMsg(e.message); setState('error'); }
    }
  }, [p.id, t.tenant.id]);
  useEffect(() => { if (!issued.current) { issued.current = true; void issue(); } }, [issue]);

  // Retirada por outra pessoa / mudança de estado: confere a encomenda e invalida o QR mostrado.
  const check = useCallback(async () => {
    try {
      const cur = await rpc<ResidentPackage>('resident_package', { p_tenant: t.tenant.id, p_package: p.id });
      if (!WAITING.includes(cur.status)) { setQr(null); setState('gone'); }
    } catch { setQr(null); setState('gone'); }
  }, [p.id, t.tenant.id]);
  useRealtime('packages', t.tenant.id, check);
  useRefreshWhileVisible(check, 5000); // QR aberto na portaria: confirma o estado a cada poucos segundos
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15000);
    const off = () => setState((s) => (s === 'ok' ? 'offline' : s));
    addEventListener('offline', off);
    return () => { clearInterval(tick); removeEventListener('offline', off); };
  }, []);
  useEffect(() => { if (state === 'ok' && qr && new Date(qr.expires).getTime() <= now) setState('expired'); }, [now, qr, state]);

  const name = t.branding?.display_name || t.tenant.name;
  return (
    <Modal title="QR de retirada" onClose={onClose}>
      <div className="space-y-4 text-center">
        <div>
          <p className="font-semibold">{name}</p>
          <p className="text-sm text-muted">{unitName(p.unit_block, p.unit_label, t.unitLabels)} · {pkgTitle(p)}</p>
        </div>
        {state === 'ok' && qr ? (
          <>
            {/* Fundo branco fixo e margem para leitura em qualquer tema. */}
            <div className="mx-auto w-fit" data-qr>
              <QRCodeDisplay value={qr.token} size={Math.min(280, Math.max(200, innerWidth - 112))} className="shadow-none" />
            </div>
            <p className="text-base">Apresente este código à portaria para retirar sua encomenda.</p>
            <p className="text-sm text-muted flex items-center justify-center gap-1"><Clock className="w-4 h-4" aria-hidden /> Válido até {dateTime(qr.expires, t.tenant.timezone)}. Uso único.</p>
            <p className="text-xs text-muted">A retirada só é concluída quando a portaria confirma a entrega com assinatura. Não envie este código em grupos.</p>
          </>
        ) : state === 'loading' ? <p className="py-16 text-muted" role="status">Gerando código…</p>
          : state === 'gone' ? <div className="py-6 space-y-2"><CheckCircle2 className="w-10 h-10 mx-auto text-success" aria-hidden /><p className="font-semibold">Esta encomenda não está mais aguardando retirada.</p><p className="text-sm text-muted">Ela pode ter sido retirada por outra pessoa da unidade. Confira os detalhes e o comprovante.</p>
            <a href={`/c/${t.tenant.slug}/encomenda?p=${p.id}`} onClick={(e) => { onLink(e); onClose(); }} className="inline-flex min-h-11 items-center underline">Ver detalhes</a></div>
          : state === 'expired' ? <div className="py-6 space-y-3"><p className="font-semibold">Este código venceu.</p><Button onClick={issue}><RefreshCw className="w-4 h-4" aria-hidden /> Gerar novo código</Button></div>
          : state === 'offline' ? <div className="py-6 space-y-3"><WifiOff className="w-8 h-8 mx-auto text-muted" aria-hidden /><p className="font-semibold">Sem conexão.</p><p className="text-sm text-muted">Não foi possível confirmar se o código ainda vale. Conecte-se e tente de novo, ou peça para a portaria localizar a encomenda pela sua unidade.</p><Button variant="secondary" onClick={issue}>Tentar novamente</Button></div>
          : <div className="py-6 space-y-3"><Alert tone="danger">{msg || 'Não foi possível gerar o código.'}</Alert><Button variant="secondary" onClick={issue}>Tentar novamente</Button></div>}
        {state === 'ok' && <Button variant="ghost" onClick={issue}><RefreshCw className="w-4 h-4" aria-hidden /> Gerar novo código</Button>}
        <p className="text-xs text-muted">Sem celular? A portaria pode localizar a encomenda pela sua unidade e conferir sua identidade.</p>
      </div>
    </Modal>
  );
}

/** Ações do comprovante conforme o estado real do PDF (sem botão quebrado). */
export function ReceiptActions({ p }: { p: ResidentPackage }) {
  const t = useTenant();
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!p.receipt) return p.status === 'RETIRADA'
    ? <p className="text-sm text-muted">O comprovante desta retirada não está disponível para o seu cadastro (por exemplo, quando você entrou na unidade depois da entrega).</p> : null;
  const open = async () => {
    setBusy(true); setMsg(null);
    // Janela aberta no próprio toque (navegadores bloqueiam pop-up depois de um await).
    const win = window.open('', '_blank');
    try {
      // URL temporária nova a cada clique; autorização revalidada no servidor.
      const r = await api<{ status: string; url?: string }>('/api/receipts/download', { tenantId: t.tenant.id, packageId: p.id });
      if (r.status === 'ready' && r.url) {
        setUrl(r.url);
        if (win) { win.opener = null; win.location.href = r.url; } else window.location.assign(r.url);
        return;
      }
      win?.close();
      setMsg(r.status === 'failed' ? 'A geração do PDF falhou. O sistema tenta de novo automaticamente; se continuar, avise a portaria.' : 'O comprovante ainda está sendo gerado. Tente em instantes.');
    } catch (e: any) { win?.close(); setMsg(e.message); } finally { setBusy(false); }
  };
  const st = p.receipt.pdf_status;
  return (
    <div className="space-y-2" data-tour="morador-comprovante">
      <p className="text-sm">Protocolo <span className="font-mono">{p.receipt.protocol}</span></p>
      {st === 'ready' ? <Button onClick={open} loading={busy}><FileText className="w-4 h-4" aria-hidden /> Ver comprovante</Button>
        : st === 'failed' ? <Alert tone="warning">A geração do PDF falhou. O sistema tenta novamente; se continuar, avise a portaria.</Alert>
        : <p className="text-sm text-muted flex items-center gap-2"><Clock className="w-4 h-4" aria-hidden /> Comprovante em processamento. Volte em instantes.</p>}
      {url && <p className="text-xs text-muted">Não abriu? <a href={url} target="_blank" rel="noopener" className="underline inline-flex items-center gap-1"><Download className="w-3 h-3" aria-hidden />Baixar o PDF</a> (link válido por 5 minutos).</p>}
      {msg && <Alert tone="info">{msg}</Alert>}
    </div>
  );
}

export function ExceptionNote({ status }: { status: string }) {
  if (!EXCEPTION_TEXT[status]) return null;
  return <div className="flex gap-2 rounded-xl bg-surface-2 p-3 text-sm"><PackageX className="w-4 h-4 mt-0.5 shrink-0" aria-hidden /><span>{EXCEPTION_TEXT[status]}</span></div>;
}
