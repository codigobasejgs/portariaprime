import React from 'react';
import { Download, Share, SquarePlus, Smartphone } from 'lucide-react';
import { usePwaInstall } from '../hooks/usePwaInstall';
import { Alert, Button } from './ui';

export type Platform = 'ios' | 'android' | 'other';

/** iPhone/iPad (o iPadOS se apresenta como Mac com toque). */
export function detectPlatform(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touch = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints, platform = typeof navigator === 'undefined' ? '' : navigator.platform): Platform {
  if (/iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && touch > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}
/** Navegador embutido de outro app (WhatsApp, Instagram…): não instala; precisa abrir no Chrome/Safari. */
export const inAppBrowser = (ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) => /Instagram|FBAN|FBAV|Line\/|WhatsApp/i.test(ua);
/** No iPhone só o Safari instala na Tela de Início (Chrome/Firefox do iOS usam o mesmo atalho, mas o caminho muda). */
const iosNotSafari = (ua: string) => /CriOS|FxiOS|EdgiOS/.test(ua);

/**
 * Instalar o app do condomínio na tela inicial.
 * Android/Chrome/Edge: botão que abre o instalador do sistema. iPhone: passo a passo do Safari (a Apple não permite
 * botão de instalar). Já instalado: some. Usado após o cadastro do morador, no portal e em Minha conta.
 */
export function InstallApp({ title = 'Instale o aplicativo', intro, compact = false }: { title?: string; intro?: React.ReactNode; compact?: boolean }) {
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = detectPlatform();
  if (isInstalled) return compact ? null : <p className="text-sm text-success">Você já está usando o aplicativo instalado.</p>;
  return (
    <section aria-labelledby="instalar-app" className="rounded-2xl border border-line bg-surface p-4 space-y-3" data-testid="install-app">
      <h3 id="instalar-app" className="font-semibold flex items-center gap-2"><Smartphone className="w-5 h-5" aria-hidden /> {title}</h3>
      {intro && <p className="text-sm text-muted">{intro}</p>}
      {inAppBrowser(ua) ? (
        <Alert tone="warning">Você abriu por dentro de outro aplicativo. Toque nos três pontinhos e escolha abrir no {os === 'ios' ? 'Safari' : 'Chrome'} para instalar.</Alert>
      ) : isInstallable ? (
        <Button onClick={() => void promptInstall()} className="w-full min-h-12 text-base"><Download className="w-5 h-5" aria-hidden /> Instalar aplicativo</Button>
      ) : os === 'ios' ? (
        <div className="space-y-2">
          {iosNotSafari(ua) && <Alert tone="warning">Para instalar no iPhone, abra este endereço no <strong>Safari</strong>.</Alert>}
          <p className="text-sm font-medium">No iPhone ou iPad, pelo Safari:</p>
          <ol className="space-y-2" aria-label="Passo a passo para instalar no iPhone">
            {([
              [Share, <>Toque em <strong>Compartilhar</strong>: o quadrado com a seta para cima, na barra de baixo (ou de cima, no iPad).</>],
              [SquarePlus, <>Role a lista e toque em <strong>Adicionar à Tela de Início</strong>.</>],
              [Smartphone, <>Toque em <strong>Adicionar</strong> no canto superior. O ícone do condomínio aparece na tela inicial.</>],
            ] as [React.ElementType, React.ReactNode][]).map(([Icon, text], i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl bg-surface-2 p-3 text-sm">
                <span className="h-7 w-7 shrink-0 rounded-full bg-primary text-primary-fg grid place-items-center text-xs font-semibold" aria-hidden>{i + 1}</span>
                <Icon className="w-5 h-5 shrink-0 mt-0.5 text-muted" aria-hidden /><span>{text}</span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted">Abra sempre pelo ícone: assim você recebe os avisos no iPhone (iOS 16.4 ou mais novo).</p>
        </div>
      ) : os === 'android' ? (
        <p className="text-sm">Toque no menu do navegador (<strong>⋮</strong>) e escolha <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>. Se não aparecer, o app pode já estar instalado.</p>
      ) : (
        <p className="text-sm text-muted">No celular, abra este endereço no Chrome (Android) ou no Safari (iPhone) para instalar o aplicativo.</p>
      )}
    </section>
  );
}
