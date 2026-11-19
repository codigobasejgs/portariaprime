import { useCallback, useEffect, useState } from 'react';

// Minimal shape of the BeforeInstallPromptEvent (not yet in lib.dom.d.ts)
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// O Chrome dispara beforeinstallprompt UMA vez, cedo — muitas vezes antes da tela que tem o botão montar (lazy
// load). Guardamos o evento no carregamento do módulo para quem montar depois.
let early: BeforeInstallPromptEvent | null = null;
let installedEarly = false;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); early = e as BeforeInstallPromptEvent; });
  window.addEventListener('appinstalled', () => { installedEarly = true; early = null; });
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone;
  return window.matchMedia?.('(display-mode: standalone)').matches === true || iosStandalone === true;
}

/**
 * Wraps the native `beforeinstallprompt` flow (Chrome/Edge/Android) and exposes
 * install state. iOS Safari never fires this event — isInstallable stays false
 * there, so callers should fall back to "Compartilhar > Adicionar à Tela de Início".
 */
export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(() => early);
  const [isInstalled, setIsInstalled] = useState<boolean>(() => installedEarly || detectStandalone());

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };
    const onDisplayModeChange = () => setIsInstalled(detectStandalone());

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    const media = window.matchMedia('(display-mode: standalone)');
    media.addEventListener?.('change', onDisplayModeChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      media.removeEventListener?.('change', onDisplayModeChange);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable';
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    early = null;   // o evento só pode ser usado uma vez
    return outcome;
  }, [deferredPrompt]);

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    promptInstall
  };
}
