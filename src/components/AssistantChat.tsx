import React, { useEffect, useRef, useState } from 'react';
import { Bot, Send } from 'lucide-react';
import { LEVELS, type Level } from '../../api/_lib/assistant-text';
import { handleAction, mainMenu, runIntent, type Intent, type Reply } from '../../api/_lib/assistant-core';
import { parseIncoming } from '../../api/_lib/whatsapp-card';
import { demoLink, demoSvc } from '../demo/assistant-sim';

interface Msg { from: 'me' | 'bot'; text: string; options?: { id: string; title: string }[] }

/**
 * Simulador do Portaria Prime IA (só /demonstracao, dados fictícios). Mesmo motor do WhatsApp real (assistant-core),
 * com o banco da demonstração. A IA real não é chamada: os exemplos rápidos já trazem a intenção que ela escolheria.
 */
const EXAMPLES: { label: string; say: string; intent?: Intent; photo?: boolean }[] = [
  { label: 'Listar pendências de hoje', say: 'Me ajuda a organizar o dia de hoje', intent: { name: 'today_summary', args: {} } },
  { label: 'Pendências do bloco A', say: 'Quem está com encomenda pendente no bloco A?', intent: { name: 'pending_packages', args: { block: 'A' } } },
  { label: 'Analisar últimos 6 meses', say: 'Analise a operação dos últimos 6 meses', intent: { name: 'report', args: { period: '6m' } } },
  { label: 'Cadastros pendentes', say: 'Tem cadastro de morador para aprovar?', intent: { name: 'list_access_requests', args: {} } },
  { label: 'Reenviar aviso das atrasadas', say: 'Reenvia o aviso de todas as encomendas paradas há mais de 3 dias', intent: { name: 'bulk_resend', args: { min_days: 3 } } },
  { label: 'Ver estantes', say: 'Como estão as estantes?', intent: { name: 'storage_status', args: {} } },
  { label: 'Foto de etiqueta', say: '📷 [foto da etiqueta]', photo: true },
];

export function AssistantChat() {
  const [level, setLevel] = useState<Level>('intermediate');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [opts, setOpts] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs]);

  const show = (r: Reply) => {
    // Botões/lista viram opções clicáveis; o texto já traz a numeração (como no WhatsApp).
    const raw = r.card.buttons?.map((b) => ({ id: b.id, title: b.title })) || r.card.sections?.flatMap((s) => s.rows.map((x) => ({ id: x.id, title: x.title }))) || [];
    setMsgs((m) => [...m, { from: 'bot', text: r.card.text, options: raw }]);
    setOpts(r.options);
  };
  const run = async (say: string, fn: () => Promise<Reply> | Reply) => {
    setMsgs((m) => [...m, { from: 'me', text: say }]);
    setBusy(true);
    try { show(await fn()); } catch (e: any) { setMsgs((m) => [...m, { from: 'bot', text: `Não consegui concluir: ${e?.message || 'erro'}.` }]); } finally { setBusy(false); }
  };
  const svc = () => demoSvc(level);
  const link = () => demoLink(level);
  useEffect(() => { setMsgs([]); show(mainMenu(link())); }, [level]); // eslint-disable-line react-hooks/exhaustive-deps

  const click = (o: { id: string; title: string }) => run(o.title, () => handleAction(svc(), link(), o.id));
  const typed = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    const ev = parseIncoming({ conversation: t }, opts);
    // Sem IA na demonstração: números e “CONFIRMAR código” viram clique (mesma regra do WhatsApp); texto livre volta ao menu.
    if (ev.kind === 'action') return run(t, () => handleAction(svc(), link(), ev.id));
    return run(t, () => runIntent(svc(), link(), null));
  };
  const example = (x: (typeof EXAMPLES)[number]) => {
    if (x.photo) {
      return run(x.say, async () => {
        if (level !== 'advanced') return handleAction(svc(), link(), 'help').then((r) => ({ ...r, card: { text: 'Áudio, foto e arquivos exigem o nível Avançado. Troque o nível acima para testar.' } }));
        const { propose } = await import('../../api/_lib/assistant-core');
        return propose(svc(), link(), 'receive_package',
          { unit_id: '00000000-0000-4000-8000-000000000001', carrier: 'Correios', tracking: 'DM5550001BR', recipient: 'João Silva', storage_location_id: null, courier: 'Informado no WhatsApp', received_by: 'Carla Mendes' },
          'Ação: registrar encomenda (foto da etiqueta)\nUnidade: A 101\nDestinatário: João Silva\nTransportadora: Correios\nRastreio: DM5550001BR\nGuardar em: Portaria principal › Estante A\nAo confirmar, você declara que a encomenda foi guardada nesse local e os moradores serão avisados.');
      });
    }
    return run(x.say, () => runIntent(svc(), link(), x.intent!));
  };

  return (
    <section aria-label="Simulador do Portaria Prime IA no WhatsApp" className="rounded-2xl border border-line bg-surface overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#075E54] text-white px-4 py-3">
        <p className="font-semibold flex items-center gap-2"><Bot className="w-5 h-5" aria-hidden /> Portaria Prime IA · simulação</p>
        <label className="text-sm flex items-center gap-2">Nível
          <select value={level} onChange={(e) => setLevel(e.target.value as Level)} className="rounded-lg text-text bg-white px-2 py-1 min-h-9">
            {(Object.keys(LEVELS) as Level[]).map((k) => <option key={k} value={k}>{LEVELS[k].title}</option>)}
          </select>
        </label>
      </div>
      <div className="h-[28rem] max-h-[55dvh] overflow-y-auto bg-[#ECE5DD] p-3 space-y-2" aria-live="polite">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.from === 'me' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm text-[#111] shadow-sm ${m.from === 'me' ? 'bg-[#DCF8C6]' : 'bg-white'}`}>
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              {!!m.options?.length && i === msgs.length - 1 && (
                <div className="mt-2 flex flex-col gap-1">
                  {m.options.map((o) => <button key={o.id} type="button" disabled={busy} onClick={() => click(o)}
                    className="min-h-10 rounded-lg border border-[#d0d7de] bg-[#f7f9fa] text-[#075E54] font-medium px-3 text-left hover:bg-white">{o.title}</button>)}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="p-3 space-y-2 border-t border-line">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Exemplos rápidos">
          {EXAMPLES.map((x) => <button key={x.label} type="button" disabled={busy} onClick={() => example(x)}
            className="min-h-10 rounded-full border border-line px-3 text-sm hover:bg-surface-2">{x.label}</button>)}
        </div>
        <form onSubmit={typed} className="flex gap-2">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Número da lista, “CONFIRMAR código”, “cancelar” ou “menu”" aria-label="Mensagem"
            className="flex-1 min-h-11 rounded-xl border border-line bg-surface px-3 text-sm" />
          <button type="submit" disabled={busy} aria-label="Enviar" className="min-h-11 min-w-11 rounded-xl bg-[#075E54] text-white grid place-items-center"><Send className="w-4 h-4" /></button>
        </form>
        <p className="text-xs text-muted">Dados fictícios. No WhatsApp real, texto livre e áudio são entendidos pela IA; nada é alterado sem o ✅ Confirmar.</p>
      </div>
    </section>
  );
}
