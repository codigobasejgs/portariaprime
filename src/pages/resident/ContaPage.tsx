import React, { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Building2, ChevronRight, HelpCircle, LogOut, Plus, Smartphone, Trash2, UserRound } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { rpc } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useTenant } from '../../lib/tenant';
import { navigate, onLink } from '../../lib/router';
import { dateOnly, unitName } from '../../lib/format';
import { usePwaInstall } from '../../hooks/usePwaInstall';
import { usePushDevice } from '../../components/PushToggle';
import { Alert, Button, Field, Input, Modal, Spinner, useAction } from '../../components/ui';
import { useResident } from './ResidentShell';

interface Contact { id: string; unit_id: string; mine: boolean; editable: boolean; name: string; phone?: string | null; email?: string | null;
  notify_whatsapp?: boolean; notify_email?: boolean; has_whatsapp?: boolean; has_email?: boolean }
interface Profile { full_name: string | null; email: string; units: { id: string; block: string | null; label: string; since: string }[];
  contacts: Contact[]; whatsapp_available: boolean; email_available: boolean; portaria_contact: string | null }

const Section = ({ id, icon: Icon, title, children, ...rest }: { id: string; icon: React.ElementType; title: string; children: React.ReactNode } & React.HTMLAttributes<HTMLElement>) => (
  <section {...rest} id={id} aria-labelledby={`${id}-t`} className="rounded-2xl border border-line bg-surface p-4 space-y-3 scroll-mt-20">
    <h2 id={`${id}-t`} className="font-semibold flex items-center gap-2"><Icon className="w-5 h-5 text-muted" aria-hidden />{title}</h2>
    {children}
  </section>
);

const phoneDigits = (v: string) => v.replace(/\D/g, '');
const fmtPhone = (p?: string | null) => (p ? `+${p.replace(/^\+/, '')}` : '');

export function ContaPage() {
  const t = useTenant();
  const r = useResident();
  const { signOut } = useSession();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editName, setEditName] = useState<string | null>(null);
  const [add, setAdd] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', unit: '' });
  const [confirmOut, setConfirmOut] = useState(false);
  const { busy, run } = useAction();
  const load = useCallback(async () => {
    try { setP(await rpc('resident_profile', { p_tenant: t.tenant.id })); setError(null); } catch (e: any) { setError(e.message); }
  }, [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (p && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, [p]);

  if (error && !p) return <div className="space-y-3"><Alert tone="danger">Não foi possível carregar sua conta. {error}</Alert><Button onClick={load}>Tentar novamente</Button></div>;
  if (!p) return <Spinner />;
  const mine = p.contacts.find((c) => c.mine);
  const others = p.contacts.filter((c) => !c.mine);

  const saveName = () => run(async () => {
    const v = (editName || '').trim();
    if (v.length < 2) throw new Error('Informe seu nome.');
    const { data: u } = await supabase.auth.getUser();
    const { error: e } = await supabase.from('profiles').update({ full_name: v }).eq('id', u.user!.id);
    if (e) throw new Error('Não foi possível salvar o nome.');
    if (mine) await supabase.from('resident_contacts').update({ name: v }).eq('id', mine.id);
    setEditName(null); await load(); await r.reloadProfile();
  }, 'Nome atualizado.');
  const toggle = (c: Contact, field: 'notify_whatsapp' | 'notify_email') => run(async () => {
    const { error: e } = await supabase.from('resident_contacts').update({ [field]: !c[field] }).eq('id', c.id);
    if (e) throw new Error('Não foi possível salvar a preferência.');
    await load();
  });
  const savePhone = (c: Contact, raw: string) => run(async () => {
    const d = phoneDigits(raw);
    if (d && (d.length < 10 || d.length > 13)) throw new Error('Celular com DDD, só números (10 a 13 dígitos).');
    const { error: e } = await supabase.from('resident_contacts').update({ phone: d ? `+${d.startsWith('55') ? d : `55${d}`}` : null }).eq('id', c.id);
    if (e) throw new Error('Não foi possível salvar o celular.');
    await load();
  }, 'Celular salvo.');
  const addContact = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const d = phoneDigits(form.phone);
      if (d && (d.length < 10 || d.length > 13)) throw new Error('Celular com DDD, só números (10 a 13 dígitos).');
      if (!d && !form.email.trim()) throw new Error('Informe celular ou e-mail.');
      const { error: e2 } = await supabase.from('resident_contacts').insert({
        tenant_id: t.tenant.id, unit_id: form.unit || p.units[0]?.id, name: form.name.trim(),
        phone: d ? `+${d.startsWith('55') ? d : `55${d}`}` : null, email: form.email.trim().toLowerCase() || null,
      });
      if (e2) throw new Error('Não foi possível adicionar. Confira os dados.');
      setForm({ name: '', phone: '', email: '', unit: '' }); setAdd(false); await load();
    }, 'Contato adicionado.');
  };
  const remove = (c: Contact) => run(async () => {
    const { error: e } = await supabase.from('resident_contacts').update({ active: false }).eq('id', c.id);
    if (e) throw new Error('Não foi possível remover.');
    await load();
  }, 'Contato removido.');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Minha conta</h1>

      <Section id="perfil" icon={UserRound} title="Meu perfil">
        {editName === null ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0"><p className="font-medium">{p.full_name || 'Nome não informado'}</p><p className="text-sm text-muted break-all">{p.email}</p></div>
            <Button variant="ghost" onClick={() => setEditName(p.full_name || '')}>Editar nome</Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-48"><Field label="Nome"><Input autoComplete="name" maxLength={120} value={editName} onChange={(e) => setEditName(e.target.value)} /></Field></div>
            <Button onClick={saveName} loading={busy}>Salvar</Button><Button variant="ghost" onClick={() => setEditName(null)}>Cancelar</Button>
          </div>
        )}
        <p className="text-xs text-muted">O e-mail é o seu acesso. Para trocá-lo, fale com a administração.</p>
      </Section>

      <Section id="unidade" icon={Building2} title="Minha unidade">
        <ul className="space-y-1">
          {p.units.map((u) => <li key={u.id} className="flex justify-between gap-2 text-sm"><span className="font-medium">{unitName(u.block, u.label, t.unitLabels)}</span><span className="text-muted">Vínculo ativo desde {dateOnly(u.since, t.tenant.timezone)}</span></li>)}
        </ul>
        <p className="text-xs text-muted">Mudou de unidade ou há algo errado? A troca é feita pela administração do condomínio, com aprovação.</p>
        <div className="pt-2 border-t border-line space-y-2">
          <p className="font-medium text-sm">Quem recebe os avisos da unidade</p>
          <ul className="divide-y divide-line">
            {others.map((c) => (
              <li key={c.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>{c.name}{c.editable ? ' (familiar)' : ''}</span>
                {c.editable ? (
                  <span className="flex items-center gap-2 text-muted">
                    {[c.phone && 'WhatsApp', c.email && 'e-mail'].filter(Boolean).join(' e ') || 'sem contato'}
                    <button onClick={() => remove(c)} aria-label={`Remover ${c.name}`} className="p-2 min-h-11 min-w-11 grid place-items-center hover:text-danger"><Trash2 className="w-4 h-4" /></button>
                  </span>
                ) : <span className="text-muted">{[c.has_whatsapp && 'WhatsApp', c.has_email && 'e-mail'].filter(Boolean).join(' e ') || 'só no app'}</span>}
              </li>
            ))}
            {others.length === 0 && <li className="py-2 text-sm text-muted">Só você, por enquanto.</li>}
          </ul>
          <p className="text-xs text-muted">Por privacidade, você vê apenas o primeiro nome dos outros moradores. Cada um ajusta as próprias preferências.</p>
          {add ? (
            <form onSubmit={addContact} className="grid sm:grid-cols-2 gap-3 rounded-xl bg-surface-2 p-3">
              <Field label="Nome do familiar"><Input required minLength={2} maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              {p.units.length > 1 && <Field label="Unidade"><select className="w-full min-h-11 rounded-xl border border-line bg-surface px-3 text-sm" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>{p.units.map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}</select></Field>}
              {p.whatsapp_available && <Field label="Celular com DDD (WhatsApp)"><Input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>}
              <Field label="E-mail"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              <div className="flex gap-2 sm:col-span-2"><Button type="submit" loading={busy}>Adicionar</Button><Button type="button" variant="ghost" onClick={() => setAdd(false)}>Cancelar</Button></div>
              <p className="text-xs text-muted sm:col-span-2">Para quem mora com você e não tem conta. Só adicione contatos com autorização da pessoa.</p>
            </form>
          ) : <Button variant="secondary" onClick={() => { setAdd(true); setForm({ ...form, unit: p.units[0]?.id || '' }); }}><Plus className="w-4 h-4" aria-hidden /> Adicionar familiar sem conta</Button>}
        </div>
      </Section>

      <Section id="notificacoes" icon={Bell} title="Notificações" data-tour="morador-avisos">
        <DeviceNotifications />
        {mine && (
          <div className="pt-3 border-t border-line space-y-2">
            <p className="font-medium text-sm">Avisos para você fora do app</p>
            {p.whatsapp_available ? (
              <ChannelRow label="WhatsApp" value={mine.phone ? fmtPhone(mine.phone) : 'Nenhum celular cadastrado'} on={!!mine.notify_whatsapp && !!mine.phone}
                disabled={!mine.phone} onToggle={() => toggle(mine, 'notify_whatsapp')}>
                <PhoneEdit current={mine.phone || ''} onSave={(v) => savePhone(mine, v)} busy={busy} />
              </ChannelRow>
            ) : <p className="text-sm text-muted">WhatsApp não está disponível neste condomínio.</p>}
            {p.email_available
              ? <ChannelRow label="E-mail" value={mine.email || 'Sem e-mail'} on={!!mine.notify_email && !!mine.email} disabled={!mine.email} onToggle={() => toggle(mine, 'notify_email')} />
              : <p className="text-sm text-muted">Avisos por e-mail estão desligados pelo condomínio.</p>}
            <p className="text-xs text-muted">Estas escolhas valem só para você. A central de Notificações do app continua recebendo tudo.</p>
          </div>
        )}
      </Section>

      <InstallSection />

      <Section id="ajuda" icon={HelpCircle} title="Ajuda e suporte">
        <a href={`${r.base}/ajuda`} onClick={onLink} className="flex items-center justify-between min-h-11 rounded-xl px-1 hover:bg-surface-2"><span>Central de ajuda e tutorial</span><ChevronRight className="w-4 h-4" aria-hidden /></a>
        {p.portaria_contact ? <p className="text-sm">Contato da portaria: <strong>{p.portaria_contact}</strong></p>
          : <p className="text-sm text-muted">Para dúvidas sobre uma encomenda, fale com a portaria do condomínio.</p>}
      </Section>

      <Button variant="secondary" className="w-full text-danger" onClick={() => setConfirmOut(true)}><LogOut className="w-4 h-4" aria-hidden /> Sair</Button>
      {confirmOut && (
        <Modal title="Sair deste aparelho?" onClose={() => setConfirmOut(false)}>
          <p className="text-sm">Você deixa de receber notificações deste condomínio neste aparelho. Outros aparelhos não são afetados.</p>
          <div className="flex gap-2 mt-4"><Button variant="ghost" onClick={() => setConfirmOut(false)}>Cancelar</Button>
            <Button className="flex-1" onClick={async () => { await signOut(); navigate('/entrar', true); }}>Sair</Button></div>
        </Modal>
      )}
    </div>
  );
}

function ChannelRow({ label, value, on, disabled, onToggle, children }: { label: string; value: string; on: boolean; disabled?: boolean; onToggle: () => void; children?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between gap-3 min-h-11">
        <span className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-muted break-all">{value}</span></span>
        <input type="checkbox" role="switch" aria-checked={on} checked={on} disabled={disabled} onChange={onToggle} className="h-6 w-11 accent-[var(--c-secondary)] shrink-0" />
      </label>
      {children}
    </div>
  );
}

function PhoneEdit({ current, onSave, busy }: { current: string; onSave: (v: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(current.replace(/^\+55/, ''));
  if (!open) return <button className="text-xs underline min-h-9" onClick={() => setOpen(true)}>{current ? 'Trocar celular' : 'Cadastrar celular'}</button>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 min-w-40"><Field label="Celular com DDD"><Input type="tel" inputMode="tel" autoComplete="tel" value={v} onChange={(e) => setV(e.target.value)} placeholder="11 99999-0000" /></Field></div>
      <Button onClick={() => { onSave(v); setOpen(false); }} loading={busy}>Salvar</Button>
      <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
    </div>
  );
}

/** Estado real deste aparelho, em linguagem simples; diagnóstico técnico só sob demanda. */
function DeviceNotifications() {
  const push = usePushDevice();
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
  const [diag, setDiag] = useState(false);
  const [sw, setSw] = useState('verificando');
  useEffect(() => { if (diag) navigator.serviceWorker?.getRegistration().then((r) => setSw(r?.active ? 'ativo' : 'ausente')).catch(() => setSw('ausente')); }, [diag]);
  const body = {
    checking: <p className="text-sm text-muted">Verificando este aparelho…</p>,
    on: <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium text-success flex items-center gap-2"><Bell className="w-4 h-4" aria-hidden />Notificações ativadas neste aparelho</p><Button variant="ghost" onClick={push.disable} loading={push.busy}><BellOff className="w-4 h-4" aria-hidden />Desativar</Button></div>,
    off: <div className="space-y-2"><p className="text-sm">Receba um aviso no aparelho quando chegar uma encomenda.</p><Button onClick={push.enable} loading={push.busy}><Bell className="w-4 h-4" aria-hidden /> Ativar notificações neste dispositivo</Button></div>,
    denied: <Alert tone="warning">Notificações bloqueadas neste navegador. Para liberar, toque no cadeado ao lado do endereço › Permissões › Notificações › Permitir, e volte aqui.</Alert>,
    unsupported: <p className="text-sm text-muted">{ios && !standalone ? 'No iPhone, as notificações funcionam com o app instalado na Tela de Início (veja “Instalar aplicativo”).' : 'Este navegador não oferece notificações. Você continua vendo tudo em Notificações, dentro do app.'}</p>,
    unconfigured: <p className="text-sm text-muted">Notificações no aparelho não estão disponíveis no momento. Você continua vendo tudo em Notificações, dentro do app.</p>,
  }[push.state];
  return (
    <div className="space-y-2">
      <p className="font-medium text-sm">Neste aparelho</p>
      {body}
      {push.error && <Alert tone="warning">{push.error}</Alert>}
      <details open={diag} onToggle={(e) => setDiag((e.target as HTMLDetailsElement).open)} className="text-xs text-muted">
        <summary className="cursor-pointer min-h-9 inline-flex items-center">Precisa de ajuda? Informações para o suporte</summary>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 mt-1">
          <dt>Recurso de notificação</dt><dd>{push.state === 'unsupported' ? 'indisponível' : 'disponível'}</dd>
          <dt>Permissão</dt><dd>{{ granted: 'permitida', denied: 'bloqueada', default: 'não pedida' }[push.permission] || push.permission}</dd>
          <dt>Inscrição deste aparelho</dt><dd>{push.state === 'on' ? 'registrada' : 'não registrada'}</dd>
          <dt>Serviço do app</dt><dd>{sw}</dd>
          <dt>Modo aplicativo</dt><dd>{standalone ? 'sim' : 'não detectado'}</dd>
        </dl>
      </details>
    </div>
  );
}

function InstallSection() {
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = /Instagram|FBAN|FBAV|Line\/|WhatsApp/i.test(ua);
  return (
    <Section id="instalar" icon={Smartphone} title="Instalar aplicativo">
      {isInstalled ? <p className="text-sm text-success">Você está usando o aplicativo instalado.</p>
        : inApp ? <Alert tone="warning">Você abriu por dentro de outro aplicativo. Abra este endereço no Chrome (Android) ou no Safari (iPhone) para instalar.</Alert>
        : isInstallable ? <div className="space-y-2"><p className="text-sm">Instale para abrir direto da tela inicial, com a marca do condomínio.</p><Button onClick={() => promptInstall()}>Instalar aplicativo</Button></div>
        : ios ? <ol className="text-sm list-decimal pl-5 space-y-1"><li>Abra no Safari.</li><li>Toque em Compartilhar (quadrado com seta).</li><li>Escolha “Adicionar à Tela de Início”.</li></ol>
        : <p className="text-sm">No menu do navegador (⋮), procure “Instalar app” ou “Adicionar à tela inicial”. Se não aparecer, o app pode já estar instalado neste aparelho.</p>}
    </Section>
  );
}
