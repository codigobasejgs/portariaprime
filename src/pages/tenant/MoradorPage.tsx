import React, { useCallback, useEffect, useState } from 'react';
import { FileText, QrCode, RefreshCw, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { rpc } from '../../lib/api';
import { useRealtime, useTenant } from '../../lib/tenant';
import { listPackages, PackageRow } from '../../lib/packages';
import { dateTime, STATUS_LABEL, unitName } from '../../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Spinner, toast, useAction } from '../../components/ui';
import { QRCodeDisplay } from '../../components/VisualCodes';
import { ReceiptModal } from './Receipt';
import { PushToggle } from '../../components/PushToggle';

export function MoradorPage() {
  const t = useTenant();
  const [rows, setRows] = useState<PackageRow[] | null>(null);
  const [qr, setQr] = useState<{ pkg: PackageRow; token: string; expires: string } | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    try { setRows(await listPackages(t.tenant.id, { limit: 100 })); } catch (e: any) { toast.error(e.message); }
  }, [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  useRealtime('packages', t.tenant.id, load);

  // QR só em memória (nunca em localStorage/cache).
  const openQr = (pkg: PackageRow) => run(async () => {
    const r = await rpc<{ token: string; expires_at: string }>('issue_pickup_token', { p_tenant: t.tenant.id, p_package: pkg.id });
    setQr({ pkg, token: r.token, expires: r.expires_at });
  });

  const waiting = (rows || []).filter((p) => ['RECEBIDA', 'ARMAZENADA'].includes(p.status));
  const history = (rows || []).filter((p) => !['RECEBIDA', 'ARMAZENADA'].includes(p.status));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Minhas encomendas</h1>
      <PushToggle />
      <Card>
        <p className="font-semibold mb-2">Para retirar ({waiting.length})</p>
        {!rows ? <Spinner /> : waiting.length === 0 ? <Empty title="Nenhuma encomenda aguardando">Você será avisado quando algo chegar.</Empty> : (
          <ul className="divide-y divide-line">
            {waiting.map((p) => (
              <li key={p.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{p.carrier} <span className="text-muted font-normal">· {unitName(p.unit_block, p.unit_label)}</span></p>
                  <p className="text-xs text-muted">{p.tracking_code || 'sem rastreio'} · chegou {dateTime(p.received_at, t.tenant.timezone)}</p>
                </div>
                <Button onClick={() => openQr(p)} loading={busy}><QrCode className="w-4 h-4" /> Mostrar QR de retirada</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <p className="font-semibold mb-2">Histórico</p>
        {history.length === 0 ? <Empty title="Sem histórico ainda" /> : (
          <ul className="divide-y divide-line">
            {history.map((p) => (
              <li key={p.id} className="py-2 flex flex-wrap justify-between gap-2 text-sm">
                <span>{p.carrier} · {p.tracking_code || '—'} · {dateTime(p.received_at, t.tenant.timezone)}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={p.status === 'RETIRADA' ? 'success' : 'neutral'}>{STATUS_LABEL[p.status]}</Badge>
                  {p.status === 'RETIRADA' && <button className="text-secondary underline inline-flex items-center gap-1" onClick={() => setReceipt(p.id)}><FileText className="w-3 h-3" />Comprovante</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ContactsCard />
      {qr && (
        <Modal title="QR Code de retirada" onClose={() => setQr(null)}>
          <div className="text-center space-y-3">
            <QRCodeDisplay value={qr.token} size={240} />
            <p className="text-sm">{qr.pkg.carrier} · {qr.pkg.tracking_code || 'sem rastreio'}</p>
            <p className="text-xs text-muted">Válido até {dateTime(qr.expires, t.tenant.timezone)}. Uso único — não compartilhe em grupos.</p>
            <Button variant="secondary" onClick={() => openQr(qr.pkg)}><RefreshCw className="w-4 h-4" /> Gerar novo QR</Button>
          </div>
        </Modal>
      )}
      {receipt && <ReceiptModal packageId={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

/** Contatos e preferências da unidade (cada familiar com seu telefone/e-mail). */
function ContactsCard() {
  const t = useTenant();
  const [rows, setRows] = useState<any[] | null>(null);
  const [units, setUnits] = useState<{ unit_id: string }[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const { busy, run } = useAction();
  const load = useCallback(async () => {
    const [{ data: c }, { data: u }] = await Promise.all([
      supabase.from('resident_contacts').select('*').eq('tenant_id', t.tenant.id).eq('active', true).order('created_at'),
      supabase.from('unit_memberships').select('unit_id').eq('tenant_id', t.tenant.id).eq('status', 'active'),
    ]);
    setRows(c || []);
    setUnits(u || []);
  }, [t.tenant.id]);
  useEffect(() => { load(); }, [load]);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const phone = form.phone.replace(/\D/g, '');
    run(async () => {
      if (phone && (phone.length < 10 || phone.length > 13)) throw new Error('Telefone com DDD, só números (10 a 13 dígitos).');
      const { error } = await supabase.from('resident_contacts').insert({
        tenant_id: t.tenant.id, unit_id: units[0]?.unit_id, name: form.name.trim(),
        phone: phone ? (phone.startsWith('55') ? phone : `55${phone}`) : null, email: form.email.trim().toLowerCase() || null,
      });
      if (error) throw new Error('Não foi possível salvar o contato.');
      setForm({ name: '', phone: '', email: '' });
      await load();
    }, 'Contato adicionado.');
  };
  const toggle = (c: any, field: 'notify_whatsapp' | 'notify_email') => run(async () => {
    const { error } = await supabase.from('resident_contacts').update({ [field]: !c[field] }).eq('id', c.id);
    if (error) throw new Error('Não foi possível salvar.');
    await load();
  });
  const remove = (c: any) => run(async () => {
    const { error } = await supabase.from('resident_contacts').update({ active: false }).eq('id', c.id);
    if (error) throw new Error('Não foi possível remover.');
    await load();
  });

  if (!rows) return null;
  return (
    <Card className="space-y-3">
      <p className="font-semibold">Quem recebe os avisos da unidade</p>
      {!t.overview?.entitlements?.feature_whatsapp && <Alert tone="info">WhatsApp não está incluído no plano do condomínio; os avisos chegam no app e por e-mail.</Alert>}
      <ul className="divide-y divide-line">
        {rows.map((c) => (
          <li key={c.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{c.name}{c.phone ? ` · +${c.phone}` : ''}{c.email ? ` · ${c.email}` : ''}</span>
            <span className="flex items-center gap-3">
              {c.phone && <label className="flex items-center gap-1"><input type="checkbox" checked={c.notify_whatsapp} onChange={() => toggle(c, 'notify_whatsapp')} /> WhatsApp</label>}
              {c.email && <label className="flex items-center gap-1"><input type="checkbox" checked={c.notify_email} onChange={() => toggle(c, 'notify_email')} /> E-mail</label>}
              <button onClick={() => remove(c)} aria-label={`Remover ${c.name}`} className="p-2 text-muted hover:text-danger"><Trash2 className="w-4 h-4" /></button>
            </span>
          </li>
        ))}
      </ul>
      {units.length > 0 && (
        <form onSubmit={add} className="grid sm:grid-cols-4 gap-2 items-end">
          <Field label="Nome"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="WhatsApp (com DDD)"><Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="E-mail"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Button type="submit" variant="secondary" loading={busy}>Adicionar</Button>
        </form>
      )}
    </Card>
  );
}

export function AvisosPage() {
  const t = useTenant();
  const [rows, setRows] = useState<any[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from('notifications').select('*').eq('tenant_id', t.tenant.id).order('created_at', { ascending: false }).limit(100);
    setRows(data || []);
  }, [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  useRealtime('notifications', t.tenant.id, load);
  const readAll = async () => {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('tenant_id', t.tenant.id).is('read_at', null);
    load();
  };
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center"><h1 className="text-2xl font-semibold">Avisos</h1><Button variant="ghost" onClick={readAll}>Marcar todos como lidos</Button></div>
      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nenhum aviso" /> : (
          <ul className="divide-y divide-line">
            {rows.map((n) => (
              <li key={n.id} className={`py-3 ${n.read_at ? 'opacity-70' : ''}`}>
                <p className="font-medium">{n.title}</p>
                <p className="text-sm text-muted">{n.body}</p>
                <p className="text-xs text-muted mt-1">{dateTime(n.created_at, t.tenant.timezone)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
