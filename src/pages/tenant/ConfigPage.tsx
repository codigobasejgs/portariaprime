import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { api, rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { applyTheme, contrast, publicLogoUrl } from '../../lib/theme';
import { uploadLogo } from '../../lib/files';
import { query } from '../../lib/router';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, toast, useAction } from '../../components/ui';

const DEFAULTS = { color_primary: '#101F30', color_secondary: '#126B61', color_accent: '#C8AB78' };

export function ConfigPage() {
  const t = useTenant();
  const first = query('inicio') === '1';
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Configurações</h1>
      {first && (
        <Alert tone="success">
          Condomínio criado e mês grátis ativo. Próximos passos: 1) marca; 2) locais de guarda; 3) unidades em “Unidades e pessoas”; 4) convidar porteiros e moradores; 5) registrar uma encomenda de teste.
        </Alert>
      )}
      <BrandingCard />
      <StorageCard />
      <ChannelsCard />
      {t.overview?.entitlements?.feature_whatsapp && <WhatsAppCard />}
      {t.overview?.entitlements?.feature_totem && <TotemCard />}
    </div>
  );
}

function BrandingCard() {
  const t = useTenant();
  const b = t.branding || {};
  const [form, setForm] = useState({
    display_name: b.display_name || t.tenant.name, color_primary: b.color_primary || DEFAULTS.color_primary,
    color_secondary: b.color_secondary || DEFAULTS.color_secondary, color_accent: b.color_accent || DEFAULTS.color_accent,
    theme: b.theme || 'light', logo_path: b.logo_path || null,
  });
  const { busy, run } = useAction();
  const preview = () => applyTheme(form as any);
  useEffect(() => { preview(); /* prévia ao vivo */ }, [form]); // eslint-disable-line react-hooks/exhaustive-deps

  const ratio = contrast(form.color_primary, '#FFFFFF');
  const ratioDark = contrast(form.color_primary, '#18283A');
  const legible = Math.max(ratio, ratioDark) >= 4.5;

  const save = () => run(async () => {
    if (!legible) throw new Error('A cor primária não tem contraste suficiente com o texto. Escolha um tom mais escuro ou mais claro.');
    const { error } = await supabase.from('tenant_branding').update({ ...form, display_name: form.display_name.trim() || null }).eq('tenant_id', t.tenant.id);
    if (error) throw new Error('Não foi possível salvar a marca.');
    await t.reload();
  }, 'Marca salva.');

  const reset = () => setForm({ ...form, ...DEFAULTS, theme: 'light' });
  if (!t.can('settings')) return null;
  return (
    <Card className="space-y-4">
      <p className="font-semibold">Marca do condomínio</p>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Nome exibido"><Input value={form.display_name} maxLength={80} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></Field>
        <Field label="Tema">
          <Select value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value as any })}>
            <option value="light">Claro</option><option value="dark">Escuro</option><option value="system">Seguir o dispositivo</option>
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {(['color_primary', 'color_secondary', 'color_accent'] as const).map((k) => (
          <Field key={k} label={{ color_primary: 'Primária', color_secondary: 'Secundária', color_accent: 'Destaque' }[k]}>
            <input type="color" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className="h-11 w-full rounded-xl border border-line bg-surface p-1" />
          </Field>
        ))}
      </div>
      {!legible && <Alert tone="warning">Contraste baixo: textos sobre a cor primária ficariam ilegíveis.</Alert>}
      <div className="flex items-center gap-4">
        {form.logo_path ? <img src={publicLogoUrl(form.logo_path)!} alt="Logo atual" className="h-16 w-16 object-contain rounded-lg bg-surface-2" /> : <span className="text-sm text-muted">Sem logo</span>}
        <label className="text-sm">
          <span className="sr-only">Enviar logo</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) run(async () => setForm({ ...form, logo_path: await uploadLogo(t.tenant.id, f) }), 'Logo enviado. Clique em salvar.');
          }} />
        </label>
        {form.logo_path && <Button variant="ghost" onClick={() => setForm({ ...form, logo_path: null })}>Remover logo</Button>}
      </div>
      <div className="rounded-xl p-4 bg-primary text-primary-fg"><p className="font-semibold">{form.display_name}</p><p className="text-sm opacity-80">Prévia do cabeçalho e botões</p></div>
      <div className="flex gap-2">
        <Button onClick={save} loading={busy}>Salvar</Button>
        <Button variant="secondary" onClick={reset}>Restaurar padrão</Button>
      </div>
    </Card>
  );
}

function StorageCard() {
  const t = useTenant();
  const [concierges, setConcierges] = useState<any[] | null>(null);
  const [locs, setLocs] = useState<any[]>([]);
  const { busy, run } = useAction();
  const load = useCallback(async () => {
    const [{ data: c }, { data: l }] = await Promise.all([
      supabase.from('concierge_locations').select('*').eq('tenant_id', t.tenant.id).order('created_at'),
      supabase.from('storage_locations').select('*').eq('tenant_id', t.tenant.id).order('sort_order').order('code'),
    ]);
    setConcierges(c || []);
    setLocs(l || []);
  }, [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  if (t.link.role !== 'admin') return null;

  const addLoc = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    run(async () => {
      const { error } = await supabase.from('storage_locations').insert({
        tenant_id: t.tenant.id, concierge_location_id: f.get('concierge'), code: String(f.get('code')).trim(),
        capacity: Number(f.get('capacity')), is_contingency: f.get('contingency') === 'on', sort_order: locs.length + 1,
      });
      if (error) throw new Error(/unique|duplicate/.test(error.message) ? 'Já existe um local com esse código.' : 'Não foi possível salvar.');
      form.reset();
      await load();
    }, 'Local adicionado.');
  };
  const addConcierge = () => {
    const name = prompt('Nome da portaria');
    if (name) run(async () => {
      const { error } = await supabase.from('concierge_locations').insert({ tenant_id: t.tenant.id, name });
      if (error) throw new Error(error.message.replace(/^.*?:\s*/, ''));
      await load();
    }, 'Portaria adicionada.');
  };
  const toggle = (l: any) => run(async () => {
    const { error } = await supabase.from('storage_locations').update({ active: !l.active }).eq('id', l.id);
    if (error) throw new Error('Não foi possível atualizar.');
    await load();
  });

  return (
    <Card className="space-y-3">
      <div className="flex justify-between items-center"><p className="font-semibold">Portarias e locais de guarda</p><Button variant="ghost" onClick={addConcierge}>Nova portaria</Button></div>
      {!concierges ? <Spinner /> : (
        <>
          <p className="text-sm text-muted">Portarias: {concierges.map((c) => c.name).join(', ')}</p>
          <ul className="divide-y divide-line text-sm">
            {locs.map((l) => (
              <li key={l.id} className="py-2 flex justify-between items-center">
                <span className={l.active ? '' : 'line-through text-muted'}>{l.code} · capacidade {l.capacity} {l.is_contingency && <Badge tone="warning">contingência</Badge>}</span>
                <Button variant="ghost" onClick={() => toggle(l)}>{l.active ? 'Desativar' : 'Reativar'}</Button>
              </li>
            ))}
          </ul>
          <form onSubmit={addLoc} className="grid sm:grid-cols-5 gap-2 items-end">
            <Field label="Portaria"><Select name="concierge">{concierges.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Código"><Input name="code" required maxLength={20} placeholder="Estante A" /></Field>
            <Field label="Capacidade"><Input name="capacity" type="number" min={1} max={1000} required defaultValue={20} /></Field>
            <label className="flex items-center gap-2 text-sm min-h-11"><input type="checkbox" name="contingency" /> Contingência</label>
            <Button type="submit" loading={busy}>Adicionar</Button>
          </form>
        </>
      )}
    </Card>
  );
}

function ChannelsCard() {
  const t = useTenant();
  const [s, setS] = useState<any>(null);
  const { busy, run } = useAction();
  useEffect(() => { supabase.from('tenant_settings').select('*').eq('tenant_id', t.tenant.id).single().then(({ data }) => setS(data)); }, [t.tenant.id]);
  if (!s || !t.can('settings')) return null;
  const save = () => run(async () => {
    const { error } = await supabase.from('tenant_settings').update({
      notify_whatsapp: s.notify_whatsapp, notify_email: s.notify_email, notify_push: s.notify_push,
      qr_ttl_hours: Number(s.qr_ttl_hours), max_residents_per_unit: Number(s.max_residents_per_unit),
    }).eq('tenant_id', t.tenant.id);
    if (error) throw new Error('Não foi possível salvar.');
  }, 'Preferências salvas.');
  return (
    <Card className="space-y-3">
      <p className="font-semibold">Avisos e regras</p>
      <div className="flex flex-wrap gap-4 text-sm">
        {[['notify_email', 'E-mail'], ['notify_push', 'Notificação no app'], ['notify_whatsapp', 'WhatsApp']].map(([k, l]) => (
          <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /> {l}</label>
        ))}
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Validade do QR de retirada (horas)"><Input type="number" min={1} max={720} value={s.qr_ttl_hours} onChange={(e) => setS({ ...s, qr_ttl_hours: e.target.value })} /></Field>
        <Field label="Máximo de moradores por unidade"><Input type="number" min={1} max={50} value={s.max_residents_per_unit} onChange={(e) => setS({ ...s, max_residents_per_unit: e.target.value })} /></Field>
      </div>
      <Button onClick={save} loading={busy}>Salvar</Button>
    </Card>
  );
}

function WhatsAppCard() {
  const t = useTenant();
  const [st, setSt] = useState<{ connected: boolean } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const { busy, run } = useAction();
  const check = () => run(async () => setSt(await api('/api/whatsapp/status', { tenantId: t.tenant.id })));
  if (!t.can('settings')) return null;
  return (
    <Card className="space-y-3">
      <p className="font-semibold">WhatsApp do condomínio</p>
      <p className="text-sm text-muted">Conecte um número do condomínio para enviar avisos de chegada e retirada. A entrega da mensagem depende do WhatsApp e do telefone do morador.</p>
      {st && <Badge tone={st.connected ? 'success' : 'warning'}>{st.connected ? 'Conectado' : 'Não conectado'}</Badge>}
      {qr && <img src={qr} alt="QR Code para conectar o WhatsApp" className="w-56 h-56 bg-white p-2 rounded-xl" />}
      <div className="flex gap-2">
        <Button variant="secondary" loading={busy} onClick={check}>Verificar conexão</Button>
        <Button loading={busy} onClick={() => run(async () => {
          const r = await api('/api/whatsapp/connect', { tenantId: t.tenant.id });
          if (r.alreadyConnected) { setSt({ connected: true }); setQr(null); } else setQr(r.qrCodeBase64);
        })}>Conectar</Button>
      </div>
    </Card>
  );
}

function TotemCard() {
  const t = useTenant();
  const [devices, setDevices] = useState<any[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const { busy, run } = useAction();
  const load = useCallback(async () => {
    const { data } = await supabase.from('device_enrollments').select('id, name, status, last_seen_at, created_at').eq('tenant_id', t.tenant.id).order('created_at', { ascending: false });
    setDevices(data || []);
  }, [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  if (!t.can('settings')) return null;
  return (
    <Card className="space-y-3">
      <p className="font-semibold">Totem de autoatendimento</p>
      <p className="text-sm text-muted">No tablet da portaria, abra <strong>{location.host}/c/{t.tenant.slug}/totem</strong> e digite o código de pareamento (vale 15 minutos). O totem só pré-registra; o porteiro confere antes do aviso ao morador.</p>
      {code && <Alert tone="success">Código de pareamento: <strong className="font-mono text-lg tracking-widest">{code}</strong></Alert>}
      <Button loading={busy} onClick={() => run(async () => {
        const r = await rpc('create_device', { p_tenant: t.tenant.id, p_name: `Totem ${devices.length + 1}`, p_concierge: null });
        setCode(r.pairing_code);
        await load();
      })}>Gerar código de pareamento</Button>
      <ul className="divide-y divide-line text-sm">
        {devices.map((d) => (
          <li key={d.id} className="py-2 flex justify-between items-center">
            <span>{d.name} · <Badge tone={d.status === 'active' ? 'success' : d.status === 'revoked' ? 'danger' : 'warning'}>{d.status === 'active' ? 'pareado' : d.status === 'revoked' ? 'revogado' : 'aguardando'}</Badge></span>
            {d.status !== 'revoked' && <Button variant="ghost" onClick={() => run(async () => { await rpc('revoke_device', { p_device: d.id }); await load(); }, 'Totem revogado.')}>Revogar</Button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
