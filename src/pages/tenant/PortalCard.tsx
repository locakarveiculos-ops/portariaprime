import React, { useState } from 'react';
import { Copy, Download, ExternalLink, Share2 } from 'lucide-react';
import QRCode from 'qrcode';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { publicLogoUrl } from '../../lib/theme';
import { publishIcons } from '../../lib/app-icons';
import { QRCodeDisplay } from '../../components/VisualCodes';
import { Alert, Button, Card, toast, useAction } from '../../components/ui';

/** Link público do condomínio, QR de acesso, ícones do app e reenvio das boas-vindas. */
export function PortalCard() {
  const t = useTenant();
  const { busy, run } = useAction();
  const [iconsAt, setIconsAt] = useState<number | null>(t.branding?.app_icons_version || null);
  if (!t.can('settings')) return null;
  // Host canônico do próprio app (o mesmo que o servidor usa nas mensagens).
  const link = `${location.origin}/c/${t.tenant.slug}`;
  const name = t.branding?.display_name || t.tenant.name;
  const copy = async () => { await navigator.clipboard.writeText(link); toast.success('Link copiado.'); };
  const share = () => navigator.share?.({ title: name, text: `Portal do ${name}: acesse e solicite seu cadastro.`, url: link }).catch(() => {});
  const downloadQr = async () => {
    const url = await QRCode.toDataURL(link, { width: 1024, margin: 4, errorCorrectionLevel: 'M' });
    const a = document.createElement('a'); a.href = url; a.download = `qr-portal-${t.tenant.slug}.png`; a.click();
  };
  const icons = () => run(async () => {
    setIconsAt(await publishIcons(t.tenant.id, { name, color: t.branding?.color_primary || '#101F30', logoUrl: publicLogoUrl(t.branding?.logo_path) }));
    await t.reload();
  }, 'Ícones do aplicativo atualizados.');
  return (
    <Card className="space-y-4" id="portal" data-tour="config-portal">
      <div><p className="font-semibold">Portal e aplicativo</p>
        <p className="text-sm text-muted">Endereço público do condomínio. Compartilhe com moradores para que criem a conta e peçam acesso (a administração aprova).</p></div>
      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 p-3">
        <code className="text-sm break-all flex-1">{link}</code>
        <Button variant="secondary" onClick={copy}><Copy className="w-4 h-4" /> Copiar link</Button>
        {'share' in navigator && <Button variant="secondary" onClick={share}><Share2 className="w-4 h-4" /> Compartilhar</Button>}
        <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline min-h-11"><ExternalLink className="w-4 h-4" /> Abrir portal</a>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <QRCodeDisplay value={link} size={140} />
        <div className="space-y-2">
          <p className="text-sm text-muted">QR apenas com o endereço público (sem senha nem convite). Imprima para o mural ou elevador.</p>
          <Button variant="secondary" onClick={downloadQr}><Download className="w-4 h-4" /> Baixar QR de acesso</Button>
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Ícone do aplicativo</p>
        <p className="text-sm text-muted">Quem instalar o app a partir do portal vê o nome e o ícone do condomínio. Gere os ícones depois de trocar o logo. Apps já instalados podem levar dias para atualizar o ícone (depende do sistema) ou exigir reinstalação.</p>
        <Button variant="secondary" loading={busy} onClick={icons}>{iconsAt ? 'Atualizar ícones com o logo atual' : 'Gerar ícones do aplicativo'}</Button>
        {!iconsAt && <Alert tone="info">Sem ícones próprios, o app usa o ícone da Portaria Prime.</Alert>}
      </div>
      <Button variant="ghost" loading={busy} onClick={() => run(() => rpc('resend_portal_welcome', { p_tenant: t.tenant.id }), 'Boas-vindas reenviadas ao seu e-mail.')}>Reenviar o link do portal para mim</Button>
    </Card>
  );
}
