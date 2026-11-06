import React, { useEffect, useState } from 'react';
import { api, rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { unitName } from '../../lib/format';
import { normEmail, validEmail } from '../../lib/resident-signup';
import { UnitRow } from '../../lib/packages';
import { Alert, Button, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../components/ui';

// Gestão de cadastro do morador pelo síndico (permissão "approve"). O servidor valida tudo de novo
// (migration 20261106000300_resident_management.sql); aqui só formulários e confirmações.

const PHONE_HINT = 'Celular com DDD, ex.: (11) 98888-7777. Exterior: + DDI e número, ex.: +351 912 345 678.';
const STATUS: [string, string][] = [['active', 'Ativo — vê encomendas e recebe avisos'], ['pending', 'Pendente — acesso suspenso até nova decisão'], ['revoked', 'Revogado — sem acesso']];

function UnitSelect({ units, value, onChange, current }: { units: UnitRow[]; value: string; onChange: (v: string) => void; current?: string | null }) {
  const t = useTenant();
  return (
    <Select required value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Selecione…</option>
      {units.filter((u) => u.active || u.id === current).map((u) => <option key={u.id} value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}
    </Select>
  );
}

/** Editar morador: nome, telefone e e-mail de CONTATO neste condomínio, unidade e situação. */
export function ResidentEditModal({ userId, units, onClose, onDone }: { userId: string; units: UnitRow[]; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [r, setR] = useState<any>(null);
  const [f, setF] = useState({ name: '', phone: '', email: '', unit: '', from: '', status: 'active' });
  const { busy, run } = useAction();
  useEffect(() => {
    rpc<any>('resident_admin_get', { p_tenant: t.tenant.id, p_user: userId }).then((x) => {
      const from = x.units.find((u: any) => u.status === 'active') || x.units[0];
      setR(x);
      setF({ name: x.full_name || '', phone: x.contact_phone || '', email: x.contact_email || '', unit: from?.unit_id || '', from: from?.unit_id || '', status: x.status });
    }).catch((e) => { toast.error(e.message); onClose(); });
  }, [t.tenant.id, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (f.email && !validEmail(f.email)) return toast.error('E-mail de contato inválido.');
    if (f.unit !== f.from && f.from && !confirm('Trocar de unidade cria um vínculo novo: encomendas e comprovantes anteriores da unidade nova não ficam visíveis para o morador, e ele deixa de ver os da unidade antiga. Continuar?')) return;
    run(async () => {
      await rpc('resident_update', { p_tenant: t.tenant.id, p_user: userId, p_full_name: f.name, p_phone: f.phone || null, p_email: f.email ? normEmail(f.email) : null,
        p_unit: f.unit || null, p_from_unit: f.from || null, p_status: f.status });
      onDone();
    }, 'Cadastro atualizado.');
  };
  return (
    <Modal title="Editar morador" onClose={onClose}>
      {!r ? <Spinner /> : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Nome"><Input required minLength={2} maxLength={120} value={f.name} onChange={(e) => set('name')(e.target.value)} /></Field>
          <Field label="Telefone / WhatsApp" hint={PHONE_HINT}><Input type="tel" inputMode="tel" maxLength={24} value={f.phone} onChange={(e) => set('phone')(e.target.value)} /></Field>
          <Field label="E-mail de contato" hint="Usado nos avisos deste condomínio."><Input type="email" maxLength={254} value={f.email} onChange={(e) => set('email')(e.target.value)} /></Field>
          <Alert tone="info">
            E-mail de login: <strong className="break-all">{r.login_email}</strong>. Ele não é alterado aqui: é a conta pessoal do morador{r.shared_account ? ', usada também em outro condomínio ou na equipe' : ''}.
            Para trocar, o próprio morador altera na conta dele (com confirmação no e-mail novo).
          </Alert>
          {r.units.length > 1 && (
            <Field label="Sai da unidade">
              <Select value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, unit: e.target.value })}>
                {r.units.map((u: any) => <option key={u.unit_id} value={u.unit_id}>{unitName(u.block, u.label, t.unitLabels)}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Unidade"><UnitSelect units={units} value={f.unit} onChange={set('unit')} current={f.from} /></Field>
          <Field label="Situação"><Select value={f.status} onChange={(e) => set('status')(e.target.value)}>{STATUS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          {r.pending_request && <p className="text-xs text-muted">Há uma solicitação pendente deste morador na aba Solicitações.</p>}
          <Button type="submit" loading={busy} className="w-full">Salvar</Button>
        </form>
      )}
    </Modal>
  );
}

/** Excluir cadastro do morador neste condomínio (a conta pessoal e o histórico ficam). */
export function ResidentDeleteModal({ member, onClose, onDone }: { member: { user_id: string; full_name?: string | null; email: string }; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [typed, setTyped] = useState('');
  const { busy, run } = useAction();
  const del = () => run(async () => {
    await rpc('resident_delete', { p_tenant: t.tenant.id, p_user: member.user_id });
    onDone();
  }, 'Cadastro excluído.');
  return (
    <Modal title={`Excluir ${member.full_name || member.email}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p>Remove o cadastro desta pessoa <strong>neste condomínio</strong>: vínculo com a unidade, contatos, avisos e notificações. Solicitações pendentes, convites e cadastros não concluídos deste condomínio são cancelados.</p>
        <p className="text-muted">Ficam guardados: encomendas, comprovantes de retirada, registros de auditoria e aceites do termo de dados. A conta pessoal (e-mail de login) não é apagada e continua valendo em outros condomínios. Para voltar, a pessoa precisa de novo convite ou nova aprovação.</p>
        <Field label='Digite EXCLUIR para confirmar'><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
        <div className="flex gap-2">
          <Button variant="danger" loading={busy} disabled={typed.trim().toUpperCase() !== 'EXCLUIR'} onClick={del}>Excluir cadastro</Button>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Corrigir solicitação pendente (aprovação e aceite do termo continuam exigidos). */
export function AccessRequestEditModal({ request, units, onClose, onDone }: { request: any; units: UnitRow[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: request.full_name || '', phone: request.phone || '', block: request.block_text || '', unitText: request.unit_text || '', unit: request.unit_id || '' });
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      await rpc('access_request_admin_update', { p_request: request.id, p_full_name: f.name, p_phone: f.phone || null, p_block: f.block || null, p_unit_text: f.unitText, p_unit: f.unit || null });
      onDone();
    }, 'Solicitação atualizada.');
  };
  return (
    <Modal title="Editar solicitação" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nome"><Input required minLength={2} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Telefone / WhatsApp" hint={PHONE_HINT}><Input type="tel" inputMode="tel" maxLength={24} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Bloco informado"><Input maxLength={30} value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} /></Field>
          <Field label="Unidade informada"><Input required maxLength={30} value={f.unitText} onChange={(e) => setF({ ...f, unitText: e.target.value })} /></Field>
        </div>
        <Field label="Unidade cadastrada" hint="Opcional: vincula a solicitação a uma unidade existente.">
          <Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
            <option value="">Nenhuma</option>
            {units.filter((u) => u.active).map((u) => <UnitOption key={u.id} u={u} />)}
          </Select>
        </Field>
        <p className="text-xs text-muted">O e-mail da conta e o aceite do termo de dados não são editáveis. Aprovar continua exigindo o aceite registrado.</p>
        <Button type="submit" loading={busy} className="w-full">Salvar</Button>
      </form>
    </Modal>
  );
}

function UnitOption({ u }: { u: UnitRow }) {
  const t = useTenant();
  return <option value={u.id}>{unitName(u.block, u.label, t.unitLabels)}</option>;
}

/** Editar convite pendente: unidade no lugar; e-mail novo = revoga e envia outro convite (link novo). */
export function InvitationEditModal({ invite, units, onClose, onDone }: { invite: any; units: UnitRow[]; onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [email, setEmail] = useState(invite.email);
  const [unit, setUnit] = useState(invite.unit_id || '');
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validEmail(email)) return toast.error('E-mail inválido.');
    run(async () => {
      if (normEmail(email) === invite.email) {
        await rpc('invitation_update', { p_invitation: invite.id, p_unit: unit });
        toast.success('Convite atualizado.');
        return onDone();
      }
      await rpc('revoke_invitation', { p_invitation: invite.id });
      const r = await api('/api/invitations/send', { tenantId: t.tenant.id, email: normEmail(email), role: 'morador', unitId: unit, permissions: [] });
      if (r.manualLink) setLink(r.manualLink);
      else { toast.success('Convite anterior revogado e novo convite enviado.'); onDone(); }
    });
  };
  return (
    <Modal title="Editar convite" onClose={link ? onDone : onClose}>
      {link ? (
        <div className="space-y-3">
          <Alert tone="warning">O convite foi criado, mas o e-mail não pôde ser enviado. Envie este link à pessoa por um canal seguro:</Alert>
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-mail" hint="Mudar o e-mail revoga este convite e envia um novo (o link antigo deixa de valer)."><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Unidade"><UnitSelect units={units} value={unit} onChange={setUnit} /></Field>
          <Button type="submit" loading={busy} className="w-full">Salvar</Button>
        </form>
      )}
    </Modal>
  );
}
