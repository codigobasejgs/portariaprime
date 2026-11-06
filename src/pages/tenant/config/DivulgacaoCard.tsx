import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, FileText, MessageCircle, RotateCcw, Share2 } from 'lucide-react';
import { rpc } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { publicLogoUrl } from '../../../lib/theme';
import { download, unitName } from '../../../lib/format';
import {
  draw, effective, fileName, LIMITS, Model, MODELS, portalLink, shareMessage, Texts, toPdf, toPng, whatsappUrl,
} from '../../../lib/divulgacao';
import { Alert, Button, Card, Field, Input, Spinner, toast, useAction } from '../../../components/ui';

const LABEL: Record<keyof Texts, string> = { title: 'Título', subtitle: 'Subtítulo', body: 'Texto', cta: 'Chamada sobre o QR Code' };

/** Logo público do condomínio carregado para o canvas (CORS anônimo; sem logo segue sem imagem). */
function useLogo(url: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null | undefined>(url ? undefined : null);
  useEffect(() => {
    if (!url) { setImg(null); return; }
    let on = true;
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => on && setImg(i); i.onerror = () => on && setImg(null);
    i.src = url;
    return () => { on = false; };
  }, [url]);
  return img;
}

/**
 * Configurações → Portal e aplicativo → Divulgação. Materiais com o QR e o link PÚBLICOS do portal
 * (nunca convite ou token). Textos personalizados ficam no servidor por modelo; imagem/PDF gerados no aparelho.
 */
export function DivulgacaoCard() {
  const t = useTenant();
  const canEdit = t.can('settings');
  const g = t.unitLabels.group.toLowerCase();
  const name = t.branding?.display_name || t.tenant.name;
  // QR por bloco: o morador já chega com o bloco escolhido no cadastro (só o nome do bloco vai no link).
  const [blocks, setBlocks] = useState<string[]>([]);
  const [block, setBlock] = useState('');
  useEffect(() => { void rpc<any>('portal_units', { p_slug: t.tenant.slug }).then((u) => setBlocks([...new Set((u?.units || []).map((x: any) => x.block).filter(Boolean) as string[])])).catch(() => {}); }, [t.tenant.slug]);
  const link = portalLink(location.origin, t.tenant.slug, block || null);
  const logo = useLogo(publicLogoUrl(t.branding?.logo_path));
  const [model, setModel] = useState<Model>('cartaz');
  const [saved, setSaved] = useState<Record<string, Partial<Texts>> | null>(null);
  const [draft, setDraft] = useState<Texts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    let on = true;
    rpc<Record<string, Partial<Texts>>>('divulgacao_get', { p_tenant: t.tenant.id })
      .then((d) => { if (on) setSaved(d || {}); })
      .catch(() => { if (on) { setLoadError('Não foi possível carregar os textos salvos.'); setSaved({}); } });
    return () => { on = false; };
  }, [t.tenant.id]);
  useEffect(() => { if (saved) setDraft(effective(model, name, saved[model])); }, [model, saved, name]);

  const texts = draft;
  const meta = MODELS.find((m) => m.id === model)!;
  useEffect(() => {
    if (!texts || logo === undefined || !canvas.current) return;
    try { draw(canvas.current.getContext('2d')!, model, texts, { name, color: t.branding?.color_primary || '#101F30', logo }, link); }
    catch (e: any) { toast.error(e.message); }
  }, [texts, logo, model, name, link, t.branding?.color_primary]);
  const dirty = useMemo(() => !!(texts && saved && JSON.stringify(texts) !== JSON.stringify(effective(model, name, saved[model]))), [texts, saved, model, name]);

  if (!saved || !texts) return <Spinner />;
  const msg = shareMessage(texts, name, link);
  const set = (k: keyof Texts) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...texts, [k]: e.target.value.slice(0, LIMITS[k]) });
  const save = () => run(async () => {
    const def = effective(model, name, null);
    const custom = Object.fromEntries((Object.keys(LIMITS) as (keyof Texts)[]).filter((k) => texts[k].trim() !== def[k]).map((k) => [k, texts[k]]));
    const v = await rpc<Record<string, Partial<Texts>>>('divulgacao_save', { p_tenant: t.tenant.id, p_model: model, p_texts: custom });
    setSaved(v || {});
  }, 'Textos salvos.');
  const reset = () => run(async () => {
    const v = await rpc<Record<string, Partial<Texts>>>('divulgacao_save', { p_tenant: t.tenant.id, p_model: model, p_texts: {} });
    setSaved(v || {});
  }, 'Textos padrão restaurados.');
  const fileSlug = block ? `${t.tenant.slug}-${g.normalize('NFD').replace(/[^a-z0-9]+/g, '')}-${block.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : t.tenant.slug;
  const png = () => run(async () => download(fileName(fileSlug, model, 'png'), new Uint8Array(await (await toPng(canvas.current!)).arrayBuffer()), 'image/png'));
  const pdf = () => run(async () => download(fileName(fileSlug, model, 'pdf'), await toPdf(canvas.current!, model, `${texts.title} — ${name}`), 'application/pdf'));
  const copy = (s: string, ok: string) => run(async () => { await navigator.clipboard.writeText(s); }, ok);
  const share = () => run(async () => {
    const blob = await toPng(canvas.current!);
    const file = new File([blob], fileName(fileSlug, model, 'png'), { type: 'image/png' });
    const data: ShareData = (navigator as any).canShare?.({ files: [file] }) ? { files: [file], title: texts.title, text: msg } : { title: texts.title, text: msg, url: link };
    try { await navigator.share(data); } catch (e: any) { if (e?.name !== 'AbortError') throw e; }
  });

  return (
    <Card className="space-y-4" id="divulgacao">
      <div>
        <p className="font-semibold">Divulgação do portal</p>
        <p className="text-sm text-muted">Cartazes e mensagens com o QR Code do portal dos moradores. O QR leva só ao endereço público ({link.replace(/^https?:\/\//, '')}); o cadastro continua exigindo conta, termo de dados e aprovação.</p>
      </div>
      {loadError && <Alert tone="warning">{loadError} Os textos padrão estão sendo usados.</Alert>}
      {blocks.length > 0 && <div className="space-y-1">
        <p className="text-sm font-medium">QR Code de</p>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="QR Code de">
          {['', ...blocks].map((b) => <button key={b || 'geral'} type="button" role="radio" aria-checked={block === b} onClick={() => setBlock(b)}
            className={`min-h-9 px-3 rounded-full text-sm border ${block === b ? 'bg-primary text-primary-fg border-primary' : 'border-line hover:bg-surface-2'}`}>{b ? unitName(b, null, t.unitLabels) : `Entrada (todos: ${g})`}</button>)}
        </div>
        <p className="text-xs text-muted">Imprima um para a entrada e um para cada {g}: o morador que lê esse QR já chega com a opção escolhida no cadastro.</p>
      </div>}

      <div role="radiogroup" aria-label="Modelo" className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {MODELS.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={model === m.id} onClick={() => setModel(m.id)}
            className={`min-h-16 rounded-xl border p-3 text-left text-sm ${model === m.id ? 'border-secondary ring-1 ring-secondary bg-surface' : 'border-line bg-surface hover:bg-surface-2'}`}>
            <span className="block font-semibold">{m.label}</span><span className="block text-xs text-muted">{m.desc}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start">
        <div className="space-y-3 min-w-0">
          {(Object.keys(LIMITS) as (keyof Texts)[]).map((k) => (
            <Field key={k} label={LABEL[k]} hint={`${texts[k].length}/${LIMITS[k]}`}>
              {k === 'body'
                ? <textarea className="w-full min-h-28 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60" value={texts[k]} onChange={set(k)} maxLength={LIMITS[k]} disabled={!canEdit} />
                : <Input value={texts[k]} onChange={set(k)} maxLength={LIMITS[k]} disabled={!canEdit} />}
            </Field>
          ))}
          {canEdit && <div className="flex flex-wrap gap-2">
            <Button onClick={save} loading={busy} disabled={!dirty}>Salvar textos</Button>
            {saved[model] && <Button variant="ghost" onClick={reset} disabled={busy}><RotateCcw className="w-4 h-4" aria-hidden /> Restaurar padrão</Button>}
          </div>}
          {!t.branding?.logo_path && <p className="text-xs text-muted">Dica: envie o logo em Identidade visual para ele aparecer nos materiais.</p>}
        </div>

        <div className="space-y-3 min-w-0">
          <p className="text-sm font-medium">Pré-visualização — {meta.label}</p>
          <div className="rounded-xl border border-line bg-surface-2 p-3 grid place-items-center">
            {logo === undefined && <Spinner label="Carregando logo…" />}
            <canvas ref={canvas} role="img" aria-label={`Pré-visualização: ${texts.title}. ${texts.subtitle}. QR Code para ${link}`}
              className={`max-w-full h-auto shadow-sm ${model === 'whatsapp' ? 'max-h-[420px]' : 'max-h-[560px]'}`} style={{ aspectRatio: `${meta.size[0]} / ${meta.size[1]}` }} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={png} disabled={busy}><Download className="w-4 h-4" aria-hidden /> Baixar PNG</Button>
            <Button variant="secondary" onClick={pdf} disabled={busy}><FileText className="w-4 h-4" aria-hidden /> Baixar PDF</Button>
            {'share' in navigator && <Button variant="secondary" onClick={share} disabled={busy}><Share2 className="w-4 h-4" aria-hidden /> Compartilhar</Button>}
          </div>
        </div>
      </div>

      <div className="space-y-2 rounded-xl bg-surface-2 p-3">
        <p className="text-sm font-medium">Mensagem pronta</p>
        <pre className="whitespace-pre-wrap break-words text-sm font-sans">{msg}</pre>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => copy(msg, 'Mensagem copiada.')}><Copy className="w-4 h-4" aria-hidden /> Copiar mensagem</Button>
          <Button variant="secondary" onClick={() => copy(link, 'Link copiado.')}><Copy className="w-4 h-4" aria-hidden /> Copiar link</Button>
          <a href={whatsappUrl(msg)} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-2 min-h-11 px-4 rounded-xl border border-line bg-surface text-sm font-medium hover:bg-surface-2">
            <MessageCircle className="w-4 h-4" aria-hidden /> Enviar pelo WhatsApp</a>
        </div>
      </div>
    </Card>
  );
}
