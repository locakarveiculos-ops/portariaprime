import React, { useEffect, useState } from 'react';
import { Building2, Package, ShieldCheck, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { friendly, rpc } from '../lib/api';
import { navigate, onLink } from '../lib/router';
import { useSession } from '../lib/session';
import { applyTheme, publicLogoUrl } from '../lib/theme';
import { Alert, Button, Field, Input, Spinner } from '../components/ui';

export interface Portal { slug: string; name: string; logo_path: string | null; color_primary: string | null; color_secondary: string | null; color_accent: string | null; status: string }

/** Marca pública do condomínio (só nome, logo e cores). */
export function usePortal(slug: string) {
  const [p, setP] = useState<Portal | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    supabase.rpc('portal_info', { p_slug: slug }).then(({ data, error }) => {
      if (!on) return;
      if (error) { setError('Não foi possível carregar o portal. Verifique a conexão.'); setP(null); return; }
      setP(data || null);
      if (data) applyTheme({ ...data, theme: 'light' } as any);
    });
    return () => { on = false; applyTheme(null); };
  }, [slug]);
  return { portal: p, error };
}

export function PortalShell({ portal, children }: { portal: Portal; children: React.ReactNode }) {
  const logo = publicLogoUrl(portal.logo_path);
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="bg-primary text-primary-fg">
        <div className="max-w-3xl mx-auto px-4 py-8 flex items-center gap-4">
          {logo ? <img src={logo} alt="" className="h-16 w-16 rounded-xl bg-white object-contain p-1" />
            : <span className="h-16 w-16 rounded-xl bg-white/15 grid place-items-center"><Building2 className="w-8 h-8" /></span>}
          <div className="min-w-0"><p className="text-xs uppercase tracking-wide opacity-80">Portal do condomínio</p><h1 className="text-2xl font-semibold truncate">{portal.name}</h1></div>
        </div>
      </header>
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-8">{children}</main>
      <footer className="text-center text-[11px] text-muted pb-6">Tecnologia Portaria Prime</footer>
    </div>
  );
}

export function PortalNotFound({ error }: { error?: string | null }) {
  return (
    <main className="min-h-dvh grid place-items-center px-4"><div className="max-w-sm text-center space-y-3">
      <h1 className="text-xl font-semibold">{error ? 'Portal indisponível' : 'Condomínio não encontrado'}</h1>
      <p className="text-sm text-muted">{error || 'Confira o endereço com a administração do seu condomínio.'}</p>
      <a href="/" onClick={onLink} className="underline text-sm">Ir para Portaria Prime</a>
    </div></main>
  );
}

/** /c/{slug} sem vínculo: três acessos. Clicar só define o contexto; o servidor decide o papel. */
export function PortalPage({ slug }: { slug: string }) {
  const { portal, error } = usePortal(slug);
  const { session } = useSession();
  if (portal === undefined) return <Spinner />;
  if (!portal || portal.status !== 'active') return <PortalNotFound error={error || (portal ? 'Este portal está temporariamente indisponível.' : null)} />;
  const here = `/c/${slug}`;
  const login = (area: string) => navigate(`/entrar?next=${encodeURIComponent(`${here}/${area}`)}&portal=${slug}`);
  const cards: [string, string, React.ElementType, () => void][] = [
    ['Administração', 'Síndico e administradores do condomínio.', ShieldCheck, () => login('configuracoes')],
    ['Portaria', 'Equipe da portaria: receber e entregar encomendas.', Package, () => login('portaria')],
    ['Morador', 'Acompanhe suas encomendas e comprovantes.', Users, () => navigate(session ? `${here}/solicitar` : `/entrar?next=${encodeURIComponent(`${here}/solicitar`)}&portal=${slug}`)],
  ];
  return (
    <PortalShell portal={portal}>
      <p className="text-lg">Bem-vindo(a). Escolha como deseja acessar:</p>
      <div className="mt-6 grid sm:grid-cols-3 gap-3">
        {cards.map(([t, d, Icon, go]) => (
          <button key={t} onClick={go} className="text-left rounded-2xl border border-line bg-surface p-5 hover:bg-surface-2 min-h-32 focus:outline-none focus:ring-2 focus:ring-primary">
            <Icon className="w-6 h-6 text-primary" aria-hidden /><p className="mt-3 font-semibold">{t}</p><p className="text-sm text-muted">{d}</p>
          </button>
        ))}
      </div>
      <div className="mt-8 rounded-2xl bg-surface-2 p-5 space-y-2">
        <p className="font-semibold">Mora aqui e ainda não tem acesso?</p>
        <p className="text-sm text-muted">Crie sua conta e informe sua unidade. A administração aprova o cadastro antes de liberar suas encomendas.</p>
        <Button onClick={() => navigate(session ? `${here}/solicitar` : `/cadastro?next=${encodeURIComponent(`${here}/solicitar`)}&portal=${slug}`)}>Criar minha conta</Button>
      </div>
    </PortalShell>
  );
}

/** Solicitação de vínculo (conta já criada e verificada). Mesma resposta exista a unidade ou não. */
export function RequestAccessPage({ slug }: { slug: string }) {
  const { portal, error: perr } = usePortal(slug);
  const { session, ctx, loading, refresh } = useSession();
  const [req, setReq] = useState<any>(undefined);
  const [f, setF] = useState({ full_name: '', phone: '', block: '', unit: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => rpc('my_access_request', { p_slug: slug }).then(setReq).catch(() => setReq(null));
  useEffect(() => { if (session) void load(); }, [session, slug]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Aprovado: entra no condomínio.
    if (req?.status === 'approved') { void refresh().then(() => navigate(`/c/${slug}/morador`, true)); }
  }, [req?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (portal === undefined || loading || (session && req === undefined)) return <Spinner />;
  if (!portal || portal.status !== 'active') return <PortalNotFound error={perr} />;
  if (!session) { navigate(`/entrar?next=${encodeURIComponent(`/c/${slug}/solicitar`)}&portal=${slug}`, true); return <Spinner />; }
  if (ctx?.tenants.some((t) => t.slug === slug && t.role === 'morador')) { navigate(`/c/${slug}/morador`, true); return <Spinner />; }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await rpc('request_access', { p_slug: slug, p_full_name: f.full_name, p_phone: f.phone || null, p_block: f.block || null, p_unit: f.unit });
      await load();
    } catch (err: any) { setError(friendly(err)); } finally { setBusy(false); }
  };
  return (
    <PortalShell portal={portal}>
      <h2 className="text-xl font-semibold">Cadastro de morador</h2>
      {req?.status === 'pending' ? (
        <div className="mt-4 space-y-3">
          <Alert tone="info">Seu cadastro está aguardando aprovação da administração. Unidade informada: <strong>{req.unit_text}</strong>.</Alert>
          <p className="text-sm text-muted">Você será avisado por e-mail. Enquanto isso, nenhuma informação do condomínio é exibida.</p>
          <Button variant="secondary" onClick={load}>Verificar novamente</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-4 max-w-md">
          {req?.status === 'rejected' && <Alert tone="warning">Sua solicitação anterior não foi aprovada{req.reason ? `: ${req.reason}` : ''}. Revise os dados ou fale com a administração.</Alert>}
          <p className="text-sm text-muted">Conectado como <strong>{ctx?.email}</strong>. A administração confere os dados antes de liberar o acesso.</p>
          <Field label="Nome completo"><Input required minLength={2} maxLength={120} autoComplete="name" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
          <Field label="Celular com DDD (para avisos no WhatsApp)"><Input inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="11 99999-0000" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bloco/Torre (se houver)"><Input maxLength={30} value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} /></Field>
            <Field label="Unidade"><Input required maxLength={30} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="101, 12B, Casa 3" /></Field>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={busy} className="w-full">Enviar solicitação</Button>
        </form>
      )}
    </PortalShell>
  );
}
