import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { DEMO } from '../../../demo/mode';
import { useSensitive } from '../../../components/Reauth';
import { Bot, Trash2 } from 'lucide-react';
import { rpc } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, useAction } from '../../../components/ui';
import { LEVELS, type Level } from '../../../../api/_lib/assistant-text';
import { AssistantConnect } from './AssistantConnect';

// Número público do assistente: vem da configuração do build (definido quando o chip da plataforma for pareado).
const ASSISTANT_NUMBER = (import.meta.env.VITE_ASSISTANT_WHATSAPP as string | undefined)?.trim() || null;
// Simulador só na /demonstracao (carregado sob demanda; fora dela nem baixa).
const AssistantChat = lazy(() => import('../../../components/AssistantChat').then((m) => ({ default: m.AssistantChat })));
const fmtPhone = (p: string) => p.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');

/**
 * Portaria Prime IA no WhatsApp: números da equipe autorizados a consultar e operar o condomínio pelo WhatsApp,
 * cada um com um dos 3 níveis. Só quem gerencia a equipe ('team') vê e altera. O banco confere o nível a cada ação.
 */
export function AssistantCard() {
  const t = useTenant();
  const [rows, setRows] = useState<any[] | null>(null);
  const [team, setTeam] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<any | null>(null);
  const { busy, run } = useAction();
  // Autorizar um WhatsApp a agir em nome de alguém: o banco pede senha recente; o diálogo pede e repete a ação.
  const { guard, dialog } = useSensitive('Autorizar um WhatsApp a consultar e operar o condomínio. Confirme sua identidade.');
  const load = useCallback(() => Promise.all([
    rpc<any[]>('assistant_links_list', { p_tenant: t.tenant.id }), rpc<any[]>('assistant_team_options', { p_tenant: t.tenant.id }),
  ]).then(([l, m]) => { setRows(l); setTeam(m); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { if (t.can('team')) load(); }, [load, t]);
  if (!t.can('team')) return null;
  // Demonstração: o painel funciona com dados fictícios mesmo sem o plano com WhatsApp.
  const hasWhatsapp = DEMO || !!t.overview?.entitlements?.feature_whatsapp;

  const save = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    run(guard(async () => {
      await rpc('assistant_link_save', { p_tenant: t.tenant.id, p_id: edit.id || null, p_user: edit.user_id, p_phone: edit.phone, p_level: edit.level,
        p_label: edit.label || null, p_active: edit.active !== false });
      setEdit(null); await load();
    }), 'Número salvo.');
  };
  const remove = (r: any) => {
    if (!confirm(`Remover o WhatsApp ${fmtPhone(r.phone)} do assistente? Ele deixa de consultar e operar o condomínio na hora.`)) return;
    run(async () => { await rpc('assistant_link_delete', { p_tenant: t.tenant.id, p_id: r.id }); await load(); }, 'Número removido.');
  };

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold flex items-center gap-2"><Bot className="w-5 h-5" aria-hidden /> Portaria Prime IA no WhatsApp</p>
        {hasWhatsapp && <Button onClick={() => setEdit({ user_id: team[0]?.user_id || '', phone: '', level: 'basic', label: '', active: true })} disabled={!team.length}>Autorizar número</Button>}
      </div>
      <p className="text-sm text-muted">
        Síndico, administradores e porteiros consultam pendências, relatórios e fazem ações pelo próprio WhatsApp, sem abrir o sistema.
        Só respondemos aos números autorizados aqui. Toda alteração mostra um resumo e só acontece depois que a pessoa toca em <strong>✅ Confirmar</strong>.
      </p>
      {DEMO && <Suspense fallback={<Spinner />}><AssistantChat /></Suspense>}
      {!hasWhatsapp && !DEMO && <Alert tone="warning">O assistente no WhatsApp faz parte dos planos com WhatsApp. Veja em Plano e assinatura.</Alert>}
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(LEVELS) as Level[]).map((k, i) => (
          <div key={k} className="rounded-xl border border-line p-3 text-sm"><p className="font-semibold">Nível {i + 1} · {LEVELS[k].title}</p><p className="text-muted text-xs mt-1">{LEVELS[k].desc}</p></div>
        ))}
      </div>
      {hasWhatsapp && !DEMO && <AssistantConnect />}
      {ASSISTANT_NUMBER && <p className="text-sm">Sem número próprio conectado, a equipe autorizada também pode mandar <strong>“oi”</strong> para o WhatsApp do Portaria Prime IA: <strong>{ASSISTANT_NUMBER}</strong>.</p>}
      {error ? <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>
        : !rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nenhum número autorizado">Autorize o WhatsApp do síndico ou do zelador para começar.</Empty> : (
          <ul className="divide-y divide-line" aria-label="Números autorizados">
            {rows.map((r) => (
              <li key={r.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{fmtPhone(r.phone)}{r.label ? ` · ${r.label}` : ''}</p>
                  <p className="text-xs text-muted">{r.full_name} · {r.role === 'admin' ? 'Administrador' : 'Porteiro'}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.level === 'advanced' ? 'accent' : r.level === 'intermediate' ? 'success' : 'neutral'}>{LEVELS[r.level as Level].title}</Badge>
                  {!r.usable && <Badge tone="warning">{r.active ? 'Conta sem acesso' : 'Desativado'}</Badge>}
                  <Button variant="secondary" onClick={() => setEdit({ ...r })}>Editar</Button>
                  <Button variant="ghost" aria-label={`Remover ${fmtPhone(r.phone)}`} onClick={() => remove(r)}><Trash2 className="w-4 h-4" /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      {dialog}
      {edit && (
        <Modal title={edit.id ? 'Editar número do assistente' : 'Autorizar número no assistente'} onClose={() => setEdit(null)}>
          <form className="space-y-3" onSubmit={save}>
            <Field label="Pessoa da equipe" hint="O assistente age com as permissões desta conta: o que ela não pode no painel, também não pode no WhatsApp.">
              <Select value={edit.user_id} onChange={(e) => setEdit({ ...edit, user_id: e.target.value })} required>
                {team.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name} · {m.role === 'admin' ? 'Administrador' : 'Porteiro'}</option>)}
              </Select>
            </Field>
            <Field label="WhatsApp (com DDD)"><Input inputMode="tel" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} placeholder="11 99999-0000" required /></Field>
            <Field label="Nível de acesso">
              <Select value={edit.level} onChange={(e) => setEdit({ ...edit, level: e.target.value })}>
                {(Object.keys(LEVELS) as Level[]).map((k, i) => <option key={k} value={k}>Nível {i + 1} · {LEVELS[k].title}</option>)}
              </Select>
            </Field>
            <p className="text-xs text-muted">{LEVELS[edit.level as Level].desc}</p>
            <Field label="Identificação (opcional)"><Input value={edit.label || ''} onChange={(e) => setEdit({ ...edit, label: e.target.value })} maxLength={60} placeholder="Ex.: Zelador, Síndica" /></Field>
            {edit.id && <label className="flex items-center gap-2 text-sm min-h-11"><input type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Número ativo</label>}
            <Button type="submit" loading={busy} className="w-full">Salvar</Button>
          </form>
        </Modal>
      )}
    </Card>
  );
}
