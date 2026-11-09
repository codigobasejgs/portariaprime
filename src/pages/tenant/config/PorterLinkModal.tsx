import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Copy } from 'lucide-react';
import { rpc } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { Alert, Button, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../../components/ui';
import { useSensitive } from '../../../components/Reauth';

export function PorterLinkModal({ onClose }: { onClose: () => void }) {
  const t = useTenant();
  const [hours, setHours] = useState('24');
  const [uses, setUses] = useState('1');
  const [approval, setApproval] = useState(true);
  const [result, setResult] = useState<{ id: string; url: string; expires_at: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const { guard, dialog } = useSensitive('Gerar link de cadastro biométrico de porteiro. Confirme sua identidade.');
  const { busy, run } = useAction();

  const generate = () => run(guard(async () => {
    const r = await rpc<{ id: string; token: string; expires_at: string; slug: string }>('porter_link_create', {
      p_tenant: t.tenant.id, p_approval: approval, p_hours: Number(hours), p_uses: Number(uses)
    });
    const origin = typeof location !== 'undefined' ? location.origin : 'https://portariaprime.com.br';
    const linkUrl = `${origin}/c/${r.slug}/equipe/cadastro?t=${r.token}`;
    const qrData = await QRCode.toDataURL(linkUrl, { width: 360, margin: 2 });
    setQr(qrData);
    setResult({ id: r.id, url: linkUrl, expires_at: r.expires_at });
  }));

  const copy = () => { if (result) { navigator.clipboard.writeText(result.url); toast.success('Link copiado.'); } };

  return <Modal title="Link de cadastro de porteiro" onClose={onClose}>
    {result && qr ? <div className="space-y-4 text-center">
      <Alert tone="success">Link e QR Code gerados. Válido até {new Date(result.expires_at).toLocaleString('pt-BR')}.</Alert>
      <img src={qr} alt="QR Code de cadastro" className="mx-auto rounded-xl border border-line w-64 h-64" />
      <div className="flex gap-2">
        <Input readOnly value={result.url} onFocus={(e) => e.target.select()} />
        <Button variant="secondary" onClick={copy}><Copy className="w-4 h-4" /> Copiar</Button>
      </div>
      <p className="text-xs text-muted">O porteiro preencherá nome, documento (CPF/RG/CNH), senha e fará a captura da referência facial com termo LGPD.</p>
      <Button className="w-full" onClick={onClose}>Concluir</Button>
    </div> : <form onSubmit={(e) => { e.preventDefault(); generate(); }} className="space-y-4">
      <p className="text-sm text-muted">Gera um link com QR Code para o porteiro se cadastrar no celular dele, capturando a face de referência.</p>
      <Field label="Validade do link">
        <Select value={hours} onChange={(e) => setHours(e.target.value)}>
          <option value="12">12 horas</option>
          <option value="24">24 horas (recomendado)</option>
          <option value="48">48 horas</option>
          <option value="168">7 dias</option>
        </Select>
      </Field>
      <Field label="Limite de usos">
        <Select value={uses} onChange={(e) => setUses(e.target.value)}>
          <option value="1">1 uso (um porteiro)</option>
          <option value="5">Até 5 usos (equipe)</option>
          <option value="20">Até 20 usos</option>
        </Select>
      </Field>
      <label className="flex gap-2 items-center text-sm min-h-9">
        <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
        Exigir aprovação do síndico antes do primeiro acesso
      </label>
      <Button type="submit" loading={busy} className="w-full">Gerar link e QR Code</Button>
    </form>}
    {dialog}
  </Modal>;
}
