import React, { useCallback, useEffect, useState } from 'react';
import { FileText, ShieldCheck } from 'lucide-react';
import { rpc } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { dateTime } from '../../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Modal, Spinner, toast, useAction } from '../../../components/ui';
import { useSensitive } from '../../../components/Reauth';

type Version = { id: string; version: string; title: string; content: string; hash: string; status: 'draft' | 'published' | 'archived';
  change_note: string | null; published_at: string | null; created_at: string; acknowledgements: number };
type Effective = { scope: 'global' | 'tenant'; version: string; title: string; content: string; hash: string; published_at: string | null };
type Admin = { effective: Effective | null; global_acknowledgements: number; default_title: string; default_content: string; versions: Version[] };
type Ack = { id: string; accepted_at: string; term_version: string; scope: 'global' | 'condominio'; full_name: string | null; unit_text: string | null; request_status: string | null };

const STATUS: Record<Version['status'], [string, 'success' | 'warning' | 'neutral']> = {
  published: ['Vigente', 'success'], draft: ['Rascunho', 'warning'], archived: ['Arquivada', 'neutral'],
};
const REQ: Record<string, string> = { pending: 'aguardando', approved: 'aprovado', rejected: 'recusado' };
const PAGE = 20;

/** Próxima versão sugerida: 1.0, depois 1.1, 1.2… (o síndico pode trocar). */
export function nextVersion(versions: { version: string }[]) {
  const nums = versions.map((v) => v.version.match(/^(\d+)\.(\d+)$/)).filter(Boolean).map((m) => [+m![1], +m![2]] as const);
  if (!nums.length) return '1.0';
  const [maj, min] = nums.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
  return `${maj}.${min + 1}`;
}

/**
 * Configurações → Privacidade e LGPD. Por padrão vale o termo global da Portaria Prime (mantido pela plataforma,
 * com o nome do condomínio). Termo próprio é opcional: publicado, substitui o global para os novos cadastros.
 * Publicado é imutável (nova versão arquiva a anterior com os aceites). Publicar pede a senha de novo.
 */
export function PrivacyTermCard() {
  const t = useTenant();
  const canEdit = t.can('settings');
  const canSeeAcks = t.can('approve');
  const [data, setData] = useState<Admin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<Version> | null>(null);
  const [viewing, setViewing] = useState<Version | null>(null);
  const [confirm, setConfirm] = useState<Version | null>(null);
  const { guard, dialog } = useSensitive('Publicar o termo altera o que todos os novos moradores aceitam no cadastro. Confirme sua identidade.');
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    setError(null);
    try { setData(await rpc<Admin>('privacy_terms_admin', { p_tenant: t.tenant.id })); } catch (e: any) { setError(e.message); }
  }, [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);

  if (error && !data) return <div className="space-y-3"><Alert tone="danger">{error}</Alert><Button variant="secondary" onClick={load}>Tentar novamente</Button></div>;
  if (!data) return <Spinner />;
  const current = data.versions.find((v) => v.status === 'published');
  const draft = data.versions.find((v) => v.status === 'draft');

  const eff = data.effective;
  const startDraft = () => setEditing(current
    ? { version: nextVersion(data.versions), title: current.title, content: current.content, change_note: '' }
    : { version: nextVersion(data.versions), title: eff?.title || data.default_title, content: eff?.content || data.default_content, change_note: '' });

  const publish = (v: Version) => guard(async () => {
    const r = await rpc<{ version: string }>('privacy_term_publish', { p_tenant: t.tenant.id, p_id: v.id });
    setConfirm(null);
    toast.success(`Versão ${r.version} publicada. Novos cadastros passam a aceitar esta versão.`);
    await load();
  });

  return (
    <div className="space-y-4">
      {!current ? (eff ? (
        <Card className="space-y-2">
          <div className="flex flex-wrap items-center gap-2"><ShieldCheck className="w-5 h-5 text-success" aria-hidden /><p className="font-semibold">Termo padrão Portaria Prime: versão {eff.version}</p><Badge tone="success">Vigente</Badge></div>
          <p className="text-sm text-muted">Mantido pela Portaria Prime e exibido com o nome do seu condomínio. É o que os moradores leem e aceitam no cadastro · {data.global_acknowledgements} aceite(s) neste condomínio.</p>
          <div className="flex flex-wrap gap-2 pt-1"><Button variant="secondary" onClick={() => setViewing({ ...eff, id: 'global', status: 'published', change_note: null, created_at: '', acknowledgements: data.global_acknowledgements } as Version)}>Ver texto vigente</Button></div>
        </Card>
      ) : (
        <Alert tone="warning"><strong>Termo indisponível.</strong> Não foi possível carregar o termo vigente. Recarregue a página ou fale com o suporte.</Alert>
      )) : (
        <Card className="space-y-2">
          <div className="flex flex-wrap items-center gap-2"><ShieldCheck className="w-5 h-5 text-success" aria-hidden /><p className="font-semibold">Termo vigente: versão {current.version}</p><Badge tone="success">Vigente</Badge></div>
          <p className="text-sm text-muted">Publicado em {dateTime(current.published_at, t.tenant.timezone)} · {current.acknowledgements} aceite(s) nesta versão.</p>
          <div className="flex flex-wrap gap-2 pt-1"><Button variant="secondary" onClick={() => setViewing(current)}>Ver texto vigente</Button></div>
        </Card>
      )}

      <Alert>O texto-base é um modelo inicial e não substitui a orientação jurídica. Revise com a administração e a assessoria do condomínio antes de publicar. O aceite registra ciência do documento; não define, sozinho, a base legal do tratamento.</Alert>

      {canEdit && !editing && (
        draft
          ? <Card className="space-y-2"><p className="font-semibold">Rascunho da versão {draft.version}</p><p className="text-sm text-muted">Ainda não vale para os moradores.</p>
              <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setEditing(draft)}>Continuar editando</Button><Button onClick={() => setConfirm(draft)}>Publicar versão {draft.version}</Button></div></Card>
          : <div className="space-y-1"><Button variant={current ? 'primary' : 'secondary'} onClick={startDraft}><FileText className="w-4 h-4" aria-hidden /> {current ? 'Criar nova versão' : 'Criar termo próprio (opcional)'}</Button>
              {!current && <p className="text-xs text-muted">Opcional: publicado, o termo próprio substitui o padrão para os novos cadastros deste condomínio.</p>}</div>
      )}
      {!canEdit && <p className="text-sm text-muted">Somente quem altera as configurações do condomínio pode editar e publicar o termo.</p>}

      {editing && <Editor initial={editing} isNew={!editing.id} busy={busy} onCancel={() => setEditing(null)} onSave={(v) => run(async () => {
        await rpc('privacy_term_save', { p_tenant: t.tenant.id, p_id: editing.id ?? null, p_version: v.version, p_title: v.title, p_content: v.content, p_note: v.change_note || null });
        toast.success('Rascunho salvo. Publique quando estiver revisado.');
        setEditing(null);
        await load();
      })} />}

      <section aria-labelledby="termo-versoes" className="space-y-2">
        <h2 id="termo-versoes" className="font-semibold">Termo próprio do condomínio — versões</h2>
        {data.versions.length === 0 ? <p className="text-sm text-muted">Nenhuma versão própria. Vale o termo padrão.</p> : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {data.versions.map((v) => (
              <li key={v.id} className="p-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-semibold">v{v.version}</span><Badge tone={STATUS[v.status][1]}>{STATUS[v.status][0]}</Badge>
                <span className="text-muted">{v.published_at ? `publicada ${dateTime(v.published_at, t.tenant.timezone)}` : `criada ${dateTime(v.created_at, t.tenant.timezone)}`}</span>
                <span className="text-muted">{v.acknowledgements} aceite(s)</span>
                {v.change_note && <span className="text-muted basis-full">Alteração: {v.change_note}</span>}
                <span className="text-xs text-muted basis-full font-mono break-all" title="Impressão digital do texto (SHA-256)">{v.hash}</span>
                <button className="underline text-secondary" onClick={() => setViewing(v)}>Ler</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canSeeAcks && <Acknowledgements />}

      {viewing && <Modal title={`${viewing.title} — v${viewing.version}`} onClose={() => setViewing(null)} wide>
        <div className="max-h-[60vh] overflow-y-auto space-y-2 text-sm" tabIndex={0}>{viewing.content.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
      </Modal>}
      {confirm && <Modal title={`Publicar versão ${confirm.version}?`} onClose={() => setConfirm(null)}>
        <div className="space-y-3 text-sm">
          <p>A partir da publicação, todo novo cadastro de morador exigirá a leitura e a ciência <strong>desta versão</strong>{!current ? ', no lugar do termo padrão' : ''}.</p>
          {current && <p>A versão {current.version} será arquivada. Os {current.acknowledgements} aceite(s) dela continuam registrados.</p>}
          <p>O texto publicado não pode ser alterado; mudanças exigem nova versão.</p>
          <div className="flex flex-wrap gap-2"><Button onClick={() => run(publish(confirm))} loading={busy}>Publicar agora</Button><Button variant="ghost" onClick={() => setConfirm(null)}>Cancelar</Button></div>
        </div>
      </Modal>}
      {dialog}
    </div>
  );
}

function Editor({ initial, isNew, busy, onCancel, onSave }: { initial: Partial<Version>; isNew: boolean; busy: boolean; onCancel: () => void;
  onSave: (v: { version: string; title: string; content: string; change_note: string }) => void }) {
  const [v, setV] = useState({ version: initial.version || '1.0', title: initial.title || '', content: initial.content || '', change_note: initial.change_note || '' });
  const versionOk = /^[A-Za-z0-9.-]{1,20}$/.test(v.version);
  const ok = versionOk && v.title.trim().length >= 3 && v.content.trim().length >= 50;
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(v); }}>
        <p className="font-semibold">{isNew ? 'Novo rascunho' : `Editar rascunho v${initial.version}`}</p>
        <div className="grid sm:grid-cols-[160px_1fr] gap-4">
          <Field label="Versão" hint="Ex.: 1.0, 1.1" error={!versionOk ? 'Use letras, números, ponto ou hífen.' : null}>
            <Input value={v.version} onChange={(e) => setV({ ...v, version: e.target.value })} disabled={!isNew} maxLength={20} required />
          </Field>
          <Field label="Título"><Input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} maxLength={200} required /></Field>
        </div>
        <Field label="Texto do termo" hint={`${v.content.length.toLocaleString('pt-BR')} caracteres (mínimo 50). Separe parágrafos com uma linha em branco.`}>
          <textarea className="w-full min-h-72 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent"
            value={v.content} onChange={(e) => setV({ ...v, content: e.target.value })} maxLength={50000} required />
        </Field>
        <Field label="O que mudou (opcional)"><Input value={v.change_note} onChange={(e) => setV({ ...v, change_note: e.target.value })} maxLength={300} /></Field>
        <div className="flex flex-wrap gap-2"><Button type="submit" loading={busy} disabled={!ok}>Salvar rascunho</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button></div>
      </form>
    </Card>
  );
}

function Acknowledgements() {
  const t = useTenant();
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; rows: Ack[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    setError(null);
    rpc<{ total: number; rows: Ack[] }>('privacy_acknowledgements_list', { p_tenant: t.tenant.id, p_limit: PAGE, p_offset: page * PAGE })
      .then((d) => { if (on) setData(d); }).catch((e) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, [t.tenant.id, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE)) : 1;
  return (
    <section aria-labelledby="termo-aceites" className="space-y-2">
      <h2 id="termo-aceites" className="font-semibold">Registros de aceite</h2>
      <p className="text-sm text-muted">Cada aceite guarda a versão, a impressão digital do texto e a data e hora do servidor. Registros não podem ser alterados nem apagados.</p>
      {error ? <Alert tone="danger">{error}</Alert> : !data ? <Spinner /> : data.total === 0 ? <p className="text-sm text-muted">Nenhum aceite registrado.</p> : (<>
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left"><tr><th className="p-2 font-medium">Morador</th><th className="p-2 font-medium">Unidade</th><th className="p-2 font-medium">Versão</th><th className="p-2 font-medium">Aceito em</th><th className="p-2 font-medium">Cadastro</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.rows.map((r) => (
                <tr key={r.id}><td className="p-2">{r.full_name || '—'}</td><td className="p-2">{r.unit_text || '—'}</td><td className="p-2">v{r.term_version}{r.scope === 'global' ? ' (padrão)' : ''}</td>
                  <td className="p-2 whitespace-nowrap">{dateTime(r.accepted_at, t.tenant.timezone)}</td><td className="p-2">{REQ[r.request_status || ''] || r.request_status || '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && <div className="flex items-center gap-2 text-sm"><Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button>
          <span>Página {page + 1} de {pages}</span><Button variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Próxima</Button></div>}
      </>)}
    </section>
  );
}
