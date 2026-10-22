import React, { useEffect, useState } from 'react';
import { usePwaInstall } from '../../hooks/usePwaInstall';
import { PushToggle } from '../../components/PushToggle';
import { Alert, Button, Card } from '../../components/ui';

/** Estado detectado neste dispositivo; o que não dá para detectar fica como “não detectável”. */
function useCapabilities() {
  const [perm, setPerm] = useState<string>(() => ('Notification' in window ? Notification.permission : 'indisponível'));
  const [sw, setSw] = useState<'ativo' | 'ausente' | 'verificando'>('verificando');
  useEffect(() => {
    navigator.serviceWorker?.getRegistration().then((r) => setSw(r?.active ? 'ativo' : 'ausente')).catch(() => setSw('ausente'));
    const onFocus = () => 'Notification' in window && setPerm(Notification.permission);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = /Instagram|FBAN|FBAV|Line\/|WhatsApp/i.test(ua);
  const push = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return { perm, sw, ios, inApp, push };
}

export function AppPage() {
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  const c = useCapabilities();
  const row = (k: string, v: string) => <><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Aplicativo e notificações</h1>
      <Card className="space-y-3">
        <p className="font-semibold">Este dispositivo</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {row('Instalado na tela inicial', isInstalled ? 'sim' : 'não (ou não detectável neste navegador)')}
          {row('Suporte a notificações push', c.push ? 'sim' : 'não')}
          {row('Permissão de notificação', { granted: 'permitida', denied: 'bloqueada', default: 'ainda não pedida' }[c.perm] || c.perm)}
          {row('Serviço do app', c.sw)}
        </dl>
        {c.inApp && <Alert tone="warning">Você abriu pelo navegador de outro aplicativo. Abra este endereço no Chrome (Android) ou Safari (iPhone) para instalar e receber notificações.</Alert>}
        {!isInstalled && isInstallable && <Button onClick={() => promptInstall()}>Instalar aplicativo</Button>}
        {!isInstalled && !isInstallable && (c.ios
          ? <Alert>iPhone/iPad (iOS 16.4 ou mais novo): no Safari, toque em Compartilhar › “Adicionar à Tela de Início”, abra o app pelo ícone e depois ative as notificações aqui. Fora da Tela de Início o iPhone não entrega push.</Alert>
          : <Alert>Para instalar: no menu do navegador (⋮), escolha “Instalar app” ou “Adicionar à tela inicial”.</Alert>)}
      </Card>
      <Card className="space-y-3">
        <p className="font-semibold">Notificações deste condomínio</p>
        {c.perm === 'denied' && <Alert tone="warning">As notificações estão bloqueadas neste navegador. Libere nas configurações do site (ícone de cadeado na barra de endereço) e volte aqui.</Alert>}
        <PushToggle />
        <p className="text-xs text-muted">Os avisos ficam sempre na central “Avisos”, mesmo sem push. Push depende do sistema do aparelho (modo foco, economia de bateria e permissões podem atrasar ou esconder).</p>
      </Card>
    </div>
  );
}
