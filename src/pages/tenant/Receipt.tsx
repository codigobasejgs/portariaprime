import React, { useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { api } from '../../lib/api';
import { signedUrl } from '../../lib/files';
import { dateTime, unitName } from '../../lib/format';
import { publicLogoUrl } from '../../lib/theme';
import { useTenant } from '../../lib/tenant';
import { query } from '../../lib/router';
import { Alert, Button, Modal, Spinner } from '../../components/ui';
import { PackagePhotos } from '../../components/PhotoGallery';

/** Link estável enviado nas mensagens: exige login e vínculo com a unidade (RLS). */
export function ReceiptPage() {
  const id = query('p');
  return <div className="max-w-xl space-y-4"><h1 className="text-2xl font-semibold">Comprovante de retirada</h1>
    {id && /^[0-9a-f-]{36}$/i.test(id) ? <ReceiptView packageId={id} /> : <Alert tone="danger">Link de comprovante inválido.</Alert>}</div>;
}

export function ReceiptModal({ packageId, onClose }: { packageId: string; onClose: () => void }) {
  return <Modal title="Comprovante de retirada" onClose={onClose}><ReceiptView packageId={packageId} /></Modal>;
}

/**
 * Comprovante a partir do snapshot imutável (tabela receipts): página e PDF
 * (impressão do navegador) saem do mesmo registro. Imagens via URL assinada curta.
 */
function ReceiptView({ packageId }: { packageId: string }) {
  const t = useTenant();
  const [r, setR] = useState<any>(null);
  const [img, setImg] = useState<{ sig?: string; photo?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfMsg, setPdfMsg] = useState<string | null>(null);
  // URL nova a cada clique (a anterior pode ter expirado); autorização revalidada no servidor.
  const download = async () => {
    setPdfBusy(true); setPdfMsg(null);
    try {
      const r = await api<{ status: string; url?: string }>('/api/receipts/download', { tenantId: t.tenant.id, packageId });
      if (r.status === 'ready' && r.url) window.location.assign(r.url);
      else setPdfMsg(r.status === 'failed' ? 'A geração do PDF falhou e está sendo reprocessada. Tente em alguns minutos.' : 'Entrega registrada — comprovante em processamento. Tente em instantes.');
    } catch (e: any) { setPdfMsg(e.message); } finally { setPdfBusy(false); }
  };

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('receipts').select('*').eq('tenant_id', t.tenant.id).eq('package_id', packageId).maybeSingle();
      if (error || !data) return setError('Comprovante não encontrado ou sem permissão.');
      setR(data);
      const s = data.snapshot;
      const out: any = {};
      try { if (s.signature_path) out.sig = await signedUrl(s.signature_path); } catch { /* sem acesso */ }
      try { if (s.handover_path) out.photo = await signedUrl(s.handover_path); } catch { /* sem acesso */ }
      setImg(out);
    })();
  }, [packageId, t.tenant.id]);

  const logo = publicLogoUrl(t.branding?.logo_path);
  const s = r?.snapshot;
  return (
    <>
      {error ? <Alert tone="danger">{error}</Alert> : !r ? <Spinner /> : (
        <div className="space-y-4">
          <div className="print-area rounded-xl border border-line p-4 bg-white text-[#18283A] space-y-3">
            <div className="flex items-center justify-between gap-3 border-b pb-3" style={{ borderColor: '#DED9CE' }}>
              <div className="flex items-center gap-3">
                {logo && <img src={logo} alt="" className="h-10 w-10 object-contain" />}
                <div><p className="font-semibold">{t.branding?.display_name || t.tenant.name}</p><p className="text-xs" style={{ color: '#526174' }}>Comprovante de retirada de encomenda</p></div>
              </div>
              <p className="text-xs font-mono text-right">{r.protocol}</p>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt style={{ color: '#526174' }}>Unidade</dt><dd className="text-right font-medium">{s.unit_text || unitName(s.unit_block, s.unit_label, t.unitLabels)}</dd>
              <dt style={{ color: '#526174' }}>Transportadora</dt><dd className="text-right">{s.carrier}</dd>
              <dt style={{ color: '#526174' }}>Rastreio</dt><dd className="text-right">{s.tracking_code || '—'}</dd>
              <dt style={{ color: '#526174' }}>Recebida em</dt><dd className="text-right">{dateTime(s.received_at, t.tenant.timezone)}</dd>
              {(s.received_by_name || s.courier_name) && <>
                <dt style={{ color: '#526174' }}>Recebido na portaria por</dt>
                <dd className="text-right">{s.received_by_name || '—'}{s.courier_name ? ` (Entregador: ${s.courier_name})` : ''}</dd>
              </>}
              <dt style={{ color: '#526174' }}>Retirada em</dt><dd className="text-right">{dateTime(s.picked_up_at, t.tenant.timezone)}</dd>
              <dt style={{ color: '#526174' }}>Retirada por</dt><dd className="text-right font-medium">{s.picked_up_by}</dd>
              {s.recipient_kind && <><dt style={{ color: '#526174' }}>Relação</dt><dd className="text-right">{s.recipient_kind === 'autorizado' ? 'Recebedor autorizado' : 'Morador'}</dd></>}
              {s.storage && <><dt style={{ color: '#526174' }}>Retirada de</dt><dd className="text-right">{s.storage}</dd></>}
              <dt style={{ color: '#526174' }}>Entregue ao morador por</dt><dd className="text-right">{s.operator}</dd>
              <dt style={{ color: '#526174' }}>Validação</dt><dd className="text-right">{s.method === 'qr' ? 'QR Code de uso único' : 'Manual (justificada)'}</dd>
            </dl>
            {s.manual_reason && <p className="text-xs" style={{ color: '#526174' }}>Justificativa: {s.manual_reason}</p>}
            {r.verify_code && <p className="text-xs" style={{ color: '#526174' }}>Código de verificação: <span className="font-mono" data-verify-code>{r.verify_code}</span> · confira em {location.origin}/validar</p>}
            <div className="grid grid-cols-2 gap-3">
              {img.sig && <figure><img src={img.sig} alt="Assinatura" className="h-24 w-full object-contain border rounded" /><figcaption className="text-[11px] mt-1" style={{ color: '#526174' }}>Assinatura</figcaption></figure>}
              {img.photo && <figure><img src={img.photo} alt="Foto do item entregue" className="h-24 w-full object-cover rounded" /><figcaption className="text-[11px] mt-1" style={{ color: '#526174' }}>Foto do item entregue</figcaption></figure>}
            </div>
            <PackagePhotos packageId={packageId} />{/* RLS: equipe ou morador da unidade */}
            <p className="text-[10px] pt-2" style={{ color: '#526174' }}>Emitido em {dateTime(r.issued_at, t.tenant.timezone)} · Tecnologia Portaria Prime</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => download()} loading={pdfBusy}><Download className="w-4 h-4" /> Baixar PDF</Button>
            <Button variant="secondary" onClick={() => window.print()}><Printer className="w-4 h-4" /> Imprimir</Button>
          </div>
          {pdfMsg && <Alert tone="info">{pdfMsg}</Alert>}
        </div>
      )}
    </>
  );
}
