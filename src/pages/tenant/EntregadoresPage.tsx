import React, { useEffect, useState } from 'react';
import { api, rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { dateTime, STATUS_LABEL, unitName } from '../../lib/format';
import { Alert, Badge, Button, Card, Empty, Modal, Spinner, toast } from '../../components/ui';

interface Courier {
  id: string; full_name: string; document_masked: string | null; has_cnh: boolean; cnh_category: string | null; has_photo: boolean;
  carriers: string[]; deliveries: number; last_delivery: string | null;
}
interface Delivery { package_id: string; received_at: string; carrier: string; status: string; received_by_name: string | null; unit_block: string | null; unit_label: string }
interface Revealed { document_number: string | null; cnh_number: string | null; cnh_category: string | null }

/**
 * Entregadores cadastrados pela portaria (leitura da CNH). Documento sempre mascarado;
 * o número completo só sai com justificativa, por quem aprova moradores ou gerencia a equipe, e fica na auditoria.
 */
export function EntregadoresPage() {
  const t = useTenant();
  const tz = t.tenant.timezone;
  const [rows, setRows] = useState<Courier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, Revealed>>({});
  const [open, setOpen] = useState<{ c: Courier; items: Delivery[] | null; more: boolean } | null>(null);
  const [photo, setPhoto] = useState<{ name: string; url: string } | null>(null);
  const canReveal = t.can('approve') || t.can('team');

  useEffect(() => { rpc<Courier[]>('couriers_list', { p_tenant: t.tenant.id }).then(setRows).catch((e) => setError(e.message)); }, [t.tenant.id]);

  const askReason = (what: string) => {
    const reason = prompt(`Motivo para ver ${what} (fica registrado na auditoria):`)?.trim();
    if (reason && reason.length < 10) { toast.error('Informe um motivo com pelo menos 10 caracteres.'); return null; }
    return reason || null;
  };

  const reveal = async (c: Courier) => {
    const reason = askReason(`o documento completo de ${c.full_name}`);
    if (!reason) return;
    try {
      const r = await rpc<Revealed>('courier_reveal_document', { p_tenant: t.tenant.id, p_courier: c.id, p_reason: reason });
      setShown((s) => ({ ...s, [c.id]: r }));
    }
    catch (e: any) { toast.error(e.message); }
  };

  // URL assinada de 60 s, gerada depois que o servidor autoriza e audita; não fica guardada.
  const viewPhoto = async (c: Courier) => {
    const reason = askReason(`a foto do documento de ${c.full_name}`);
    if (!reason) return;
    try {
      const r = await api<{ url: string }>('/api/ocr/analyze-label', { tenantId: t.tenant.id, kind: 'cnh-photo-view', courierId: c.id, reason });
      setPhoto({ name: c.full_name, url: r.url });
    }
    catch (e: any) { toast.error(e.message); }
  };

  const PAGE = 100;
  const load = (c: Courier, prev: Delivery[] = []) => {
    const last = prev.at(-1);
    rpc<Delivery[]>('courier_deliveries', { p_tenant: t.tenant.id, p_courier: c.id, p_limit: PAGE,
      ...(last && { p_cursor_at: last.received_at, p_cursor_id: last.package_id }) })
      .then((page) => setOpen((o) => (o?.c.id === c.id ? { c, items: [...prev, ...page], more: page.length === PAGE } : o)))
      .catch((e) => { if (!prev.length) setOpen(null); toast.error(e.message); });
  };
  const show = (c: Courier) => { setOpen({ c, items: null, more: false }); load(c); };

  if (error) return <Alert tone="danger">{error}</Alert>;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Entregadores</h1>
        <p className="text-sm text-muted">Cadastrados pela portaria a partir da CNH. O documento aparece mascarado; ver o número completo exige motivo e fica na auditoria.</p>
      </div>
      {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nenhum entregador cadastrado. A portaria cadastra ao ler a CNH no recebimento." /> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {rows.map((c) => (
            <li key={c.id}><Card className="space-y-2 h-full">
              <button type="button" className="text-left font-semibold underline-offset-2 hover:underline break-words min-h-10" onClick={() => show(c)}
                aria-label={`Ver entregas de ${c.full_name}`}>{c.full_name}</button>
              <p className="text-sm break-all">
                CPF {shown[c.id]?.document_number || c.document_masked || 'não informado'}
                {shown[c.id]?.cnh_number && <> · CNH {shown[c.id].cnh_number}</>}
                {c.cnh_category && <> · Cat. {c.cnh_category}</>}
              </p>
              <div className="flex flex-wrap gap-1">{c.carriers.map((x) => <Badge key={x}>{x}</Badge>)}{c.has_photo && <Badge tone="accent">Foto do documento guardada</Badge>}</div>
              <p className="text-sm text-muted">{c.deliveries} {c.deliveries === 1 ? 'entrega' : 'entregas'}{c.last_delivery && ` · última em ${dateTime(c.last_delivery, tz)}`}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => show(c)}>Ver entregas</Button>
                {canReveal && !shown[c.id] && (c.document_masked || c.has_cnh) && <Button type="button" variant="ghost" onClick={() => reveal(c)}>Revelar documento</Button>}
                {canReveal && c.has_photo && <Button type="button" variant="ghost" onClick={() => viewPhoto(c)}>Ver foto do documento</Button>}
              </div>
            </Card></li>
          ))}
        </ul>
      )}
      {open && (
        <Modal title={`Entregas de ${open.c.full_name}`} onClose={() => setOpen(null)} wide>
          {!open.items ? <Spinner /> : open.items.length === 0 ? <Empty title="Nenhuma entrega vinculada." /> : (
            <ul className="divide-y divide-line">
              {open.items.map((d) => (
                <li key={d.package_id} className="py-2 text-sm flex flex-wrap justify-between gap-x-3 gap-y-1">
                  <span className="font-medium">{unitName(d.unit_block, d.unit_label, t.unitLabels)}</span>
                  <span>{d.carrier} · {STATUS_LABEL[d.status] || d.status}</span>
                  <span className="text-muted w-full">{dateTime(d.received_at, tz)} · recebido por {d.received_by_name || 'não informado'}</span>
                </li>
              ))}
            </ul>
          )}
          {open.more && open.items && <Button type="button" variant="secondary" className="mt-3" onClick={() => load(open.c, open.items!)}>Carregar mais</Button>}
        </Modal>
      )}
      {photo && (
        <Modal title={`Documento de ${photo.name}`} onClose={() => setPhoto(null)} wide>
          <img src={photo.url} alt={`Foto do documento de ${photo.name}`} className="max-h-[70vh] w-full object-contain"
            referrerPolicy="no-referrer" onError={() => { setPhoto(null); toast.error('Link expirado ou foto indisponível. Peça de novo.'); }} />
          <p className="text-xs text-muted mt-2">Acesso registrado na auditoria. O link expira em 1 minuto.</p>
        </Modal>
      )}
    </div>
  );
}
