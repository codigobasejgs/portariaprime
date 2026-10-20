import React, { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { signedUrl } from '../../lib/files';
import { dateTime, unitName } from '../../lib/format';
import { publicLogoUrl } from '../../lib/theme';
import { useTenant } from '../../lib/tenant';
import { Alert, Button, Modal, Spinner } from '../../components/ui';

/**
 * Comprovante de retirada a partir do snapshot imutável (tabela receipts).
 * Imagens via URL assinada curta, gerada a cada abertura (só para autorizados).
 */
export function ReceiptModal({ packageId, onClose }: { packageId: string; onClose: () => void }) {
  const t = useTenant();
  const [r, setR] = useState<any>(null);
  const [img, setImg] = useState<{ sig?: string; photo?: string }>({});
  const [error, setError] = useState<string | null>(null);

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
    <Modal title="Comprovante de retirada" onClose={onClose}>
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
              <dt style={{ color: '#526174' }}>Unidade</dt><dd className="text-right font-medium">{unitName(s.unit_block, s.unit_label)}</dd>
              <dt style={{ color: '#526174' }}>Transportadora</dt><dd className="text-right">{s.carrier}</dd>
              <dt style={{ color: '#526174' }}>Rastreio</dt><dd className="text-right">{s.tracking_code || '—'}</dd>
              <dt style={{ color: '#526174' }}>Recebida em</dt><dd className="text-right">{dateTime(s.received_at, t.tenant.timezone)}</dd>
              <dt style={{ color: '#526174' }}>Retirada em</dt><dd className="text-right">{dateTime(s.picked_up_at, t.tenant.timezone)}</dd>
              <dt style={{ color: '#526174' }}>Retirada por</dt><dd className="text-right font-medium">{s.picked_up_by}</dd>
              <dt style={{ color: '#526174' }}>Entregue por</dt><dd className="text-right">{s.operator}</dd>
              <dt style={{ color: '#526174' }}>Validação</dt><dd className="text-right">{s.method === 'qr' ? 'QR Code de uso único' : 'Manual (justificada)'}</dd>
            </dl>
            {s.manual_reason && <p className="text-xs" style={{ color: '#526174' }}>Justificativa: {s.manual_reason}</p>}
            <div className="grid grid-cols-2 gap-3">
              {img.sig && <figure><img src={img.sig} alt="Assinatura" className="h-24 w-full object-contain border rounded" /><figcaption className="text-[11px] mt-1" style={{ color: '#526174' }}>Assinatura</figcaption></figure>}
              {img.photo && <figure><img src={img.photo} alt="Foto da entrega" className="h-24 w-full object-cover rounded" /><figcaption className="text-[11px] mt-1" style={{ color: '#526174' }}>Foto da entrega</figcaption></figure>}
            </div>
            <p className="text-[10px] pt-2" style={{ color: '#526174' }}>Emitido em {dateTime(r.issued_at, t.tenant.timezone)} · Tecnologia Portaria Prime</p>
          </div>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="w-4 h-4" /> Imprimir ou salvar PDF</Button>
        </div>
      )}
    </Modal>
  );
}
