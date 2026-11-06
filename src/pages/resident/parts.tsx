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
export function WaitingCard({ p, multiUnit, onQr }: { p: ResidentPackage; multiUnit: boolean; onQr: () => void }) {
  const t = useTenant();
  const href = `/c/${t.tenant.slug}/encomenda?p=${p.id}`;
  return (
    <li className="rounded-2xl border border-line bg-surface p-4 space-y-3">
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
      <div className="flex flex-col sm:flex-row gap-2">
        <Button onClick={onQr} className="w-full sm:w-auto whitespace-nowrap" data-tour="morador-qr"><QrCode className="w-4 h-4" aria-hidden /> Mostrar QR de retirada</Button>
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
