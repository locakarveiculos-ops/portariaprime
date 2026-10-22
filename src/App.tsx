import React, { lazy, Suspense, useEffect } from 'react';
import { configError } from './lib/supabase';
import { SessionProvider, useSession } from './lib/session';
import { TenantProvider } from './lib/tenant';
import { matchTenant, navigate, onLink, usePath } from './lib/router';
import { Alert, Button, Card, Spinner, Toaster } from './components/ui';
import { PortariaPrimeLogo } from './components/Brand';
import { TourProvider } from './components/TourGuide';

// Telas de login/app carregam sob demanda: a landing pública não paga por elas.
const auth = () => import('./pages/auth/AuthPages');
const LoginPage = lazy(() => auth().then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => auth().then(m => ({ default: m.SignupPage })));
const RecoverPage = lazy(() => auth().then(m => ({ default: m.RecoverPage })));
const NewPasswordPage = lazy(() => auth().then(m => ({ default: m.NewPasswordPage })));
const InvitePage = lazy(() => auth().then(m => ({ default: m.InvitePage })));
const TenantShell = lazy(() => import('./pages/tenant/TenantShell').then(m => ({ default: m.TenantShell })));

const Onboarding = lazy(() => import('./pages/Onboarding').then(m => ({ default: m.OnboardingPage })));
const Portaria = lazy(() => import('./pages/tenant/portaria/PortariaPage').then(m => ({ default: m.PortariaPage })));
const AppInfo = lazy(() => import('./pages/tenant/AppPage').then(m => ({ default: m.AppPage })));
const Comprovante = lazy(() => import('./pages/tenant/Receipt').then(m => ({ default: m.ReceiptPage })));
const Morador = lazy(() => import('./pages/tenant/MoradorPage').then(m => ({ default: m.MoradorPage })));
const Avisos = lazy(() => import('./pages/tenant/MoradorPage').then(m => ({ default: m.AvisosPage })));
const Painel = lazy(() => import('./pages/tenant/PainelPage').then(m => ({ default: m.PainelPage })));
const Pessoas = lazy(() => import('./pages/tenant/PessoasPage').then(m => ({ default: m.PessoasPage })));
const Config = lazy(() => import('./pages/tenant/ConfigPage').then(m => ({ default: m.ConfigPage })));
const Assinatura = lazy(() => import('./pages/tenant/AssinaturaPage').then(m => ({ default: m.AssinaturaPage })));
const Retorno = lazy(() => import('./pages/tenant/AssinaturaPage').then(m => ({ default: m.CheckoutReturnPage })));
const Totem = lazy(() => import('./pages/TotemPage'));
const Admin = lazy(() => import('./pages/AdminPage'));
const Ajuda = lazy(() => import('./pages/HelpPage'));
const Landing = lazy(() => import('./pages/LandingPage'));
const Portal = lazy(() => import('./pages/PortalPage').then(m => ({ default: m.PortalPage })));
const RequestAccess = lazy(() => import('./pages/PortalPage').then(m => ({ default: m.RequestAccessPage })));

function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, true); }, [to]);
  return <Spinner />;
}

const admin0 = (l: { role: string; permissions: string[] }) => l.role === 'admin' && l.permissions.includes('settings');

function Routes() {
  const path = usePath();
  const { ctx, session, loading, error, refresh, signOut } = useSession();
  const route = matchTenant(path);
  if (path === '/termos' || path === '/privacidade') return <LegalPage privacy={path === '/privacidade'} />;
  if (configError) return <main className="max-w-lg mx-auto p-6"><PortariaPrimeLogo /><Alert tone="danger">{configError}</Alert></main>;
  // /totem: equipe logada vai ao totem da equipe (OCR, entrega); sem login segue o totem público pareado.
  if (route?.area === 'totem') {
    if (loading) return <Spinner />;
    const staffHere = ctx?.tenants.some(t => t.slug === route.slug && t.tenant_status === 'active' && (t.role === 'admin' || t.role === 'porteiro'));
    return staffHere ? <Redirect to={`/c/${route.slug}/totem-equipe`} /> : <Totem slug={route.slug} />;
  }
  // Landing pública: não espera a sessão; com sessão mostra "Acessar meu condomínio".
  if (path === '/') return <Landing />;
  if (loading) return <Spinner />;
  if (path === '/entrar') return <LoginPage />;
  if (path === '/cadastro') return <SignupPage />;
  if (path === '/recuperar-senha') return <RecoverPage />;
  if (path === '/nova-senha') return <NewPasswordPage />;
  if (path === '/convite') return <InvitePage />;
  // Portal do condomínio: página pública com a marca dele (sem sessão não há dados internos).
  if (route && !session) return route.area ? <Redirect to={`/c/${route.slug}`} /> : <Portal slug={route.slug} />;
  if (route?.area === 'solicitar') return <RequestAccess slug={route.slug} />;
  if (!session) return <Redirect to={`/entrar?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  if (error || !ctx) return <main className="max-w-lg mx-auto p-6 space-y-4"><Alert tone="danger">{error || 'Não foi possível carregar seus vínculos.'}</Alert><Button onClick={refresh}>Tentar novamente</Button><Button variant="ghost" onClick={signOut}>Sair</Button></main>;
  if (path === '/onboarding') return <Onboarding />;
  if (path === '/checkout/retorno') return <Retorno />;
  if (path === '/admin') return (ctx.platform_admin || ctx.platform_role) ? <Admin /> : <Alert tone="danger">Acesso restrito à administração da plataforma.</Alert>;
  if (path === '/app') return <main className="max-w-2xl mx-auto px-4 py-10 space-y-5">
    <PortariaPrimeLogo /><h1 className="text-2xl font-semibold">Escolha o condomínio</h1>
    {ctx.tenants.length === 0 && <Alert>Nenhum vínculo ativo. Use o convite recebido ou cadastre seu condomínio.</Alert>}
    {Array.from(new Map(ctx.tenants.map(t => [t.tenant_id, t])).values()).map(t => <Card key={t.tenant_id}>
      <a className="font-semibold underline" href={`/c/${t.slug}`} onClick={onLink}>{t.name}</a>
    </Card>)}
    <Button onClick={() => navigate('/onboarding')}>Cadastrar condomínio</Button>
    {(ctx.platform_admin || ctx.platform_role) && <Button variant="secondary" onClick={() => navigate('/admin')}>Administrar plataforma</Button>}
    <Button variant="ghost" onClick={signOut}>Sair</Button>
  </main>;
  if (route) {
    const links = ctx.tenants.filter(t => t.slug === route.slug && t.tenant_status === 'active');
    const link = links.find(t => t.role === 'admin') || links.find(t => t.role === 'porteiro') || links[0];
    // Logado sem vínculo aqui: portal (pedir cadastro), nunca dados deste condomínio.
    if (!link) return <Portal slug={route.slug} />;
    if (!route.area) return <Redirect to={`/c/${route.slug}/${link.role === 'morador' ? 'morador' : admin0(link) ? 'configuracoes' : 'portaria'}`} />;
    const admin = link.role === 'admin';
    const staff = admin || link.role === 'porteiro';
    const perm = (p: string) => admin && link.permissions.includes(p);
    let page: React.ReactNode = <Alert tone="danger">Área indisponível para seu vínculo.</Alert>;
    if (route.area === 'portaria' && staff) page = <Portaria />;
    if (route.area === 'totem-equipe' && staff) page = <Portaria totem />;
    if (route.area === 'painel' && admin) page = <Painel />;
    if (route.area === 'pessoas' && admin) page = <Pessoas />;
    if (route.area === 'configuracoes' && perm('settings')) page = <Config />;
    if (route.area === 'assinatura' && perm('billing')) page = <Assinatura />;
    if (route.area === 'morador' && links.some(t => t.role === 'morador')) page = <Morador />;
    if (route.area === 'avisos') page = <Avisos />;
    if (route.area === 'aplicativo') page = <AppInfo />;
    if (route.area === 'ajuda') page = <Ajuda />;
    if (route.area === 'comprovante') page = <Comprovante />;
    return <TenantProvider key={link.tenant_id} link={link}><TourProvider><TenantShell area={route.area}><Suspense fallback={<Spinner />}>{page}</Suspense></TenantShell></TourProvider></TenantProvider>;
  }
  return <main className="p-6"><h1>Página não encontrada</h1><a href="/app" onClick={onLink}>Voltar ao sistema</a></main>;
}

function LegalPage({ privacy }: { privacy: boolean }) {
  return <main className="max-w-2xl mx-auto px-4 py-10 space-y-4"><PortariaPrimeLogo />
    <h1 className="text-2xl font-semibold">{privacy ? 'Política de privacidade' : 'Termos de uso'}</h1>
    <Alert tone="warning">Minuta para revisão jurídica. Contato de privacidade, retenção e condições contratuais precisam ser aprovados antes da operação comercial.</Alert>
    <p className="text-sm text-muted">Portaria Prime · CNPJ 59.760.458/0001-91. Pagamentos processados pela InfinitePay (CloudWalk).</p>
    <p>{privacy ? 'O sistema trata identificação e contatos dos usuários, vínculos com unidades, registros de encomendas, fotos e assinaturas de retirada para operar a portaria. O acesso deve ser restrito às pessoas autorizadas pelo condomínio.' : 'O acesso depende de conta verificada e vínculo autorizado com o condomínio. A equipe deve conferir destinatário, unidade e identidade de quem retira. OCR é uma sugestão que exige revisão humana.'}</p>
    <p>O teste dura um mês de calendário por condomínio. Ao final, a renovação exige pagamento por link, sem débito automático. Inadimplência não autoriza apagar histórico nem provas de retirada.</p>
    <p>Assinatura desenhada na tela é registro operacional, não assinatura digital certificada. Canais externos e conectividade podem ficar indisponíveis.</p>
    <a href="/" onClick={onLink} className="underline">Voltar</a>
  </main>;
}

export default function App() {
  return <SessionProvider><Suspense fallback={<Spinner />}><Routes /></Suspense><Toaster /></SessionProvider>;
}
