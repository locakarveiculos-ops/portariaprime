import React, { useEffect, useMemo, useState } from 'react';
import { Link2, PlayCircle, RotateCcw } from 'lucide-react';
import { Alert, Button, Card, Input } from '../components/ui';
import { useTenant } from '../lib/tenant';
import { useSession } from '../lib/session';
import { usePwaInstall } from '../hooks/usePwaInstall';
import { navigate, query } from '../lib/router';
import { ARTICLES, Article, articlesFor, CATEGORIES, searchArticles } from '../lib/help';
import { loadProgress, resetProgress, TOURS, toursFor } from '../lib/tours';
import { SCREENS } from '../lib/screens';
import { useTour } from '../components/TourGuide';
import { ContactForm } from '../components/ContactForm';

export default function HelpPage() {
  const t = useTenant();
  const { ctx } = useSession();
  const { start } = useTour();
  const role = t.link.role;
  const base = `/c/${t.tenant.slug}`;
  const [q, setQ] = useState('');
  const [slug, setSlug] = useState(query('artigo'));
  const [progress, setProgress] = useState(() => loadProgress(ctx!.user_id, t.tenant.id));
  useEffect(() => {
    const on = () => setSlug(query('artigo'));
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);

  const mine = useMemo(() => articlesFor(role), [role]);
  const found = useMemo(() => searchArticles(mine, q), [mine, q]);
  const tours = toursFor(role, (p) => t.can(p as any));
  const article = mine.find((a) => a.slug === slug);
  const open = (s: string | null) => navigate(`${base}/ajuda${s ? `?artigo=${s}` : ''}`);
  const runTour = (id: string) => { const tour = TOURS.find((x) => x.id === id); if (tour) start(tour, base, ctx!.user_id, t.tenant.id); };

  if (article) return <ArticleView a={article} onOpen={open} onTour={runTour} canTour={!!article.tour && tours.some((x) => x.id === article.tour)} />;

  return (
    <section className="space-y-5">
      <div><h1 className="text-2xl font-semibold">Central de ajuda</h1><p className="text-muted text-sm mt-1">Passo a passo de cada tarefa, com tutorial dentro da tela real.</p></div>
      <Input aria-label="Pesquisar na ajuda" placeholder="Pesquise: pacote, apartamento, QR, pagamento…" value={q} onChange={(e) => setQ(e.target.value)} />

      {!q && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Tutoriais guiados</h2>
            <button className="text-sm text-muted underline inline-flex items-center gap-1 min-h-11" onClick={() => { resetProgress(ctx!.user_id, t.tenant.id); setProgress({}); }}><RotateCcw className="w-4 h-4" /> Recomeçar todos</button>
          </div>
          <ul className="grid sm:grid-cols-2 gap-2">
            {tours.map((tour) => {
              const p = progress[tour.id];
              return (
                <li key={tour.id} className="rounded-xl border border-line p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-medium">{tour.title}</p><p className="text-xs text-muted">{tour.goal} · {tour.steps.length} passos{p === 'done' ? ' · concluído' : typeof p === 'number' ? ` · parou no passo ${p + 1}` : ''}</p></div>
                  <Button variant="secondary" onClick={() => runTour(tour.id)} aria-label={`${p === 'done' ? 'Rever' : 'Iniciar'} tutorial ${tour.title}`}><PlayCircle className="w-4 h-4" />{p === 'done' ? 'Rever' : 'Iniciar'}</Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {q && <p className="text-sm text-muted" role="status">{found.length} resultado(s) para “{q}”.</p>}
      {q && found.length === 0 && <Alert>Nada encontrado. Tente outra palavra, como “encomenda”, “unidade” ou “retirada”, ou fale com o suporte no fim da página.</Alert>}

      {CATEGORIES.map((c) => {
        const items = found.filter((a) => a.category === c);
        if (!items.length) return null;
        return (
          <div key={c} className="space-y-2">
            <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{c}</h2>
            <ul className="grid sm:grid-cols-2 gap-2">
              {items.map((a) => <li key={a.slug}><a href={`${base}/ajuda?artigo=${a.slug}`} onClick={(e) => { e.preventDefault(); open(a.slug); }} className="block rounded-xl border border-line bg-surface p-3 hover:bg-surface-2 min-h-11"><span className="font-medium">{a.title}</span><span className="block text-xs text-muted">{a.forWho}</span></a></li>)}
            </ul>
          </div>
        );
      })}

      <InstallCard />
      <Card className="space-y-3"><h2 className="font-semibold">Falar com a Portaria Prime</h2><ContactForm context={`ajuda:${t.tenant.slug}`} /></Card>
    </section>
  );
}

function ArticleView({ a, onOpen, onTour, canTour }: { a: Article; onOpen: (s: string | null) => void; onTour: (id: string) => void; canTour: boolean }) {
  const shot = a.screen ? SCREENS[a.screen] : null;
  const [copied, setCopied] = useState(false);
  const related = a.next.map((s) => ARTICLES.find((x) => x.slug === s)).filter(Boolean) as Article[];
  return (
    <article className="space-y-4 max-w-3xl">
      <nav aria-label="Trilha" className="text-sm text-muted"><button className="underline min-h-11" onClick={() => onOpen(null)}>Ajuda</button> › {a.category}</nav>
      <h1 className="text-2xl font-semibold">{a.title}</h1>
      <div className="flex flex-wrap gap-2">
        {canTour && <Button onClick={() => onTour(a.tour!)}><PlayCircle className="w-4 h-4" /> Fazer o tutorial nesta tela</Button>}
        <Button variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); } catch { /* sem clipboard */ } }}><Link2 className="w-4 h-4" />{copied ? 'Link copiado' : 'Copiar link'}</Button>
      </div>
      <Card className="space-y-4 text-sm leading-relaxed">
        <p><strong>Para quem:</strong> {a.forWho}</p>
        <p><strong>Quando usar:</strong> {a.when}</p>
        {a.before.length > 0 && <div><p className="font-semibold">Antes de começar</p><ul className="list-disc pl-5">{a.before.map((b) => <li key={b}>{b}</li>)}</ul></div>}
        <div><p className="font-semibold">Passo a passo</p><ol className="list-decimal pl-5 space-y-1">{a.steps.map((s) => <li key={s}>{s}</li>)}</ol></div>
        {shot && <figure><img src={shot.file} alt={`${shot.title}: ${shot.caption}`} width={shot.width} height={shot.height} loading="lazy" className="w-full h-auto rounded-xl border border-line" /><figcaption className="text-xs text-muted mt-1">Tela real com dados de demonstração.</figcaption></figure>}
        <p><strong>Resultado esperado:</strong> {a.result}</p>
        <p><strong>Como confirmar que salvou:</strong> {a.confirm}</p>
        {a.problems.length > 0 && <div><p className="font-semibold">Problemas comuns</p><dl className="space-y-2">{a.problems.map(([p, s]) => <div key={p}><dt className="font-medium">{p}</dt><dd className="text-muted">{s}</dd></div>)}</dl></div>}
      </Card>
      {related.length > 0 && <div><p className="font-semibold mb-2">Próximos passos</p><ul className="space-y-1">{related.map((r) => <li key={r.slug}><button className="underline text-secondary min-h-11 text-left" onClick={() => onOpen(r.slug)}>{r.title}</button></li>)}</ul></div>}
      <p className="text-xs text-muted">Revisado em 21/10/2026 · versão 1.</p>
    </article>
  );
}

function InstallCard() {
  const { isInstalled, isInstallable, promptInstall } = usePwaInstall();
  return (
    <Card><h2 className="font-semibold">Instalar no dispositivo</h2>
      {isInstalled ? <p className="text-sm">Aplicativo instalado neste dispositivo.</p> : isInstallable ? <Button variant="secondary" className="mt-2" onClick={promptInstall}>Instalar aplicativo</Button> : <p className="text-sm text-muted">No iPhone: Safari › Compartilhar › Adicionar à Tela de Início. Em outros navegadores, procure “Instalar” no menu. Requer HTTPS e navegador compatível.</p>}
    </Card>
  );
}
