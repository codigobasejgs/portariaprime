import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, Paperclip, RefreshCw, Search, SendHorizontal } from 'lucide-react';
import { api } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { useRefreshWhileVisible, useTenant } from '../../lib/tenant';
import { navigate } from '../../lib/router';
import { DEMO } from '../../demo/mode';
import { Alert, Button, Empty, Input, Spinner, toast } from '../../components/ui';

interface Chat { jid: string; name: string | null; unit: string | null; phone: string | null; unread: number; at: number; last: { text: string; media: string | null; fromMe: boolean } | null }
interface Msg { id: string; fromMe: boolean; at: number; text: string; media: string | null; fileName: string | null }

const MAX = 16 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/3gpp', 'application/pdf'];
const MEDIA_LABEL: Record<string, string> = { image: 'Foto', video: 'Vídeo', audio: 'Áudio', document: 'Documento' };
const time = (ms: number, tz: string) => ms ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(ms) : '';
const title = (c: Chat) => c.name || c.phone || 'Contato do WhatsApp';

/**
 * Conversas do WhatsApp dos avisos: o síndico vê quem respondeu e manda texto, foto, vídeo ou PDF.
 * Os avisos automáticos continuam saindo normalmente; nada aqui pausa ou substitui a automação.
 */
export function ConversasPage() {
  const t = useTenant();
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Chat | null>(null);
  const [q, setQ] = useState('');
  const load = useCallback(() => api<{ chats: Chat[] }>('/api/whatsapp/chat-list', { tenantId: t.tenant.id })
    .then((r) => { setChats(r.chats); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  useRefreshWhileVisible(load, 30000);
  if (!DEMO && !t.overview?.entitlements?.feature_whatsapp) return <Alert tone="warning">As conversas do WhatsApp fazem parte dos planos com WhatsApp. Veja em Configurações › Plano e assinatura.</Alert>;

  const s = q.trim().toLowerCase();
  const shown = (chats || []).filter((c) => !s || `${c.name || ''} ${c.unit || ''} ${c.phone || ''}`.toLowerCase().includes(s));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Conversas do WhatsApp</h1>
          <p className="text-sm text-muted">Mensagens do WhatsApp dos avisos. Os avisos automáticos continuam saindo normalmente.</p>
        </div>
        <Button variant="secondary" onClick={() => void load()}><RefreshCw className="w-4 h-4" aria-hidden /> Atualizar</Button>
      </div>
      {error && <Alert tone="danger">{error} {/conect/i.test(error) && <button className="underline" onClick={() => navigate(`/c/${t.tenant.slug}/configuracoes?m=integracoes`)}>Abrir Integrações</button>}</Alert>}
      <div className="grid lg:grid-cols-[320px_minmax(0,1fr)] gap-4 items-start">
        <section aria-label="Conversas" className={`min-w-0 rounded-2xl border border-line bg-surface ${open ? 'hidden lg:block' : ''}`}>
          <label className="relative block p-3 border-b border-line">
            <span className="sr-only">Buscar conversa</span>
            <Search className="w-4 h-4 absolute left-6 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input className="pl-9" placeholder="Nome, unidade ou telefone" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {!chats && !error ? <Spinner /> : shown.length === 0 ? <Empty title="Nenhuma conversa">{q ? 'Nada encontrado para a busca.' : 'As conversas aparecem aqui quando o WhatsApp do condomínio envia ou recebe mensagens.'}</Empty> : (
            <ul className="divide-y divide-line max-h-[70vh] overflow-y-auto">
              {shown.map((c) => (
                <li key={c.jid}>
                  <button onClick={() => setOpen(c)} aria-current={open?.jid === c.jid ? 'true' : undefined}
                    className={`w-full text-left px-3 py-2.5 min-h-14 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${open?.jid === c.jid ? 'bg-surface-2' : ''}`}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">{title(c)}</span>
                      <span className="text-xs text-muted shrink-0">{time(c.at, t.tenant.timezone)}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2 text-sm text-muted">
                      <span className="truncate">{c.unit ? `${c.unit} · ` : ''}{c.last ? `${c.last.fromMe ? 'Você: ' : ''}${c.last.media ? `[${MEDIA_LABEL[c.last.media]}] ` : ''}${c.last.text}` : ''}</span>
                      {c.unread > 0 && <span className="shrink-0 rounded-full bg-primary text-white text-xs px-1.5" aria-label={`${c.unread} não lidas`}>{c.unread}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {open ? <Thread key={open.jid} chat={open} onBack={() => setOpen(null)} onSent={() => void load()} />
          : <div className="hidden lg:block rounded-2xl border border-line bg-surface"><Empty title="Escolha uma conversa">Veja as mensagens e responda por texto, foto, vídeo ou PDF.</Empty></div>}
      </div>
    </div>
  );
}

function Thread({ chat, onBack, onSent }: { chat: Chat; onBack: () => void; onSent: () => void }) {
  const t = useTenant();
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [pages, setPages] = useState({ page: 1, pages: 1 });
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const load = useCallback((page = 1) => api<{ messages: Msg[]; page: number; pages: number }>('/api/whatsapp/chat-messages', { tenantId: t.tenant.id, jid: chat.jid, page })
    .then((r) => {
      setMsgs((old) => page === 1 ? r.messages : [...(old || []), ...r.messages]);
      setPages({ page: r.page, pages: r.pages }); setError(null);
    }).catch((e) => setError(e.message)), [t.tenant.id, chat.jid]);
  useEffect(() => { void load(1); }, [load]);
  useRefreshWhileVisible(() => { if (pages.page === 1) void load(1); }, 15000);
  useEffect(() => { if (pages.page === 1) end.current?.scrollIntoView({ block: 'end' }); }, [msgs, pages.page]);

  const choose = (f: File | undefined) => {
    if (!f) return;
    if (!OK_TYPES.includes(f.type)) { toast.error('Envie foto (JPG, PNG, WebP), vídeo (MP4) ou PDF.'); return; }
    if (f.size > MAX) { toast.error('Arquivo grande demais (máximo 16 MB).'); return; }
    setFile(f);
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || (!text.trim() && !file)) return;
    setBusy(true);
    try {
      let path: string | undefined;
      if (file) {
        const ext = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin';
        path = `${t.tenant.id}/out/${crypto.randomUUID()}.${ext}`;
        const { error: ue } = await supabase.storage.from('tenant-chat').upload(path, file, { contentType: file.type, upsert: false });
        if (ue) throw new Error('Falha ao enviar o arquivo. Verifique a conexão e tente novamente.');
      }
      await api('/api/whatsapp/chat-send', { tenantId: t.tenant.id, jid: chat.jid, text, file: path, mime: file?.type, fileName: file?.name });
      setText(''); setFile(null);
      await load(1); onSent();
    } catch (err: any) {
      toast.error(err?.message || 'Mensagem não enviada.');
    } finally { setBusy(false); }
  };

  const ordered = [...(msgs || [])].sort((a, b) => a.at - b.at);
  return (
    <section aria-label={`Conversa com ${title(chat)}`} className="min-w-0 rounded-2xl border border-line bg-surface flex flex-col h-[75vh] min-h-[420px]">
      <header className="flex items-center gap-2 p-3 border-b border-line">
        <button className="lg:hidden min-h-11 min-w-11 grid place-items-center rounded-lg hover:bg-surface-2" onClick={onBack} aria-label="Voltar para as conversas"><ArrowLeft className="w-5 h-5" /></button>
        <div className="min-w-0">
          <p className="font-semibold truncate">{title(chat)}</p>
          <p className="text-xs text-muted truncate">{[chat.unit, chat.phone].filter(Boolean).join(' · ') || 'Número oculto pelo WhatsApp'}</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-surface-2" aria-live="polite">
        {pages.page < pages.pages && <div className="text-center"><Button variant="ghost" onClick={() => void load(pages.page + 1)}>Ver mensagens anteriores</Button></div>}
        {error ? <Alert tone="danger">{error}</Alert> : !msgs ? <Spinner /> : ordered.length === 0 ? <Empty title="Sem mensagens" /> : ordered.map((m) => (
          <div key={m.id} className={`flex ${m.fromMe ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${m.fromMe ? 'bg-[#DCF8C6] text-[#111]' : 'bg-surface text-text'}`}>
              {m.media && <Media tenantId={t.tenant.id} msg={m} />}
              {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
              <p className="text-[11px] opacity-60 text-right mt-0.5">{time(m.at, t.tenant.timezone)}</p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="border-t border-line p-2 space-y-2">
        {file && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
            <span className="truncate"><Paperclip className="w-4 h-4 inline mr-1" aria-hidden />{file.name}</span>
            <button type="button" className="underline text-muted" onClick={() => setFile(null)}>Remover</button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button type="button" onClick={() => pick.current?.click()} disabled={busy} aria-label="Anexar foto, vídeo ou PDF"
            className="min-h-11 min-w-11 grid place-items-center rounded-xl border border-line hover:bg-surface-2"><Paperclip className="w-5 h-5" /></button>
          <input ref={pick} type="file" accept={OK_TYPES.join(',')} className="hidden" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
          <label className="flex-1">
            <span className="sr-only">Mensagem</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} maxLength={4000} placeholder={file ? 'Legenda (opcional)' : 'Escreva uma mensagem'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
              className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-sm max-h-32 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
          </label>
          <Button type="submit" loading={busy} disabled={!text.trim() && !file} aria-label="Enviar"><SendHorizontal className="w-5 h-5" /></Button>
        </div>
      </form>
    </section>
  );
}

/** Mídia carregada sob demanda (o arquivo vem da Evolution só quando o síndico toca). */
function Media({ tenantId, msg }: { tenantId: string; msg: Msg }) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const open = () => {
    setState('busy');
    api<{ url: string }>('/api/whatsapp/chat-media', { tenantId, id: msg.id }).then((r) => { setUrl(r.url); setState('idle'); })
      .catch((e) => { setState('error'); toast.error(e.message); });
  };
  if (!url) {
    return <button onClick={open} disabled={state === 'busy'} className="mb-1 flex items-center gap-2 rounded-lg border border-line/60 px-2 py-1.5 text-xs underline">
      <FileText className="w-4 h-4" aria-hidden />{state === 'busy' ? 'Abrindo…' : `${MEDIA_LABEL[msg.media!] || 'Arquivo'}${msg.fileName ? `: ${msg.fileName}` : ''} (abrir)`}
    </button>;
  }
  if (msg.media === 'image') return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={msg.text || 'Foto da conversa'} className="mb-1 rounded-lg max-h-72" /></a>;
  if (msg.media === 'video') return <video src={url} controls playsInline className="mb-1 rounded-lg max-h-72" />;
  if (msg.media === 'audio') return <audio src={url} controls className="mb-1 max-w-full" />;
  return <a href={url} target="_blank" rel="noreferrer" className="mb-1 block underline">{msg.fileName || 'Abrir documento'}</a>;
}
