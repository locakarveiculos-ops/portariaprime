import React, { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTenant } from '../lib/tenant';
import { Alert, Button, toast } from './ui';
import { useSession } from '../lib/session';
import { hasPushRegistration, removePushRegistration } from '../lib/push-registration';

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
  const { ctx } = useSession();
  const userId = ctx?.user_id;
  const [verificationError, setVerificationError] = useState('');
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setSub(undefined);
    setVerificationError('');
    if (!supported || !userId) { setSub(null); return; }
    (async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const current = await registration?.pushManager.getSubscription();
        const registered = current && await hasPushRegistration(supabase, t.tenant.id, userId, current.endpoint);
        if (active) setSub(registered ? current : null);
      } catch (error: any) {
        if (active) { setVerificationError(error.message); setSub(null); }
      }
    })();
    return () => { active = false; };
  }, [supported, userId, t.tenant.id]);

  if (!supported) return <Alert tone="info">Este navegador não recebe notificações push. Os avisos aparecem em “Avisos” e por e-mail. No iPhone, instale o app na tela de início (iOS 16.4+).</Alert>;
  if (!VAPID) return null; // push não configurado neste ambiente
  if (sub === undefined) return null;

  const enable = async () => {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Permissão de notificação negada. Você pode ativá-la nas configurações do navegador.');
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.active) throw new Error('Aplicativo ainda não está pronto para notificações. Recarregue e tente novamente.');
      const s = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID) });
      const j = s.toJSON();
      if (!userId) throw new Error('Sessão inválida.');
      const { error } = await supabase.from('push_subscriptions').insert({
        tenant_id: t.tenant.id, user_id: userId, endpoint: j.endpoint, p256dh: j.keys!.p256dh, auth: j.keys!.auth,
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
      if (sub && userId) {
        await removePushRegistration(supabase, t.tenant.id, userId, sub.endpoint);
        // Só cancela a inscrição do navegador se não houver outros vínculos usando o mesmo endpoint.
        const { count } = await supabase.from('push_subscriptions').select('id', { count: 'exact', head: true })
          .eq('endpoint', sub.endpoint);
        if (!count) await sub.unsubscribe();
      }
      setSub(null);
    } catch (error: any) {
      toast.error(error.message);
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
