import React, { useCallback, useEffect, useState } from 'react';
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
 * Estado real deste dispositivo para este condomínio:
 * `on` só com permissão concedida E inscrição registrada no servidor para o usuário.
 */
export type PushState = 'checking' | 'unsupported' | 'unconfigured' | 'denied' | 'off' | 'on';

export function usePushDevice() {
  const t = useTenant();
  const { ctx } = useSession();
  const userId = ctx?.user_id;
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [perm, setPerm] = useState(() => (supported ? Notification.permission : 'default'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setSub(undefined); setError('');
    if (!supported || !userId) { setSub(null); return; }
    (async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const current = await registration?.pushManager.getSubscription();
        const registered = current && await hasPushRegistration(supabase, t.tenant.id, userId, current.endpoint);
        if (active) setSub(registered ? current : null);
      } catch (e: any) {
        if (active) { setError(e.message); setSub(null); }
      }
    })();
    const onFocus = () => setPerm(Notification.permission);
    if (supported) addEventListener('focus', onFocus);
    return () => { active = false; if (supported) removeEventListener('focus', onFocus); };
  }, [supported, userId, t.tenant.id]);

  const enable = useCallback(async () => {
    setBusy(true); setError('');
    try {
      if (!VAPID || !userId) throw new Error('Notificações não estão disponíveis neste ambiente.');
      if (Notification.permission === 'denied') throw new Error('As notificações estão bloqueadas neste navegador.');
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') throw new Error('Você não permitiu as notificações. Pode mudar isso depois nas configurações do navegador.');
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.active) throw new Error('O aplicativo ainda está carregando. Recarregue a página e tente de novo.');
      const s = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID) });
      const j = s.toJSON();
      const { error: e } = await supabase.rpc('register_push_subscription', {
        p_tenant: t.tenant.id, p_endpoint: j.endpoint, p_p256dh: j.keys!.p256dh, p_auth: j.keys!.auth,
        p_user_agent: navigator.userAgent.slice(0, 200),
      });
      if (e || !await hasPushRegistration(supabase, t.tenant.id, userId, s.endpoint)) throw new Error('Não foi possível registrar este dispositivo. Tente novamente.');
      setSub(s);
      toast.success('Notificações ativadas neste dispositivo.');
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally { setBusy(false); }
  }, [t.tenant.id, userId]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      // Remove só o vínculo deste usuário; a inscrição do navegador pode servir a outra conta.
      if (sub && userId) await removePushRegistration(supabase, t.tenant.id, userId, sub.endpoint);
      setSub(null);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [sub, userId, t.tenant.id]);

  const state: PushState = !supported ? 'unsupported' : !VAPID ? 'unconfigured' : sub === undefined ? 'checking'
    : sub ? 'on' : perm === 'denied' ? 'denied' : 'off';
  return { state, busy, error, enable, disable, permission: perm };
}

/** Botão compacto (área da equipe). */
export function PushToggle() {
  const { state, busy, error, enable, disable } = usePushDevice();
  if (state === 'unsupported') return <Alert tone="info">Este navegador não recebe notificações push. Os avisos aparecem no sino e por e-mail. No iPhone, instale o app na tela de início (iOS 16.4+).</Alert>;
  if (state === 'unconfigured' || state === 'checking') return null;
  return <div className="space-y-2">
    {error && <Alert tone="warning">{error}</Alert>}
    {state === 'on' ? (
      <Button variant="ghost" onClick={disable} loading={busy}><BellOff className="w-4 h-4" /> Desativar avisos deste condomínio neste dispositivo</Button>
    ) : (
      <Button variant="secondary" onClick={enable} loading={busy}><Bell className="w-4 h-4" /> Ativar avisos deste condomínio neste dispositivo</Button>
    )}
  </div>;
}
