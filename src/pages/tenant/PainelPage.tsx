import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { dateTime, download, STATUS_LABEL, toCsv, unitName } from '../../lib/format';
import { listAllPackages, listPackages, PackageRow } from '../../lib/packages';
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Spinner, toast } from '../../components/ui';

const today = (tz: string, delta = 0) => {
  const d = new Date(Date.now() + delta * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD no fuso do condomínio
};

export function PainelPage() {
  const t = useTenant();
  const tz = t.tenant.timezone;
  const [from, setFrom] = useState(today(tz, -29));
  const [to, setTo] = useState(today(tz));
  const [sum, setSum] = useState<any>(null);
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<PackageRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [s, r] = await Promise.all([
        rpc('report_summary', { p_tenant: t.tenant.id, p_from: from, p_to: to }),
        listPackages(t.tenant.id, { status: status || null, from, to, limit: 50 }),
      ]);
      setSum(s);
      setRows(r);
      setMore(r.length === 50);
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to, status, t.tenant.id]);

  const loadMore = async () => {
    const last = rows![rows!.length - 1];
    const r = await listPackages(t.tenant.id, { status: status || null, from, to, limit: 50 }, { at: last.received_at, id: last.id });
    setRows([...rows!, ...r]);
    setMore(r.length === 50);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await listAllPackages(t.tenant.id, { status: status || null, from, to });
      const data = all.map((p) => ({
        ...p, unit: unitName(p.unit_block, p.unit_label), status_label: STATUS_LABEL[p.status],
        received: dateTime(p.received_at, tz), picked: dateTime(p.picked_up_at, tz),
      }));
      download(`encomendas-${t.tenant.slug}-${from}-a-${to}.csv`, toCsv(data, [
        ['unit', 'Unidade'], ['carrier', 'Transportadora'], ['tracking_code', 'Rastreio'], ['recipient_name', 'Destinatário'],
        ['status_label', 'Situação'], ['received', 'Recebida em'], ['storage_code', 'Local'], ['picked', 'Retirada em'],
        ['picked_up_by_name', 'Retirada por'], ['pickup_method', 'Validação'], ['resolution_reason', 'Motivo da exceção'],
      ]));
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  const kpis = sum ? [
    ['Aguardando retirada agora', sum.pending_now],
    ['Entradas no período', sum.entries],
    ['Retiradas no período', sum.pickups],
    ['Tempo médio até retirada', sum.avg_dwell_hours != null ? `${sum.avg_dwell_hours} h` : '—'],
  ] : [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Painel</h1>
      <Card className="grid sm:grid-cols-4 gap-3 items-end">
        <Field label="De"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Até"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Situação">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todas</option><option value="PENDENTES">Pendentes</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="w-4 h-4" /> Exportar CSV</Button>
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      {!sum ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {kpis.map(([k, v]) => <Card key={k as string}><p className="text-xs text-muted">{k}</p><p className="text-2xl font-semibold mt-1">{v}</p></Card>)}
          </div>
          <div className="grid lg:grid-cols-2 gap-3">
            <Card>
              <p className="font-semibold mb-3">Ocupação dos locais</p>
              {sum.occupancy.length === 0 ? <Empty title="Nenhum local configurado">Cadastre estantes em Configurações para usar o mapa e a sugestão de local.</Empty> : (
                <ul className="space-y-2">
                  {sum.occupancy.map((o: any) => {
                    const pct = Math.round((o.used / o.capacity) * 100);
                    return (
                      <li key={o.id}>
                        <div className="flex justify-between text-sm"><span>{o.code}{o.is_contingency ? ' (contingência)' : ''}</span><span>{o.used}/{o.capacity}</span></div>
                        <div className="h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Ocupação ${o.code}`}>
                          <div className={`h-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-secondary'}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card>
              <p className="font-semibold mb-3">Por transportadora e exceções</p>
              <ul className="text-sm space-y-1">
                {Object.entries(sum.by_carrier).sort((a: any, b: any) => b[1] - a[1]).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span>{v as number}</span></li>)}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(sum.exceptions).map(([k, v]) => <Badge key={k} tone="danger">{STATUS_LABEL[k]}: {v as number}</Badge>)}
                {sum.notification_failures > 0 && <Badge tone="warning">Avisos com falha: {sum.notification_failures}</Badge>}
                {sum.preregistered_now > 0 && <Badge tone="warning">Pré-registros a conferir: {sum.preregistered_now}</Badge>}
              </div>
            </Card>
          </div>
          <Card>
            <p className="font-semibold mb-2">Encomendas no período</p>
            {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="Sem encomendas no período" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted"><tr><th className="py-2 pr-3 font-medium">Unidade</th><th className="pr-3 font-medium">Transportadora</th><th className="pr-3 font-medium">Recebida</th><th className="pr-3 font-medium">Situação</th><th className="font-medium">Retirada por</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((p) => (
                      <tr key={p.id}><td className="py-2 pr-3">{unitName(p.unit_block, p.unit_label)}</td><td className="pr-3">{p.carrier}</td><td className="pr-3 whitespace-nowrap">{dateTime(p.received_at, tz)}</td><td className="pr-3">{STATUS_LABEL[p.status]}</td><td>{p.picked_up_by_name || '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {more && <Button variant="ghost" className="mt-2" onClick={loadMore}>Carregar mais</Button>}
          </Card>
        </>
      )}
    </div>
  );
}
