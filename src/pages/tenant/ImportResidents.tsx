import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import type { UnitRow } from '../../lib/packages';
import { autoMap, buildImport, Mapping, REASONS, Reason, readTable } from '../../lib/resident-import';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../components/ui';
import { DEMO } from '../../demo/mode';

/** Pré-cadastro por planilha (só quem aprova): não cria conta nem vínculo; convida unidades sem cadastro. */
const STATUS: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger' | 'accent']> = {
  pending: ['Pré-cadastrado', 'neutral'], queued: ['Convite na fila', 'accent'], sent_whatsapp: ['Convite enviado (WhatsApp)', 'success'],
  sent_email: ['Convite enviado (e-mail)', 'success'], no_contact: ['Sem contato', 'warning'], completed: ['Cadastro enviado', 'success'],
};
const PLAN: Record<string, string> = {
  unidade_cadastrada: 'Unidade já tem cadastro', unidade_inativa: 'Unidade inativa', convite_usado: 'Convite já usado',
  ja_convidado: 'Convite ainda válido', sem_contato: 'Sem contato no canal', tipo_nao_morador: 'Não morador (autorizado/prestador)',
  contato_existente: 'Contato já cadastrado em outra conta', destinatario_repetido: 'Mesmo contato em mais de uma unidade',
};
const FIELDS: [keyof Omit<Mapping, 'phones' | 'emails'>, string][] = [['name', 'Nome'], ['unit', 'Unidade (texto)'], ['block', 'Bloco/Quadra'], ['apto', 'Apto/Casa'], ['kind', 'Tipo']];

/** Planilha fictícia da demonstração (unidades do seed). */
const DEMO_CSV = 'Nome;Unidade;Tipo;Celular;E-mail\nLívia Martins;A-102;Locatário;(11) 90000-1102;livia@exemplo.invalid\n'
  + 'Otávio Reis;C-301;Proprietário;(11) 90000-1301;\nSofia Antunes;C-302;Morador;;sofia@exemplo.invalid\nTiago Brito;B-201;Proprietário;(11) 90000-2201;\n'
  + 'Rosa (DIARISTA);B-201;Prestador;(11) 90000-9999;\nVera Lúcia;B-202;Morador;;\nCarlos Sem Unidade;C-999;Morador;(11) 90000-3999;\n';

export function ImportResidents({ units }: { units: UnitRow[] }) {
  const t = useTenant();
  const [list, setList] = useState<{ entries: any[]; counts: Record<string, number> } | null>(null);
  const load = useCallback(() => rpc<any>('resident_import_list', { p_tenant: t.tenant.id }).then(setList).catch((e) => toast.error(e.message)), [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-4">
      <Alert tone="info">A planilha só guarda um pré-cadastro, visível apenas para a administração. Ninguém ganha acesso por ela:
        o convite leva o morador ao cadastro já preenchido e a solicitação continua passando pela sua aprovação.</Alert>
      <Upload units={units} onSaved={load} />
      {!list ? <Spinner /> : <Entries list={list} onChanged={load} />}
    </div>
  );
}

function Upload({ units, onSaved }: { units: UnitRow[]; onSaved: () => void }) {
  const t = useTenant();
  const [file, setFile] = useState<{ name: string; table: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [others, setOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const result = useMemo(() => (file && mapping ? buildImport(file.table, units, { mapping, includeOthers: others }) : null), [file, mapping, others, units]);

  const open = async (name: string, bytes: Uint8Array) => {
    setError(null); setFile(null);
    try {
      const table = await readTable(bytes, name);
      if (table.length < 2) throw new Error('Planilha vazia ou sem linhas abaixo do cabeçalho.');
      setFile({ name, table }); setMapping(autoMap(table[0]));
    } catch (e: any) { setError(e?.message || 'Não foi possível ler o arquivo.'); }
  };
  const save = () => run(async () => {
    const r = result!;
    const rows = r.rows.map(({ unit_id, full_name, kind, phone, email, extra }) => ({ unit_id, full_name, kind, phone, email, extra }));
    // Lote guarda só contagens (nada de nome/telefone).
    const stats = { linhas: r.total, pessoas: r.rows.length, unidades: r.unitsWithPeople, com_whatsapp: r.withWhatsapp, descartes: r.discards };
    const s = await rpc<any>('resident_import_save', { p_tenant: t.tenant.id, p_rows: rows, p_stats: stats });
    toast.success(`Pré-cadastro salvo: ${s.inserted} novos, ${s.updated} atualizados${s.skipped ? `, ${s.skipped} ignorados` : ''}.`);
    setFile(null); setMapping(null); onSaved();
  });

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Importar planilha de moradores</h2>
      <p className="text-sm text-muted">Arquivo .csv ou .xlsx exportado de outro sistema. As colunas são reconhecidas pelo cabeçalho; ajuste se precisar.</p>
      <div className="flex flex-wrap gap-2 items-center">
        <input type="file" accept=".csv,.txt,.tsv,.xlsx,.xls" aria-label="Planilha de moradores" className="text-sm"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) await open(f.name, new Uint8Array(await f.arrayBuffer())); e.target.value = ''; }} />
        {DEMO && <Button variant="secondary" type="button" onClick={() => open('exemplo.csv', new TextEncoder().encode(DEMO_CSV))}>Usar planilha de exemplo</Button>}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {file && mapping && result && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {FIELDS.map(([k, label]) => (
              <Field key={k} label={label}>
                <Select value={mapping[k] ?? ''} onChange={(e) => setMapping({ ...mapping, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="">—</option>
                  {result.header.map((h, i) => <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>)}
                </Select>
              </Field>
            ))}
          </div>
          <p className="text-xs text-muted">Telefones: {mapping.phones.map((i) => result.header[i]).join(', ') || 'nenhuma coluna'} · E-mails: {mapping.emails.map((i) => result.header[i]).join(', ') || 'nenhuma coluna'}</p>
          <label className="flex gap-2 items-center text-sm">
            <input type="checkbox" className="w-5 h-5" checked={others} onChange={(e) => setOthers(e.target.checked)} />
            Incluir autorizados, prestadores e funcionários <span className="text-muted">(ficam no pré-cadastro, nunca recebem convite)</span>
          </label>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            {([['Linhas', result.total], ['Pessoas válidas', result.rows.length], ['Unidades com pessoa', result.unitsWithPeople], ['Unidades com WhatsApp', result.withWhatsapp]] as const).map(([k, v]) => (
              <div key={k} className="rounded-xl bg-surface-2 p-3"><dt className="text-muted">{k}</dt><dd className="text-lg font-semibold">{v}</dd></div>
            ))}
          </dl>
          {result.discarded.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer min-h-11 inline-flex items-center">{result.discarded.length} linha(s) descartada(s)</summary>
              <ul className="mt-1 space-y-1">
                {(Object.entries(result.discards) as [Reason, number][]).map(([r, n]) => (
                  <li key={r}>{REASONS[r]}: <strong>{n}</strong> <span className="text-muted">(linhas {result.discarded.filter((d) => d.reason === r).slice(0, 8).map((d) => d.line).join(', ')}{n > 8 ? '…' : ''})</span></li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={busy} disabled={!result.rows.length}>Salvar pré-cadastro ({result.rows.length})</Button>
            <Button variant="ghost" onClick={() => { setFile(null); setMapping(null); }}>Cancelar</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function Entries({ list, onChanged }: { list: { entries: any[]; counts: Record<string, number> }; onChanged: () => void }) {
  const t = useTenant();
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [limit, setLimit] = useState(100);
  const [preview, setPreview] = useState<any>(null);
  const [q, setQ] = useState('');
  const { busy, run } = useAction();
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return list.entries.filter((e) => !s || `${e.full_name} ${e.unit}`.toLowerCase().includes(s));
  }, [list.entries, q]);
  if (!list.entries.length) return <Card><Empty title="Nenhum pré-cadastro">Importe uma planilha para preparar os convites.</Empty></Card>;

  const ask = () => run(async () => setPreview(await rpc('resident_invite_preview', { p_tenant: t.tenant.id, p_channel: channel, p_limit: limit })));
  const send = () => run(async () => {
    const r = await rpc<any>('resident_invite_send', { p_tenant: t.tenant.id, p_channel: channel, p_limit: limit });
    toast.success(`${r.queued} convite(s) na fila${r.minutes ? `, enviados ao longo de ~${r.minutes} min` : ''}${r.remaining ? `. Restam ${r.remaining} para o próximo lote` : ''}.`);
    setPreview(null); onChanged();
  });
  const del = (ids: string[] | null) => {
    if (!confirm(ids ? 'Excluir este pré-cadastro?' : 'Excluir TODO o pré-cadastro? Convites na fila deixam de ser enviados.')) return;
    void run(async () => { await rpc('resident_import_delete', { p_tenant: t.tenant.id, p_entries: ids }); onChanged(); }, 'Pré-cadastro excluído.');
  };

  return (
    <>
      <Card className="space-y-3">
        <h2 className="font-semibold">Convidar unidades sem cadastro</h2>
        <p className="text-sm text-muted">Uma pessoa por unidade. Unidades com morador, solicitação pendente ou convite em aberto ficam de fora. Os envios são espaçados.</p>
        <div className="flex flex-wrap gap-2 items-end">
          <Field label="Canal"><Select value={channel} onChange={(e) => setChannel(e.target.value as any)}>
            <option value="whatsapp">WhatsApp</option><option value="email">E-mail</option></Select></Field>
          <Field label="Máximo neste lote"><Input type="number" min={1} max={300} value={limit} onChange={(e) => setLimit(Math.min(300, Math.max(1, Number(e.target.value) || 1)))} className="w-28" /></Field>
          <Button onClick={ask} loading={busy}>Ver prévia do envio</Button>
        </div>
        <p className="text-xs text-muted">{Object.entries(list.counts).map(([s, n]) => `${STATUS[s]?.[0] || s}: ${n}`).join(' · ')}</p>
      </Card>

      <Card className="space-y-3">
        <div className="flex flex-wrap gap-2 items-end justify-between">
          <Field label="Buscar nome ou unidade"><Input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Button variant="secondary" onClick={() => del(null)} disabled={busy}>Excluir tudo</Button>
        </div>
        <ul className="divide-y divide-line">
          {shown.slice(0, 300).map((e) => (
            <li key={e.id} className="py-2 flex flex-wrap items-center gap-2 justify-between">
              <div className="min-w-0">
                <p className="font-medium truncate">{e.full_name} <span className="text-muted font-normal">· {e.unit}</span></p>
                <p className="text-xs text-muted break-all">{[e.phone, e.email, e.kind].filter(Boolean).join(' · ') || 'Sem contato'}{e.last_error ? ` · ${e.last_error}` : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                {e.registered && e.status !== 'completed' && <Badge>Unidade já cadastrada</Badge>}
                <Badge tone={STATUS[e.status]?.[1]}>{STATUS[e.status]?.[0] || e.status}</Badge>
                <Button variant="ghost" aria-label={`Excluir ${e.full_name}`} onClick={() => del([e.id])} disabled={busy}>Excluir</Button>
              </div>
            </li>
          ))}
        </ul>
        {shown.length > 300 && <p className="text-xs text-muted">Mostrando 300 de {shown.length}. Use a busca.</p>}
      </Card>

      {preview && (
        <Modal title="Confirmar envio dos convites" onClose={() => setPreview(null)}>
          <div className="space-y-3 text-sm">
            <p>Canal: <strong>{preview.channel === 'email' ? 'E-mail' : 'WhatsApp'}</strong>. Unidades no pré-cadastro: {preview.units}. Aptas: {preview.eligible}.</p>
            <p className="text-base">Serão enviados <strong>{preview.will_send}</strong> convite(s) agora{preview.remaining ? `; ${preview.remaining} ficam para o próximo lote` : ''}.</p>
            {Object.keys(preview.excluded).length > 0 && (
              <ul className="list-disc pl-5">{Object.entries(preview.excluded).map(([r, n]) => <li key={r}>{PLAN[r] || r}: {String(n)}</li>)}</ul>
            )}
            <p className="text-muted">Cada link é pessoal, vale 30 dias e só pode ser usado uma vez. O morador confirma os dados, cria a senha e aceita o termo; você aprova a solicitação depois.</p>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setPreview(null)}>Cancelar</Button>
              <Button onClick={send} loading={busy} disabled={!preview.will_send}>Enviar {preview.will_send} convite(s)</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
