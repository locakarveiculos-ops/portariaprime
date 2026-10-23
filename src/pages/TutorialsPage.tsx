import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Search } from 'lucide-react';
import { PortariaPrimeLogo } from '../components/Brand';
import { Input } from '../components/ui';
import { onLink } from '../lib/router';
import { SCREENS, srcSet } from '../lib/screens';
import { Profile, PROFILES, searchTutorials, Tutorial, TUTORIALS } from '../lib/tutorials';

/** Progresso local por tutorial (só conveniência deste navegador). */
const KEY = 'pp_tutorials_done';
const loadDone = (): string[] => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="border-b border-line bg-surface">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <a href="/" onClick={onLink} aria-label="Portaria Prime, início"><PortariaPrimeLogo className="h-8 w-auto" /></a>
          <nav aria-label="Tutoriais" className="flex gap-1 text-sm overflow-x-auto">
            {(Object.keys(PROFILES) as Profile[]).map((p) => <a key={p} href={`/tutoriais/${p}`} onClick={onLink} className="px-3 min-h-11 inline-flex items-center rounded-lg hover:bg-surface-2 whitespace-nowrap">{PROFILES[p].title.split(' ')[0]}</a>)}
          </nav>
        </div>
      </header>
      <main id="conteudo" className="max-w-5xl mx-auto px-4 py-8">{children}</main>
      <footer className="border-t border-line text-xs text-muted text-center py-6">Tutoriais v1 · revisados em 23/10/2026 · imagens com dados fictícios</footer>
    </div>
  );
}

/** /tutoriais e /tutoriais/{perfil}[#tutorial] */
export default function TutorialsPage({ profile }: { profile: string | null }) {
  const [q, setQ] = useState('');
  const [done, setDone] = useState<string[]>(loadDone);
  const valid = profile && profile in PROFILES ? (profile as Profile) : null;
  useEffect(() => { document.title = valid ? `Tutorial ${PROFILES[valid].title} · Portaria Prime` : 'Tutoriais · Portaria Prime'; }, [valid]);
  useEffect(() => { if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView(); }, [valid]);
  const list = useMemo(() => searchTutorials(q, valid ? TUTORIALS.filter((t) => t.profile === valid) : TUTORIALS), [q, valid]);
  const toggle = (slug: string) => setDone((d) => {
    const n = d.includes(slug) ? d.filter((x) => x !== slug) : [...d, slug];
    try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* ok */ }
    return n;
  });

  if (!valid) return (
    <Shell>
      <h1 className="text-3xl font-semibold">Tutoriais do Portaria Prime</h1>
      <p className="text-muted mt-2 max-w-2xl">Passo a passo completo para cada perfil, com imagens do sistema real (dados fictícios). Use a busca para ir direto à tarefa.</p>
      <SearchBox q={q} setQ={setQ} />
      {q ? <Results list={list} /> : (
        <div className="grid md:grid-cols-3 gap-4 mt-6">
          {(Object.keys(PROFILES) as Profile[]).map((p) => {
            const items = TUTORIALS.filter((t) => t.profile === p);
            return (
              <a key={p} href={`/tutoriais/${p}`} onClick={onLink} className="rounded-2xl border border-line bg-surface p-5 hover:bg-surface-2 flex flex-col gap-2">
                <span className="text-lg font-semibold">{PROFILES[p].title}</span>
                <span className="text-sm text-muted">{PROFILES[p].intro}</span>
                <span className="text-sm mt-auto pt-2">{items.length} tutoriais · {items.filter((t) => done.includes(t.slug)).length} concluídos</span>
              </a>
            );
          })}
        </div>
      )}
    </Shell>
  );

  const items = TUTORIALS.filter((t) => t.profile === valid);
  return (
    <Shell>
      <a href="/tutoriais" onClick={onLink} className="text-sm text-muted inline-flex items-center gap-1 min-h-11"><ArrowLeft className="w-4 h-4" aria-hidden /> Todos os perfis</a>
      <h1 className="text-3xl font-semibold mt-1">{PROFILES[valid].title}</h1>
      <p className="text-muted mt-2">{PROFILES[valid].intro}</p>
      <p className="text-sm mt-2" role="status">Progresso neste navegador: {items.filter((t) => done.includes(t.slug)).length} de {items.length}</p>
      <SearchBox q={q} setQ={setQ} />
      <div className="lg:grid lg:grid-cols-[220px_1fr] gap-8 mt-6">
        <nav aria-label="Índice" className="hidden lg:block sticky top-6 self-start">
          <ol className="space-y-1 text-sm">
            {items.map((t, i) => <li key={t.slug}><a href={`#${t.slug}`} className="flex gap-2 min-h-9 items-center hover:underline">{done.includes(t.slug) ? <Check className="w-4 h-4 text-success" aria-label="concluído" /> : <span className="w-4 text-muted">{i + 1}.</span>}{t.title}</a></li>)}
          </ol>
        </nav>
        <div className="space-y-10">{list.map((t) => <TutorialView key={t.slug} t={t} done={done.includes(t.slug)} onToggle={() => toggle(t.slug)} />)}
          {list.length === 0 && <p className="text-muted">Nada encontrado. Tente outra palavra.</p>}</div>
      </div>
    </Shell>
  );
}

function SearchBox({ q, setQ }: { q: string; setQ: (v: string) => void }) {
  return (
    <div className="relative mt-5 max-w-xl">
      <Search className="w-5 h-5 text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
      <Input type="search" aria-label="Buscar tarefa" placeholder="Busque uma tarefa: QR, aprovar morador, etiqueta…" className="pl-10 h-12 text-base" value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
  );
}

function Results({ list }: { list: Tutorial[] }) {
  return list.length === 0 ? <p className="mt-6 text-muted">Nada encontrado. Tente outra palavra.</p> : (
    <ul className="mt-6 space-y-2">
      {list.map((t) => <li key={t.slug}><a href={`/tutoriais/${t.profile}#${t.slug}`} onClick={onLink} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 hover:bg-surface-2">
        <span><span className="font-medium block">{t.title}</span><span className="text-xs text-muted">{PROFILES[t.profile].title}</span></span><ChevronRight className="w-4 h-4" aria-hidden /></a></li>)}
    </ul>
  );
}

function TutorialView({ t, done, onToggle }: { t: Tutorial; done: boolean; onToggle: () => void }) {
  const next = t.next && TUTORIALS.find((x) => x.slug === t.next);
  return (
    <article id={t.slug} aria-labelledby={`${t.slug}-t`} className="scroll-mt-6 rounded-2xl border border-line bg-surface p-5 sm:p-6 space-y-4">
      <h2 id={`${t.slug}-t`} className="text-xl font-semibold">{t.title}</h2>
      <p><strong>Objetivo:</strong> {t.goal}</p>
      {t.before.length > 0 && <div><p className="font-semibold">Antes de começar</p><ul className="list-disc pl-5 text-sm">{t.before.map((b) => <li key={b}>{b}</li>)}</ul></div>}
      <ol className="space-y-5">
        {t.steps.map((s, i) => {
          const shot = s.screen ? SCREENS[s.screen] : null;
          return (
            <li key={s.title} className="grid gap-3">
              <p><span className="inline-grid place-items-center w-7 h-7 rounded-full bg-primary text-primary-fg text-sm font-semibold mr-2" aria-hidden>{i + 1}</span><strong>{s.title}.</strong> {s.text}</p>
              {shot && <figure><img src={shot.file} srcSet={srcSet(shot)} sizes="(min-width: 1024px) 700px, 100vw" alt={`${shot.title}: ${shot.caption}`} width={shot.width} height={shot.height} loading="lazy" className="w-full h-auto rounded-xl border border-line" />
                <figcaption className="text-xs text-muted mt-1">{shot.caption} Dados fictícios.</figcaption></figure>}
            </li>
          );
        })}
      </ol>
      <p><strong>Resultado esperado:</strong> {t.result}</p>
      {t.undo && <p><strong>Como desfazer:</strong> {t.undo}</p>}
      {t.errors.length > 0 && <div><p className="font-semibold">Erros comuns</p><dl className="space-y-1 text-sm">{t.errors.map(([e, s]) => <div key={e}><dt className="font-medium">{e}</dt><dd className="text-muted">{s}</dd></div>)}</dl></div>}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line">
        <label className="inline-flex items-center gap-2 min-h-11 text-sm"><input type="checkbox" checked={done} onChange={onToggle} className="h-5 w-5" /> Marcar como concluído</label>
        {next && <a href={`#${next.slug}`} className="inline-flex items-center gap-1 text-sm font-semibold min-h-11">Próximo: {next.title} <ChevronRight className="w-4 h-4" aria-hidden /></a>}
      </div>
    </article>
  );
}
