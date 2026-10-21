import React, { useState } from 'react';
import { Bell, Building2, CreditCard, HelpCircle, LayoutDashboard, LogOut, Menu, Package, Settings, Users, X } from 'lucide-react';
import { useSession } from '../../lib/session';
import { useTenant } from '../../lib/tenant';
import { navigate, onLink } from '../../lib/router';
import { publicLogoUrl } from '../../lib/theme';
import { dateTime } from '../../lib/format';
import { Alert } from '../../components/ui';
import { useTour } from '../../components/TourGuide';
import { articleFor } from '../../lib/help';
import { loadProgress, saveProgress, toursFor } from '../../lib/tours';

interface NavItem { area: string; label: string; icon: React.ElementType; show: boolean }

/** “Ajuda desta tela” + oferta do tutorial no primeiro acesso à área (sem obrigar). */
function ScreenHelp({ area, base }: { area: string; base: string }) {
  const t = useTenant();
  const { ctx } = useSession();
  const { start, running } = useTour();
  const role = t.link.role;
  const article = articleFor(area, role);
  const tour = toursFor(role, (p) => t.can(p as any)).find((x) => x.steps[0].area === area);
  const [progress, setProgress] = useState(() => loadProgress(ctx!.user_id, t.tenant.id));
  if (area === 'ajuda' || !article) return null;
  const offer = tour && progress[tour.id] === undefined && !running;
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 text-sm">
      {offer && (
        <span className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-3 py-1.5">
          Primeira vez aqui?
          <button className="font-semibold underline min-h-9" onClick={() => start(tour, base, ctx!.user_id, t.tenant.id)}>Fazer o tutorial</button>
          <button className="text-muted underline min-h-9" onClick={() => { saveProgress(ctx!.user_id, t.tenant.id, tour.id, 'skipped'); setProgress(loadProgress(ctx!.user_id, t.tenant.id)); }}>Agora não</button>
        </span>
      )}
      <a href={`${base}/ajuda?artigo=${article.slug}`} onClick={onLink} className="inline-flex items-center gap-1 text-secondary font-medium min-h-9"><HelpCircle className="w-4 h-4" aria-hidden />Ajuda desta tela</a>
    </div>
  );
}

export function TenantShell({ area, children }: { area: string; children: React.ReactNode }) {
  const t = useTenant();
  const { ctx, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const base = `/c/${t.tenant.slug}`;
  const role = t.link.role;
  const items: NavItem[] = [
    { area: 'portaria', label: 'Portaria', icon: Package, show: t.isStaff },
    { area: 'painel', label: 'Painel', icon: LayoutDashboard, show: role === 'admin' },
    { area: 'pessoas', label: 'Unidades e pessoas', icon: Users, show: t.can('team') || t.can('approve') || role === 'admin' },
    { area: 'morador', label: 'Minhas encomendas', icon: Package, show: role === 'morador' },
    { area: 'avisos', label: 'Avisos', icon: Bell, show: role === 'morador' },
    { area: 'configuracoes', label: 'Configurações', icon: Settings, show: t.can('settings') },
    { area: 'assinatura', label: 'Assinatura', icon: CreditCard, show: t.can('billing') },
    { area: 'ajuda', label: 'Ajuda', icon: HelpCircle, show: true },
  ];
  const others = (ctx?.tenants || []).filter((x) => x.tenant_id !== t.link.tenant_id);
  const name = t.branding?.display_name || t.tenant.name;
  const logo = publicLogoUrl(t.branding?.logo_path);
  const ov = t.overview;
  const state = ov?.commercial_state ?? t.link.commercial_state;

  const nav = (
    <nav aria-label="Principal" className="space-y-1">
      {items.filter((i) => i.show).map((i) => {
        const active = area === i.area;
        return (
          <a key={i.area} href={`${base}/${i.area}`} onClick={(e) => { onLink(e); setOpen(false); }} aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-xl px-3 min-h-11 text-sm font-medium ${active ? 'bg-primary text-primary-fg' : 'text-text hover:bg-surface-2'}`}>
            <i.icon className="w-5 h-5" aria-hidden /> {i.label}
          </a>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      <aside className={`${open ? 'fixed inset-0 z-40 block' : 'hidden'} lg:static lg:block bg-surface border-r border-line p-4`}>
        <div className="flex items-center justify-between lg:block">
          <div className="flex items-center gap-3 min-w-0">
            {logo ? <img src={logo} alt="" className="h-10 w-10 rounded-lg object-contain bg-surface-2" /> : <span className="h-10 w-10 rounded-lg bg-primary text-primary-fg grid place-items-center"><Building2 className="w-5 h-5" /></span>}
            <div className="min-w-0"><p className="font-semibold truncate">{name}</p><p className="text-xs text-muted capitalize">{role === 'admin' ? 'Administração' : role}</p></div>
          </div>
          <button className="lg:hidden p-2" onClick={() => setOpen(false)} aria-label="Fechar menu"><X /></button>
        </div>
        <div className="mt-6">{nav}</div>
        {others.length > 0 && (
          <div className="mt-6">
            <label className="text-xs text-muted" htmlFor="switch-tenant">Trocar de condomínio</label>
            <select id="switch-tenant" className="mt-1 w-full min-h-10 rounded-lg border border-line bg-surface px-2 text-sm" value=""
              onChange={(e) => e.target.value && navigate(`/c/${e.target.value}`)}>
              <option value="">Selecione…</option>
              {others.map((o) => <option key={o.tenant_id + o.role} value={o.slug}>{o.name}</option>)}
            </select>
          </div>
        )}
        <div className="mt-6 border-t border-line pt-4 space-y-2">
          <p className="text-xs text-muted truncate">{ctx?.email}</p>
          {(ctx?.platform_admin || ctx?.platform_role) && <a href="/admin" onClick={onLink} className="block text-sm text-secondary">Administração da plataforma</a>}
          <button onClick={async () => { await signOut(); navigate('/entrar', true); }} className="flex items-center gap-2 text-sm text-muted hover:text-text min-h-10">
            <LogOut className="w-4 h-4" /> Sair
          </button>
          <p className="text-[11px] text-muted pt-2">Tecnologia Portaria Prime</p>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="lg:hidden sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface px-4 h-14">
          <button onClick={() => setOpen(true)} aria-label="Abrir menu" className="p-2 -ml-2"><Menu /></button>
          <span className="font-semibold truncate">{name}</span>
        </header>
        <main className="max-w-6xl mx-auto px-4 py-6 space-y-4">
          {t.isStaff && ov?.status === 'trialing' && state === 'full' && (
            <Alert tone="info">Mês grátis até <strong>{dateTime(ov.trial_ends_at, t.tenant.timezone)}</strong>.{t.can('billing') && <> <a className="underline" href={`${base}/assinatura`} onClick={onLink}>Ver assinatura</a></>}</Alert>
          )}
          {t.isStaff && state === 'grace' && (
            <Alert tone="warning">O acesso pago terminou. Período de carência: regularize para não bloquear novos recebimentos.{t.can('billing') && <> <a className="underline" href={`${base}/assinatura`} onClick={onLink}>Pagar assinatura</a></>}</Alert>
          )}
          {t.isStaff && state === 'restricted' && (
            <Alert tone="danger">Assinatura inativa: novos recebimentos estão bloqueados. Consulta, exportação e retirada de encomendas já guardadas continuam liberadas.</Alert>
          )}
          <ScreenHelp area={area} base={base} />
          {children}
        </main>
      </div>
    </div>
  );
}
