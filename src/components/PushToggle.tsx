import React, { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTenant } from '../lib/tenant';
import { Alert, Button, toast } from './ui';

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function b64ToBytes(b64: string) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * Web Push real: inscrição no PushManager com VAPID e registro no servidor.
 * Só mostra "ativado" com inscrição existente neste dispositivo.
 */
export function PushToggle() {
  const t = useTenant();
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return setSub(null);
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub).catch(() => setSub(null));
  }, [supported]);

  if (!supported) return <Alert tone="info">Este navegador não recebe notificações push. Os avisos aparecem em “Avisos” e por e-mail. No iPhone, instale o app na tela de início (iOS 16.4+).</Alert>;
  if (!VAPID) return null; // push não configurado neste ambiente
  if (sub === undefined) return null;

  const enable = async () => {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Permissão de notificação negada. Você pode ativá-la nas configurações do navegador.');
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID) });
      const j = s.toJSON();
      const { data } = await supabase.auth.getUser();
      const { error } = await supabase.from('push_subscriptions').insert({
        tenant_id: t.tenant.id, user_id: data.user!.id, endpoint: j.endpoint, p256dh: j.keys!.p256dh, auth: j.keys!.auth,
        user_agent: navigator.userAgent.slice(0, 200),
      });
      if (error && !/duplicate/i.test(error.message)) throw new Error('Não foi possível registrar este dispositivo.');
      setSub(s);
      toast.success('Notificações ativadas neste dispositivo.');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      if (sub) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        await sub.unsubscribe();
      }
      setSub(null);
    } finally {
      setBusy(false);
    }
  };

  return sub ? (
    <Button variant="ghost" onClick={disable} loading={busy}><BellOff className="w-4 h-4" /> Desativar notificações neste dispositivo</Button>
  ) : (
    <Button variant="secondary" onClick={enable} loading={busy}><Bell className="w-4 h-4" /> Ativar notificações neste dispositivo</Button>
  );
}
