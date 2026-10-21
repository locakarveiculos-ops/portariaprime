import React, { useEffect, useRef, useState } from 'react';
import { Bell, Building2, Check, ClipboardCheck, FileCheck2, History, Menu, PackagePlus, ScanLine, ShieldCheck, Warehouse, X } from 'lucide-react';
import { PortariaPrimeLogo } from '../components/Brand';
import { ContactForm } from '../components/ContactForm';
import { Button, Card } from '../components/ui';
import { featureList, loadCatalog, PlanRow } from '../lib/catalog';
import { brl, CYCLE_LABEL, CYCLE_MONTHS } from '../lib/format';
import { track } from '../lib/funnel';
import { navigate, onLink } from '../lib/router';
import { useSession } from '../lib/session';
import { Screen, SCREENS, srcSet } from '../lib/screens';

type Cycle = 'monthly' | 'quarterly' | 'yearly';

/** Página pública. Todos os números de preço/limite vêm do catálogo publicado no banco. */
export default function LandingPage() {
  const { session } = useSession();
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [cycle, setCycle] = useState<Cycle>('monthly');
  const [menu, setMenu] = useState(false);
  const [zoom, setZoom] = useState<Screen | null>(null);
  const pricingRef = useRef<HTMLElement>(null);

  useEffect(() => { track('landing_view'); loadCatalog().then(setPlans).catch(() => setCatalogError(true)); }, []);
  useEffect(() => {
    const el = pricingRef.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { track('pricing_view'); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const trial = (plan?: string) => {
    track('cta_trial_click', plan);
    const q = plan ? `?plano=${plan}&ciclo=${cycle}` : '';
    navigate(session ? `/onboarding${q}` : `/cadastro?next=${encodeURIComponent(`/onboarding${q}`)}`);
  };
  const selectable = (plans || []).filter((p) => !p.is_custom && p.prices.length);
  const custom = (plans || []).find((p) => p.is_custom);
  const nav: [string, string][] = [['#como-funciona', 'Como funciona'], ['#recursos', 'Recursos'], ['#telas', 'Telas do sistema'], ['#planos', 'Planos'], ['#duvidas', 'Dúvidas']];

  return (
    <div className="min-h-dvh bg-bg text-text">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 bg-surface px-3 py-2 rounded-lg z-50">Pular para o conteúdo</a>
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <a href="/" aria-label="Portaria Prime, início"><PortariaPrimeLogo className="h-8 w-auto" /></a>
          <nav aria-label="Seções" className="hidden lg:flex items-center gap-6 text-sm font-medium">{nav.map(([h, l]) => <a key={h} href={h} className="hover:text-secondary">{l}</a>)}</nav>
          <div className="hidden lg:flex items-center gap-2">
            {session ? <Button variant="secondary" onClick={() => navigate('/app')}>Acessar meu condomínio</Button> : <a href="/entrar" onClick={onLink} className="px-3 min-h-11 inline-flex items-center text-sm font-semibold">Entrar</a>}
            <Button onClick={() => trial()}>Testar grátis por 1 mês</Button>
          </div>
          <button className="lg:hidden p-2" aria-label={menu ? 'Fechar menu' : 'Abrir menu'} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</button>
        </div>
        {menu && <nav aria-label="Seções" className="lg:hidden border-t border-line px-4 py-3 space-y-1 bg-surface">
          {nav.map(([h, l]) => <a key={h} href={h} onClick={() => setMenu(false)} className="block min-h-11 py-2">{l}</a>)}
          {session ? <a href="/app" onClick={onLink} className="block min-h-11 py-2 font-semibold">Acessar meu condomínio</a> : <a href="/entrar" onClick={onLink} className="block min-h-11 py-2 font-semibold">Entrar</a>}
          <Button className="w-full" onClick={() => trial()}>Testar grátis por 1 mês</Button>
        </nav>}
      </header>

      <main id="conteudo">
        <section className="bg-midnight text-porcelain">
          <div className="max-w-6xl mx-auto px-4 py-14 lg:py-20 grid lg:grid-cols-[1fr_1.1fr] gap-10 items-center">
            <div>
              <h1 className="text-4xl sm:text-5xl font-semibold leading-tight">Cada encomenda. Tudo sob controle.</h1>
              <p className="mt-4 text-lg text-porcelain/80 max-w-xl">Organize o recebimento, avise os moradores e registre cada retirada em uma única plataforma.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <button onClick={() => trial()} className="min-h-12 px-6 rounded-xl bg-champagne text-midnight font-semibold hover:opacity-90">Testar grátis por 1 mês</button>
                <a href="#telas" className="min-h-12 px-6 rounded-xl border border-porcelain/40 inline-flex items-center font-semibold hover:bg-white/10">Ver o sistema por dentro</a>
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-porcelain/80">
                <li className="flex gap-2 items-center"><Check className="w-4 h-4 text-champagne" aria-hidden />Sem cartão para começar</li>
                <li className="flex gap-2 items-center"><Check className="w-4 h-4 text-champagne" aria-hidden />Um mês de teste por condomínio</li>
                <li className="flex gap-2 items-center"><Check className="w-4 h-4 text-champagne" aria-hidden />Preço depois do teste mostrado antes</li>
              </ul>
            </div>
            <figure>
              <img src={SCREENS.painel.file} srcSet={srcSet(SCREENS.painel)} sizes="(min-width: 1024px) 560px, 100vw" alt={`${SCREENS.painel.title}: ${SCREENS.painel.caption}`} width={SCREENS.painel.width} height={SCREENS.painel.height} fetchPriority="high" className="w-full h-auto rounded-2xl border border-white/15 shadow-2xl" />
              <figcaption className="mt-2 text-xs text-porcelain/60">Tela real da plataforma com dados de demonstração.</figcaption>
            </figure>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="problemas">
          <h2 id="problemas" className="text-3xl font-semibold">O que deixa de acontecer na portaria</h2>
          <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              ['Procurar caixa por caixa', 'Cada encomenda tem local de guarda registrado. A busca acha por unidade, rastreio ou nome.'],
              ['Morador que não ficou sabendo', 'O aviso sai quando o registro é salvo, e fica no app mesmo se o e-mail ou WhatsApp falhar.'],
              ['Retirada sem prova', 'QR de uso único, assinatura na tela e comprovante com protocolo.'],
              ['Prateleira lotada sem aviso', 'Capacidade por local e ocupação no painel. Quando lota, o sistema avisa.'],
            ].map(([t, d]) => <Card key={t}><h3 className="font-semibold">{t}</h3><p className="text-sm text-muted mt-2">{d}</p></Card>)}
          </div>
        </section>

        <section id="como-funciona" className="bg-surface border-y border-line" aria-labelledby="como-h">
          <div className="max-w-6xl mx-auto px-4 py-16">
            <h2 id="como-h" className="text-3xl font-semibold">Como funciona</h2>
            <ol className="mt-8 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                [PackagePlus, 'Receber', 'O porteiro registra unidade, transportadora e rastreio. Leitor USB e câmera funcionam.'],
                [ScanLine, 'Conferir', 'A leitura da etiqueta sugere os dados; uma pessoa confere antes de salvar.'],
                [Warehouse, 'Armazenar', 'O sistema sugere o local com mais espaço e registra cada movimentação.'],
                [Bell, 'Avisar', 'O morador recebe o aviso no app e nos canais configurados.'],
                [ClipboardCheck, 'Entregar', 'Leitura do QR do morador, assinatura e comprovante.'],
                [History, 'Acompanhar', 'Painel com pendências, ocupação, exceções e exportação CSV.'],
              ].map(([Icon, t, d], i) => { const I = Icon as React.ElementType; return (
                <li key={t as string} className="rounded-2xl border border-line p-5 bg-bg">
                  <div className="flex items-center gap-3"><span className="h-9 w-9 rounded-full bg-midnight text-porcelain grid place-items-center text-sm font-semibold">{i + 1}</span><I className="w-5 h-5 text-secondary" aria-hidden /></div>
                  <h3 className="font-semibold mt-3">{t as string}</h3><p className="text-sm text-muted mt-1">{d as string}</p>
                </li>
              ); })}
            </ol>
          </div>
        </section>

        <section id="telas" className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="telas-h">
          <h2 id="telas-h" className="text-3xl font-semibold">Telas do sistema</h2>
          <p className="text-muted mt-2">Telas reais da plataforma com dados de demonstração.</p>
          <ul className="mt-8 grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {(['recebimento', 'armazenamento', 'portariaMobile', 'morador', 'comprovante', 'assinatura'] as const).map((k) => { const s = SCREENS[k]; return (
              <li key={k}><button className="block w-full text-left group" onClick={() => setZoom(s)}>
                <img src={s.file} srcSet={srcSet(s)} sizes="(min-width: 1024px) 380px, (min-width: 640px) 50vw, 100vw" alt={`${s.title}: ${s.caption}`} width={s.width} height={s.height} loading="lazy" className={`w-full rounded-xl border border-line bg-surface ${s.width < 600 ? 'h-72 object-contain' : 'h-auto'} group-hover:opacity-90`} />
                <span className="block font-semibold mt-3"><span className="sr-only">Ampliar: </span>{s.title}</span><span className="block text-sm text-muted">{s.caption}</span>
              </button></li>
            ); })}
          </ul>
        </section>

        <section id="recursos" className="bg-surface border-y border-line" aria-labelledby="papeis-h">
          <div className="max-w-6xl mx-auto px-4 py-16">
            <h2 id="papeis-h" className="text-3xl font-semibold">Para cada pessoa do condomínio</h2>
            <div className="mt-8 grid lg:grid-cols-3 gap-4">
              {[
                ['Porteiro', ['Receber, Entregar e Buscar em destaque', 'Funciona no celular, tablet e computador', 'Leitor de código de barras e câmera', 'Entrega sem QR com justificativa registrada']],
                ['Síndico', ['Painel de pendências e ocupação', 'Unidades, convites e equipe com permissões', 'Relatórios por período e exportação CSV', 'Assinatura separada da operação']],
                ['Morador', ['Aviso quando a encomenda chega', 'QR de retirada de uso único', 'Histórico e comprovantes', 'Sem menus administrativos']],
              ].map(([who, items]) => (
                <Card key={who as string}><h3 className="text-lg font-semibold">{who as string}</h3>
                  <ul className="mt-3 space-y-2 text-sm">{(items as string[]).map((i) => <li key={i} className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-success shrink-0" aria-hidden />{i}</li>)}</ul>
                </Card>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted">Nos planos com totem, o entregador pode deixar o pré-registro em um tablet; a portaria confere antes de avisar o morador.</p>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="marca-h">
          <h2 id="marca-h" className="text-3xl font-semibold">A identidade do seu condomínio</h2>
          <p className="text-muted mt-2">Logo e cores próprias. Cada condomínio vê só os próprios dados.</p>
          <div className="mt-8 grid sm:grid-cols-2 gap-5">
            {(['marcaA', 'marcaB'] as const).map((k) => { const s = SCREENS[k]; return (
              <figure key={k}><img src={s.file} srcSet={srcSet(s)} sizes="(min-width: 640px) 50vw, 100vw" alt={`${s.title}: ${s.caption}`} width={s.width} height={s.height} loading="lazy" className="w-full h-auto rounded-xl border border-line" />
                <figcaption className="mt-2 text-sm"><strong>{s.title}.</strong> <span className="text-muted">{s.caption}</span></figcaption></figure>
            ); })}
          </div>
        </section>

        <section id="planos" ref={pricingRef} className="bg-surface border-y border-line" aria-labelledby="planos-h">
          <div className="max-w-6xl mx-auto px-4 py-16">
            <h2 id="planos-h" className="text-3xl font-semibold">Planos</h2>
            <p className="text-muted mt-2">Todo condomínio novo começa com um mês grátis, sem cartão. Depois, o pagamento é por link (Pix ou cartão), sem débito automático.</p>
            <div className="mt-6 inline-grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Ciclo de pagamento">
              {(['monthly', 'quarterly', 'yearly'] as const).map((c) => <button key={c} role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)} className={`min-h-11 px-4 rounded-lg text-sm font-medium ${cycle === c ? 'bg-surface shadow text-text' : 'text-muted'}`}>{CYCLE_LABEL[c]}</button>)}
            </div>
            {catalogError ? <p className="mt-6 text-sm">Não foi possível carregar os planos agora. Recarregue a página ou fale com a gente pelo formulário abaixo.</p>
              : !plans ? <p className="mt-6 text-sm text-muted" role="status">Carregando planos…</p>
              : selectable.length === 0 ? <p className="mt-6 text-sm">Os planos estão em revisão e serão publicados em breve. Deixe seu contato abaixo para receber os valores.</p>
              : (
              <div className="mt-8 grid md:grid-cols-3 gap-4">
                {selectable.map((p) => {
                  const pr = p.prices.find((x) => x.cycle === cycle);
                  return (
                    <Card key={p.code} className={`flex flex-col ${p.code === 'profissional' ? 'ring-2 ring-secondary' : ''}`}>
                      <h3 className="text-xl font-semibold">{p.name}</h3>
                      {p.description && <p className="text-sm text-muted mt-1">{p.description}</p>}
                      {pr ? <p className="mt-4"><span className="text-3xl font-semibold">{brl(pr.amount_cents)}</span> <span className="text-sm text-muted">{cycle === 'monthly' ? 'por mês' : `total ${CYCLE_LABEL[cycle].toLowerCase()}`}</span></p> : <p className="mt-4 text-sm text-muted">Ciclo indisponível neste plano.</p>}
                      {pr && cycle !== 'monthly' && <p className="text-xs text-muted">equivale a {brl(Math.round(pr.amount_cents / CYCLE_MONTHS[cycle]))}/mês</p>}
                      <p className="text-xs text-muted mt-1">Valor após o mês grátis.</p>
                      <ul className="mt-4 space-y-2 text-sm flex-1">{featureList(p).map((f) => <li key={f} className="flex gap-2"><Check className="w-4 h-4 mt-0.5 text-success shrink-0" aria-hidden />{f}</li>)}</ul>
                      <Button className="mt-6 w-full" onClick={() => trial(p.code)} disabled={!pr}>Testar grátis por 1 mês</Button>
                    </Card>
                  );
                })}
              </div>
            )}
            {custom && <p className="mt-6 text-sm"><strong>{custom.name}:</strong> {custom.description} <a href="#contato" className="underline">Fale com a gente</a>.</p>}
            <p className="mt-4 text-xs text-muted">Franquias de leitura de etiqueta e WhatsApp são mensais. Ao esgotar, a digitação manual continua; nada é cobrado a mais sem contratação.</p>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4 py-16" aria-labelledby="conf-h">
          <h2 id="conf-h" className="text-3xl font-semibold">Controle verificável</h2>
          <div className="mt-8 grid sm:grid-cols-3 gap-4">
            {[
              [ShieldCheck, 'Acesso por vínculo', 'Cada pessoa só vê o próprio condomínio e o que o papel dela permite. Revogação vale na hora.'],
              [History, 'Histórico de cada encomenda', 'Recebimento, movimentações, exceções e retirada com data do servidor e responsável.'],
              [FileCheck2, 'Comprovante de retirada', 'Protocolo, operador, quem retirou e assinatura desenhada (registro operacional, não assinatura digital certificada).'],
            ].map(([Icon, t, d]) => { const I = Icon as React.ElementType; return <Card key={t as string}><I className="w-6 h-6 text-secondary" aria-hidden /><h3 className="font-semibold mt-3">{t as string}</h3><p className="text-sm text-muted mt-1">{d as string}</p></Card>; })}
          </div>
        </section>

        <section id="duvidas" className="bg-surface border-y border-line" aria-labelledby="faq-h">
          <div className="max-w-3xl mx-auto px-4 py-16">
            <h2 id="faq-h" className="text-3xl font-semibold">Dúvidas frequentes</h2>
            <div className="mt-6 space-y-2">
              {[
                ['Como funciona o mês grátis?', 'Ao cadastrar o condomínio, o teste começa na hora e vai até o mesmo dia do mês seguinte (ou o último dia do mês, quando não existir). Não pedimos cartão. É um teste por condomínio.'],
                ['Como é a cobrança depois? Posso cancelar?', 'No fim do teste geramos um link de pagamento da InfinitePay (Pix ou cartão) para o ciclo escolhido. Não há débito automático. Cancelar interrompe as próximas cobranças e mantém o acesso até o fim do período liberado.'],
                ['Preciso comprar equipamento?', 'Não. Funciona no navegador de celular, tablet ou computador. Leitor de código de barras USB e câmera são opcionais.'],
                ['Precisa instalar alguma coisa?', 'Não. Opcionalmente dá para instalar como aplicativo na tela inicial, conforme o navegador.'],
                ['Como os moradores são avisados?', 'No próprio sistema sempre; por notificação no celular quando o morador permite e o aparelho suporta; por e-mail e WhatsApp quando configurados no plano. A entrega da mensagem depende do aparelho e do provedor.'],
                ['Uma unidade pode ter vários moradores?', 'Sim. Cada morador entra com o próprio convite e vê as encomendas da unidade.'],
                ['Posso trocar de plano?', 'Sim. Durante o teste a troca vale na hora; depois, vale no próximo ciclo, sem cobrança proporcional.'],
                ['E se a internet cair?', 'O sistema não confirma recebimentos ou retiradas sem falar com o servidor. Anote o urgente e registre quando a conexão voltar.'],
                ['Como funciona o suporte?', 'Pelo formulário desta página e pela central de ajuda dentro do sistema, com tutoriais guiados em cada tela.'],
              ].map(([q, a]) => <details key={q} className="rounded-xl border border-line bg-bg p-4"><summary className="cursor-pointer font-semibold min-h-6">{q}</summary><p className="mt-3 text-sm text-muted">{a}</p></details>)}
            </div>
          </div>
        </section>

        <section id="contato" className="max-w-6xl mx-auto px-4 py-16 grid lg:grid-cols-2 gap-10" aria-labelledby="cta-h">
          <div>
            <h2 id="cta-h" className="text-3xl font-semibold">Comece pelo mês grátis</h2>
            <p className="text-muted mt-2">Cadastre o condomínio, configure a marca e registre a primeira encomenda hoje.</p>
            <Button className="mt-6" onClick={() => trial()}>Testar grátis por 1 mês</Button>
          </div>
          <Card><h3 className="font-semibold mb-3">Prefere falar com a gente?</h3><ContactForm context="landing" /></Card>
        </section>
      </main>

      <footer className="bg-midnight text-porcelain/80">
        <div className="max-w-6xl mx-auto px-4 py-10 flex flex-wrap gap-6 justify-between items-center text-sm">
          <PortariaPrimeLogo onDark className="h-8 w-auto" />
          <nav aria-label="Rodapé" className="flex flex-wrap gap-4"><a href="/entrar" onClick={onLink} className="hover:text-porcelain">Entrar</a><a href="#contato" className="hover:text-porcelain">Contato</a><a href="/termos" onClick={onLink} className="hover:text-porcelain">Termos de uso</a><a href="/privacidade" onClick={onLink} className="hover:text-porcelain">Privacidade</a></nav>
          <p className="w-full text-xs text-porcelain/50 flex items-center gap-2"><Building2 className="w-4 h-4" aria-hidden />© Portaria Prime · CNPJ 59.760.458/0001-91 · Pagamentos por InfinitePay</p>
        </div>
      </footer>

      {zoom && (
        <div role="dialog" aria-modal="true" aria-label={zoom.title} className="fixed inset-0 z-50 bg-black/80 p-4 flex flex-col items-center justify-center" onClick={() => setZoom(null)} onKeyDown={(e) => e.key === 'Escape' && setZoom(null)}>
          <button autoFocus className="self-end text-white p-2 min-h-11" aria-label="Fechar">< X /></button>
          <img src={zoom.file} alt={`${zoom.title}: ${zoom.caption}`} className="max-h-[85vh] max-w-full rounded-xl" />
          <p className="text-white mt-3 text-sm">{zoom.title} — {zoom.caption}</p>
        </div>
      )}
    </div>
  );
}
