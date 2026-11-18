import React, { useCallback, useEffect, useState } from 'react';
import { Camera, DoorClosed, Package, Router, Users } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { navigate } from '../../lib/router';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Card, Spinner } from '../../components/ui';

interface Overview {
  parcels: { waiting: number; received_today: number; picked_today: number };
  visitors: { expected_today: number; inside: number } | null;
  gateways: { id: string; name: string; kind: string; status: string; last_seen_at: string | null; devices: number }[];
  modules: { visitors: boolean; cctv: boolean; access_control: boolean };
}

const GW: Record<string, [string, 'success' | 'warning' | 'neutral' | 'danger']> = {
  online: ['Online', 'success'], offline: ['Offline', 'danger'], pending: ['Aguardando pareamento', 'warning'],
};

/**
 * Central da portaria (módulo Portaria): encomendas, visitas e dispositivos num lugar. Cada bloco mostra o estado
 * real (sem licença, sem hardware, simulado, offline); nada aparece como online sem o gateway ter dito.
 */
export function CentralPage() {
  const t = useTenant();
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => rpc<Overview>('concierge_overview', { p_tenant: t.tenant.id }).then((r) => { setOv(r); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  useRefreshWhileVisible(load, 20000);
  if (!t.hasModule('concierge')) return <Alert tone="warning">O módulo Portaria não está contratado neste condomínio. Encomendas continuam em “Encomendas”.</Alert>;
  const go = (a: string) => navigate(`/c/${t.tenant.slug}/${a}`);
  return (
    <div className="space-y-4 max-w-5xl">
      <div><h1 className="text-2xl font-semibold">Central da portaria</h1><p className="text-sm text-muted">Encomendas, visitantes e dispositivos do condomínio em um só lugar.</p></div>
      {error && <Alert tone="danger">{error} <button className="underline" onClick={() => void load()}>Tentar novamente</button></Alert>}
      {!ov && !error ? <Spinner /> : ov && (
        <div className="grid gap-3 sm:grid-cols-2" data-tour="central-cards">
          <Card className="space-y-2">
            <p className="font-semibold flex items-center gap-2"><Package className="w-5 h-5" aria-hidden /> Encomendas</p>
            <p className="text-3xl font-semibold">{ov.parcels.waiting}<span className="text-sm font-normal text-muted"> aguardando retirada</span></p>
            <p className="text-sm text-muted">Hoje: {ov.parcels.received_today} recebida(s), {ov.parcels.picked_today} entregue(s).</p>
            <Button variant="secondary" onClick={() => go('portaria')}>Abrir encomendas</Button>
          </Card>
          <Card className="space-y-2">
            <p className="font-semibold flex items-center gap-2"><Users className="w-5 h-5" aria-hidden /> Visitantes</p>
            {ov.visitors ? <>
              <p className="text-3xl font-semibold">{ov.visitors.inside}<span className="text-sm font-normal text-muted"> no condomínio agora</span></p>
              <p className="text-sm text-muted">{ov.visitors.expected_today} convite(s) válido(s) nas próximas 12 h.</p>
              <Button variant="secondary" onClick={() => go('visitantes')}>Abrir visitantes</Button>
            </> : <p className="text-sm text-muted"><Badge>Sem licença</Badge> O módulo Visitantes não está contratado.</p>}
          </Card>
          <Card className="space-y-2">
            <p className="font-semibold flex items-center gap-2"><Router className="w-5 h-5" aria-hidden /> Gateway local</p>
            {ov.gateways.length === 0 ? <p className="text-sm text-muted"><Badge>Não instalado</Badge> Nenhum gateway pareado. Câmeras e portões dependem do gateway no condomínio.</p> : (
              <ul className="divide-y divide-line text-sm">{ov.gateways.map((g) => (
                <li key={g.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <span><span className="font-medium">{g.name}</span> <span className="text-muted">· {g.devices} dispositivo(s){g.last_seen_at ? ` · visto ${dateTime(g.last_seen_at, t.tenant.timezone)}` : ''}</span></span>
                  <span className="flex gap-1"><Badge tone={GW[g.status]?.[1]}>{GW[g.status]?.[0] || g.status}</Badge>{g.kind === 'simulator' && <Badge tone="warning">Simulado</Badge>}</span>
                </li>))}</ul>
            )}
          </Card>
          <Card className="space-y-2">
            <p className="font-semibold flex items-center gap-2"><Camera className="w-5 h-5" aria-hidden /> Câmeras e <DoorClosed className="w-5 h-5" aria-hidden /> portões</p>
            <p className="text-sm text-muted">{ov.modules.cctv || ov.modules.access_control ? 'Contratado; aguardando homologação do equipamento do condomínio.' : 'Em desenvolvimento (P1/P2). Nenhum equipamento é acionado pelo Portaria Prime nesta fase.'}</p>
            <Badge tone="warning">Sem hardware homologado</Badge>
          </Card>
        </div>
      )}
    </div>
  );
}
