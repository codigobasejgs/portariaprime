import React, { useCallback, useEffect, useState } from 'react';
import { LogIn, LogOut, QrCode, ScanLine, UserPlus, X } from 'lucide-react';
import { newKey, rpc } from '../../lib/api';
import { useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { dateTime, unitName } from '../../lib/format';
import { loadUnits } from '../../lib/packages';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../components/ui';
import { QRCodeDisplay } from '../../components/VisualCodes';
import { QrCodeScanner } from '../../components/QrCodeScanner';

interface Pass { id: string; unit_id: string; unit: string; visitor_name: string; kind: string; notes: string | null; valid_from: string; valid_until: string; uses: number; max_uses: number; status: string }
interface Visit { id: string; unit: string; visitor_name: string; kind: string; method: string; checked_in_at: string; checked_out_at: string | null; authorized_by_name: string | null }

const KIND: Record<string, string> = { visita: 'Visita', prestador: 'Prestador de serviço', entrega: 'Entrega', outro: 'Outro' };
const STATUS: Record<string, [string, 'success' | 'neutral' | 'warning' | 'danger']> = {
  active: ['Válido', 'success'], used: ['Usado', 'neutral'], expired: ['Vencido', 'warning'], revoked: ['Cancelado', 'danger'],
};
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/**
 * Visitantes: o morador convida (QR de uso único com validade) e a portaria registra a entrada por QR ou manualmente
 * (com quem autorizou). Registrar a entrada não abre portão. Unidades e moradores são os mesmos de Encomendas.
 */
export function VisitantesPage({ units }: { units?: { id: string; block: string | null; label: string }[] }) {
  const t = useTenant();
  const staff = t.isStaff;
  const [data, setData] = useState<{ passes: Pass[]; visits: Visit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);
  const [shown, setShown] = useState<{ qr: string; name: string; until: string } | null>(null);
  const [checkin, setCheckin] = useState<'qr' | 'manual' | null>(null);
  const { busy, run } = useAction();
  const load = useCallback(() => rpc<{ passes: Pass[]; visits: Visit[] }>('visitor_list', { p_tenant: t.tenant.id })
    .then((r) => { setData(r); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  useRefreshWhileVisible(load, 30000);
  if (!t.hasModule('visitors')) return <Alert tone="warning">O módulo Visitantes não está contratado neste condomínio. Fale com a administração do Portaria Prime.</Alert>;

  const open = (data?.visits || []).filter((v) => !v.checked_out_at);
  const out = (v: Visit) => run(async () => { await rpc('visitor_check_out', { p_tenant: t.tenant.id, p_visit: v.id }); await load(); }, 'Saída registrada.');
  const revoke = (p: Pass) => { if (confirm(`Cancelar o convite de ${p.visitor_name}?`)) void run(async () => { await rpc('visitor_pass_revoke', { p_tenant: t.tenant.id, p_pass: p.id }); await load(); }, 'Convite cancelado.'); };

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">Visitantes</h1>
          <p className="text-sm text-muted">{staff ? 'Confira o convite do morador ou registre a entrada com quem autorizou. Registrar a entrada não abre portão.' : 'Convide visitas e prestadores. Cada convite tem um QR de uso único com validade.'}</p></div>
        <div className="flex flex-wrap gap-2" data-tour="visitantes-acoes">
          {staff && <Button onClick={() => setCheckin('qr')}><ScanLine className="w-4 h-4" aria-hidden /> Ler convite (QR)</Button>}
          {staff && <Button variant="secondary" onClick={() => setCheckin('manual')}><LogIn className="w-4 h-4" aria-hidden /> Entrada sem convite</Button>}
          <Button variant={staff ? 'ghost' : 'primary'} onClick={() => setInvite(true)}><UserPlus className="w-4 h-4" aria-hidden /> Novo convite</Button>
        </div>
      </div>
      {error && <Alert tone="danger">{error} <button className="underline" onClick={() => void load()}>Tentar novamente</button></Alert>}
      {!data && !error ? <Spinner /> : data && (
        <>
          {staff && (
            <Card className="space-y-2" data-tour="visitantes-dentro">
              <h2 className="font-semibold">No condomínio agora ({open.length})</h2>
              {open.length === 0 ? <p className="text-sm text-muted">Nenhum visitante com entrada em aberto.</p> : (
                <ul className="divide-y divide-line">{open.map((v) => (
                  <li key={v.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div className="min-w-0"><p className="font-medium">{v.visitor_name} <span className="text-muted font-normal">· {v.unit}</span></p>
                      <p className="text-xs text-muted">{KIND[v.kind]} · entrou {dateTime(v.checked_in_at, t.tenant.timezone)} · {v.method === 'qr' ? 'por convite' : `autorizado por ${v.authorized_by_name}`}</p></div>
                    <Button variant="secondary" onClick={() => out(v)} disabled={busy}><LogOut className="w-4 h-4" aria-hidden /> Registrar saída</Button>
                  </li>))}</ul>
              )}
            </Card>
          )}
          <Card className="space-y-2" data-tour="visitantes-convites">
            <h2 className="font-semibold">Convites</h2>
            {data.passes.length === 0 ? <Empty title="Nenhum convite">{staff ? 'Os convites dos moradores aparecem aqui.' : 'Toque em “Novo convite” para gerar o QR da visita.'}</Empty> : (
              <ul className="divide-y divide-line">{data.passes.map((p) => (
                <li key={p.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div className="min-w-0"><p className="font-medium">{p.visitor_name} <span className="text-muted font-normal">· {p.unit}</span></p>
                    <p className="text-xs text-muted">{KIND[p.kind]} · {dateTime(p.valid_from, t.tenant.timezone)} até {dateTime(p.valid_until, t.tenant.timezone)} · {p.uses}/{p.max_uses} uso(s){p.notes ? ` · ${p.notes}` : ''}</p></div>
                  <div className="flex items-center gap-2"><Badge tone={STATUS[p.status]?.[1]}>{STATUS[p.status]?.[0] || p.status}</Badge>
                    {p.status === 'active' && <Button variant="ghost" onClick={() => revoke(p)} aria-label={`Cancelar convite de ${p.visitor_name}`}><X className="w-4 h-4" /></Button>}</div>
                </li>))}</ul>
            )}
          </Card>
          {!staff && data.visits.length > 0 && (
            <Card className="space-y-2"><h2 className="font-semibold">Visitas recentes</h2>
              <ul className="divide-y divide-line text-sm">{data.visits.map((v) => (
                <li key={v.id} className="py-2"><p className="font-medium">{v.visitor_name}</p>
                  <p className="text-xs text-muted">Entrou {dateTime(v.checked_in_at, t.tenant.timezone)}{v.checked_out_at ? ` · saiu ${dateTime(v.checked_out_at, t.tenant.timezone)}` : ''}</p></li>))}</ul>
            </Card>
          )}
        </>
      )}
      {invite && <InviteModal units={units} onClose={() => setInvite(false)} onCreated={(r) => { setInvite(false); setShown(r); void load(); }} />}
      {shown && (
        <Modal title="Convite criado" onClose={() => setShown(null)}>
          <div className="space-y-3 text-center">
            <p className="text-sm">Envie este QR para <strong>{shown.name}</strong>. Vale uma vez, até {dateTime(shown.until, t.tenant.timezone)}.</p>
            <div className="inline-block rounded-2xl bg-white p-3"><QRCodeDisplay value={shown.qr} size={220} /></div>
            <p className="text-xs text-muted">Por segurança, o QR só aparece agora. Se perder, cancele e crie outro convite.</p>
            {'share' in navigator && <Button variant="secondary" onClick={() => navigator.share({ text: `Convite de acesso ao ${t.branding?.display_name || t.tenant.name}: ${shown.qr}` }).catch(() => {})}><QrCode className="w-4 h-4" aria-hidden /> Compartilhar código</Button>}
          </div>
        </Modal>
      )}
      {checkin && <CheckinModal mode={checkin} units={units} onClose={() => setCheckin(null)} onDone={() => { setCheckin(null); void load(); }} />}
    </div>
  );
}

function useUnits(given?: { id: string; block: string | null; label: string }[]) {
  const t = useTenant();
  const [units, setUnits] = useState(given || null);
  useEffect(() => {
    if (given) return;
    // Equipe lê as unidades ativas (mesma consulta da portaria); morador usa as próprias (perfil do app).
    (t.isStaff ? loadUnits(t.tenant.id).then((u) => u.filter((x) => x.active)) : rpc<any>('resident_profile', { p_tenant: t.tenant.id }).then((p) => p.units))
      .then((u) => setUnits(Array.isArray(u) ? u : [])).catch(() => setUnits([]));
  }, [given, t.isStaff, t.tenant.id]);
  return units;
}

function InviteModal({ units: given, onClose, onCreated }: { units?: any[]; onClose: () => void; onCreated: (r: { qr: string; name: string; until: string }) => void }) {
  const t = useTenant();
  const units = useUnits(given);
  const now = new Date();
  const [f, setF] = useState({ unit: '', name: '', kind: 'visita', from: local(now), until: local(new Date(now.getTime() + 24 * 3600_000)), uses: 1, doc: '', notes: '' });
  const { busy, run } = useAction();
  useEffect(() => { if (units?.length === 1 && !f.unit) setF((x) => ({ ...x, unit: units[0].id })); }, [units, f.unit]);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await rpc<any>('visitor_pass_create', { p_tenant: t.tenant.id, p_unit: f.unit, p_name: f.name, p_kind: f.kind,
        p_valid_from: new Date(f.from).toISOString(), p_valid_until: new Date(f.until).toISOString(), p_max_uses: f.uses,
        p_document_last4: f.doc || null, p_notes: f.notes || null });
      onCreated({ qr: r.qr, name: f.name, until: r.valid_until });
    });
  };
  return (
    <Modal title="Novo convite" onClose={onClose}>
      {!units ? <Spinner /> : (
        <form className="space-y-3" onSubmit={save}>
          {units.length !== 1 && <Field label="Unidade"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} required>
            <option value="">Selecione</option>{units.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}</Select></Field>}
          <Field label="Nome do visitante"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} minLength={2} maxLength={120} required autoComplete="off" /></Field>
          <Field label="Tipo"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Vale a partir de"><Input type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} required /></Field>
            <Field label="Vale até" hint="Máximo de 30 dias."><Input type="datetime-local" value={f.until} min={f.from} onChange={(e) => setF({ ...f, until: e.target.value })} required /></Field>
          </div>
          <Field label="Quantas entradas" hint="1 = uso único."><Input type="number" min={1} max={20} value={f.uses} onChange={(e) => setF({ ...f, uses: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} /></Field>
          <Field label="Documento (só os 4 últimos dígitos, opcional)" hint="Guardamos o mínimo necessário."><Input value={f.doc} onChange={(e) => setF({ ...f, doc: e.target.value.replace(/[^0-9A-Za-z]/g, '').slice(-4) })} inputMode="numeric" maxLength={4} /></Field>
          <Field label="Observação (opcional)"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={300} placeholder="Ex.: técnico da internet" /></Field>
          <Button type="submit" loading={busy} className="w-full">Gerar convite</Button>
        </form>
      )}
    </Modal>
  );
}

function CheckinModal({ mode, units: given, onClose, onDone }: { mode: 'qr' | 'manual'; units?: any[]; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const units = useUnits(mode === 'manual' ? given : []);
  const [qr, setQr] = useState('');
  // Começa no campo (leitor USB/teclado também digita ali); a câmera abre sob demanda.
  const [scan, setScan] = useState(false);
  const [found, setFound] = useState<any | null>(null);
  const [f, setF] = useState({ unit: '', name: '', kind: 'visita', by: '', reason: '' });
  const [key] = useState(newKey);
  const { busy, run } = useAction();
  const lookup = (code: string) => run(async () => { setQr(code); setScan(false); setFound(await rpc('visitor_pass_lookup', { p_tenant: t.tenant.id, p_qr: code })); });
  const enter = () => run(async () => {
    const r = await rpc<any>('visitor_check_in', mode === 'qr' ? { p_tenant: t.tenant.id, p_idempotency_key: key, p_qr: qr }
      : { p_tenant: t.tenant.id, p_idempotency_key: key, p_unit: f.unit, p_name: f.name, p_kind: f.kind, p_authorized_by: f.by, p_reason: f.reason || null });
    toast.success(`Entrada de ${r.visitor_name || f.name || found?.visitor_name} registrada. Morador avisado.`);
    onDone();
  });
  return (
    <Modal title={mode === 'qr' ? 'Ler convite' : 'Entrada sem convite'} onClose={onClose}>
      {mode === 'qr' ? (
        <div className="space-y-3">
          {scan ? <QrCodeScanner onDecode={(c) => void lookup(c)} onClose={() => setScan(false)} /> : !found && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void lookup(qr); }}>
              <Field label="Código do convite" hint="Começa com PV1."><Input value={qr} onChange={(e) => setQr(e.target.value.trim())} required autoFocus /></Field>
              <div className="flex gap-2"><Button type="submit" loading={busy}>Conferir</Button><Button type="button" variant="ghost" onClick={() => setScan(true)}>Usar câmera</Button></div>
            </form>
          )}
          {found && (
            <div className="space-y-2">
              <div className="rounded-xl border border-line p-3 text-sm space-y-1">
                <p className="font-semibold text-base">{found.visitor_name}</p>
                <p>{KIND[found.kind]} · {found.unit}</p>
                <p className="text-muted">Válido até {dateTime(found.valid_until, t.tenant.timezone)} · {found.uses}/{found.max_uses} uso(s){found.document_last4 ? ` · documento final ${found.document_last4}` : ''}</p>
                {found.notes && <p className="text-muted">{found.notes}</p>}
              </div>
              {found.status === 'active' ? <Button onClick={() => void enter()} loading={busy} className="w-full">Confirmar entrada</Button>
                : <Alert tone="danger">{found.status === 'not_yet' ? 'Este convite ainda não começou a valer.' : `Convite ${STATUS[found.status]?.[0].toLowerCase() || found.status}: entrada só com nova autorização do morador.`}</Alert>}
            </div>
          )}
        </div>
      ) : !units ? <Spinner /> : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void enter(); }}>
          <Field label="Unidade"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} required>
            <option value="">Selecione</option>{units.map((u: any) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}</Select></Field>
          <Field label="Nome do visitante"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} minLength={2} required autoComplete="off" /></Field>
          <Field label="Tipo"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Quem autorizou" hint="Ex.: morador pelo interfone, síndico."><Input value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })} minLength={2} required /></Field>
          <Field label="Motivo (opcional)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={300} /></Field>
          <Button type="submit" loading={busy} className="w-full">Registrar entrada</Button>
        </form>
      )}
    </Modal>
  );
}
