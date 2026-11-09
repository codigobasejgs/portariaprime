import React, { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api, rpc } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../../components/ui';
import { useSensitive } from '../../../components/Reauth';
import { PorterLinkModal } from './PorterLinkModal';

const ROLE: Record<string, string> = { admin: 'Administrador', porteiro: 'Porteiro' };
const PERM: Record<string, string> = { team: 'equipe', approve: 'aprova moradores', settings: 'configurações', billing: 'pagamentos' };

/** Equipe (administradores e porteiros): convites, papéis e revogação. Moradores ficam em Unidades e moradores. */
export function TeamCard() {
  const t = useTenant();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [porterLink, setPorterLink] = useState(false);
  const [resetting, setResetting] = useState<any>(null);
  const [local, setLocal] = useState<Set<string>>(new Set());
  const { busy, run } = useAction();
  const load = useCallback(() => Promise.all([
    rpc<any[]>('list_members', { p_tenant: t.tenant.id }),
    rpc<any[]>('staff_login_accounts_list', { p_tenant: t.tenant.id }).catch(() => []),
  ]).then(([m, s]) => { setRows(m.filter((x) => x.role !== 'morador')); setLocal(new Set((s || []).map((x) => x.user_id))); setError(null); })
    .catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  if (!t.can('team')) return null;
  const toggle = (m: any) => {
    const revoking = m.status === 'active';
    if (revoking && !confirm(`Revogar o acesso de ${m.full_name || m.email}? A pessoa perde o acesso imediatamente, mesmo com o app aberto.`)) return;
    run(async () => { await rpc('set_membership_status', { p_membership: m.membership_id, p_status: revoking ? 'revoked' : 'active' }); await load(); },
      revoking ? 'Acesso revogado.' : 'Acesso reativado.');
  };
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">Pessoas da equipe</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPorterLink(true)}>Link/QR de porteiro</Button>
          <Button variant="secondary" onClick={() => setCreating(true)}>Criar acesso com senha</Button>
          <Button variant="secondary" onClick={() => setInviting(true)} data-tour="config-equipe">Convidar por e-mail</Button>
        </div>
      </div>
      <p className="text-xs text-muted">"Criar acesso com senha": para porteiros e administradores que só fazem login (o e-mail não precisa receber mensagens). "Convidar por e-mail": a pessoa recebe um link e define a própria senha.</p>
      {error ? <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>
        : !rows ? <Spinner /> : rows.length === 0 ? <Empty title="Ninguém na equipe ainda" /> : (
          <ul className="divide-y divide-line">
            {rows.map((m) => (
              <li key={m.membership_id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <strong>{m.full_name || m.email}</strong>{m.full_name && <span className="text-muted"> · {m.email}</span>}{' '}
                  <Badge tone={m.role === 'admin' ? 'accent' : 'neutral'}>{ROLE[m.role] || m.role}</Badge>{' '}
                  {m.status !== 'active' && <Badge tone="danger">revogado</Badge>}
                  {local.has(m.user_id) && <Badge tone="neutral">acesso com senha</Badge>}
                  {m.role === 'admin' && m.permissions?.length > 0 && <span className="block text-xs text-muted">Pode: {m.permissions.map((p: string) => PERM[p] || p).join(', ')}</span>}
                </span>
                <span className="flex flex-wrap gap-1">
                  {local.has(m.user_id) && m.status === 'active' && <Button variant="ghost" onClick={() => setResetting(m)}>Trocar senha</Button>}
                  <Button variant="ghost" loading={busy} onClick={() => toggle(m)}>{m.status === 'active' ? 'Revogar acesso' : 'Reativar'}</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      {inviting && <InviteTeamModal onClose={() => setInviting(false)} onDone={() => { setInviting(false); load(); }} />}
      {creating && <CreateAccessModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); }} />}
      {porterLink && <PorterLinkModal onClose={() => setPorterLink(false)} />}
      {resetting && <ResetPasswordModal member={resetting} onClose={() => setResetting(null)} />}
    </Card>
  );
}

const PERMS: [string, string][] = [['team', 'Gerenciar equipe'], ['approve', 'Aprovar moradores'], ['settings', 'Configurações e marca'], ['billing', 'Assinatura e pagamentos']];

/** Senha: 10+ caracteres com letras e números (o servidor confere de novo). */
function PasswordFields({ value, onChange }: { value: [string, string]; onChange: (v: [string, string]) => void }) {
  const [show, setShow] = useState(false);
  return <>
    <Field label="Senha" hint="Mínimo de 10 caracteres, com letras e números.">
      <Input type={show ? 'text' : 'password'} autoComplete="new-password" required minLength={10} maxLength={72} value={value[0]} onChange={(e) => onChange([e.target.value, value[1]])} /></Field>
    <Field label="Confirme a senha" error={value[1] && value[0] !== value[1] ? 'As senhas não conferem.' : null}>
      <Input type={show ? 'text' : 'password'} autoComplete="new-password" required value={value[1]} onChange={(e) => onChange([value[0], e.target.value])} /></Field>
    <label className="flex gap-2 items-center text-sm min-h-9"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostrar senha</label>
  </>;
}
const pwOk = ([a, b]: [string, string]) => a.length >= 10 && /[A-Za-z]/.test(a) && /\d/.test(a) && a === b;

function CreateAccessModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [f, setF] = useState({ fullName: '', email: '', role: 'porteiro' });
  const [perms, setPerms] = useState<string[]>(['approve']);
  const [pw, setPw] = useState<[string, string]>(['', '']);
  const [done, setDone] = useState<string | null>(null);
  const { guard, dialog } = useSensitive('Criar um acesso à equipe do condomínio. Confirme sua identidade.');
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwOk(pw)) return toast.error('Senha fraca ou diferente da confirmação.');
    run(guard(async () => {
      const r = await api<{ email: string }>('/api/team/create', { tenantId: t.tenant.id, email: f.email, fullName: f.fullName, role: f.role,
        permissions: f.role === 'admin' ? perms : [], password: pw[0] });
      setPw(['', '']); setDone(r.email);
    }));
  };
  if (done) return (
    <Modal title="Acesso criado" onClose={onDone}>
      <div className="space-y-3 text-sm">
        <Alert tone="success">Pronto. <strong>{f.fullName}</strong> já pode entrar com o e-mail <strong>{done}</strong> e a senha definida.</Alert>
        <p>Entregue a senha pessoalmente ou por um canal seguro. Ela não é enviada por e-mail e não aparece de novo aqui.</p>
        <p className="text-muted">Esqueceu a senha? Use "Trocar senha" na lista da equipe.</p>
        <Button className="w-full" onClick={onDone}>Concluir</Button>
      </div>
    </Modal>
  );
  return (
    <Modal title="Criar acesso com senha" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome de quem vai usar"><Input required minLength={2} maxLength={120} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} placeholder="Ex.: Portaria Turno Noite" /></Field>
        <Field label="E-mail de login" hint="Só para entrar no sistema; não precisa receber mensagens. Ex.: portaria.noite@seucondominio.com.br">
          <Input type="email" required autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Papel">
          <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            <option value="porteiro">Porteiro — recebe e entrega encomendas</option>
            <option value="admin">Administrador — síndico/gestão</option>
          </Select>
        </Field>
        {f.role === 'admin' && (
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium mb-1">Permissões do administrador</legend>
            {PERMS.map(([k, l]) => (
              <label key={k} className="flex gap-2 items-center min-h-9"><input type="checkbox" checked={perms.includes(k)} onChange={(e) => setPerms(e.target.checked ? [...perms, k] : perms.filter((x) => x !== k))} /> {l}</label>
            ))}
          </fieldset>
        )}
        <PasswordFields value={pw} onChange={setPw} />
        <Alert>Sem caixa de entrada, a pessoa não consegue recuperar a senha sozinha: o síndico troca a senha por aqui.</Alert>
        <Button type="submit" loading={busy} disabled={!pwOk(pw)} className="w-full">Criar acesso</Button>
      </form>
      {dialog}
    </Modal>
  );
}

function ResetPasswordModal({ member, onClose }: { member: any; onClose: () => void }) {
  const t = useTenant();
  const [pw, setPw] = useState<[string, string]>(['', '']);
  const { guard, dialog } = useSensitive('Trocar a senha de um acesso da equipe. Confirme sua identidade.');
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwOk(pw)) return toast.error('Senha fraca ou diferente da confirmação.');
    run(guard(async () => {
      await api('/api/team/password', { tenantId: t.tenant.id, userId: member.user_id, password: pw[0] });
      setPw(['', '']); onClose();
    }), 'Senha trocada. Quem estava conectado com a senha antiga precisa entrar de novo.');
  };
  return (
    <Modal title={`Trocar senha — ${member.full_name || member.email}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Login: <strong>{member.email}</strong>. A senha antiga deixa de funcionar e as sessões abertas são encerradas.</p>
        <PasswordFields value={pw} onChange={setPw} />
        <Button type="submit" loading={busy} disabled={!pwOk(pw)} className="w-full">Salvar nova senha</Button>
      </form>
      {dialog}
    </Modal>
  );
}

function InviteTeamModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('porteiro');
  const [perms, setPerms] = useState<string[]>(['team', 'approve', 'settings']);
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/invitations/send', { tenantId: t.tenant.id, email, role, unitId: null, permissions: role === 'admin' ? perms : [] });
      if (r.manualLink) setLink(r.manualLink);
      else { toast.success('Convite enviado por e-mail.'); onDone(); }
    });
  };
  return (
    <Modal title="Convidar equipe" onClose={link ? onDone : onClose}>
      {link ? (
        <div className="space-y-3">
          <Alert tone="warning">O convite foi criado, mas o e-mail não pôde ser enviado (serviço de e-mail não configurado ou indisponível). Envie este link à pessoa por um canal seguro:</Alert>
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(link); toast.success('Link copiado.'); }}><Copy className="w-4 h-4" /> Copiar link</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-mail da pessoa" hint="O convite só funciona com este e-mail e vale 7 dias."><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Papel">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="porteiro">Porteiro — recebe e entrega encomendas</option>
              <option value="admin">Administrador — síndico/gestão</option>
            </Select>
          </Field>
          {role === 'admin' && (
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium mb-1">Permissões do administrador</legend>
              {PERMS.map(([k, l]) => (
                <label key={k} className="flex gap-2 items-center min-h-9"><input type="checkbox" checked={perms.includes(k)} onChange={(e) => setPerms(e.target.checked ? [...perms, k] : perms.filter((x) => x !== k))} /> {l}</label>
              ))}
            </fieldset>
          )}
          <Button type="submit" loading={busy} className="w-full">Enviar convite</Button>
        </form>
      )}
    </Modal>
  );
}
