import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { navigate } from '../lib/router';
import { saveProgress, Tour } from '../lib/tours';

/**
 * Tour sobre a interface real: destaca `[data-tour=alvo]`, rola até ele e posiciona o balão
 * sem cobrir o alvo. Muda de rota quando o passo é de outra área. Alvo ausente após a espera
 * (plano/permissão/sem dados) é pulado e informado. Esc fecha; setas navegam.
 */
interface Running { tour: Tour; index: number; base: string; user: string; tenant: string }
const Ctx = createContext<{ start: (tour: Tour, base: string, user: string, tenant: string) => void; running: boolean }>({ start: () => {}, running: false });
export const useTour = () => useContext(Ctx);

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [run, setRun] = useState<Running | null>(null);
  const start = useCallback((tour: Tour, base: string, user: string, tenant: string) => setRun({ tour, index: 0, base, user, tenant }), []);
  return <Ctx.Provider value={{ start, running: !!run }}>{children}{run && <Overlay run={run} setRun={setRun} />}</Ctx.Provider>;
}

function Overlay({ run, setRun }: { run: Running; setRun: (r: Running | null) => void }) {
  const step = run.tour.steps[run.index];
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [missing, setMissing] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const last = run.index === run.tour.steps.length - 1;

  const go = useCallback((index: number) => {
    if (index >= run.tour.steps.length) { saveProgress(run.user, run.tenant, run.tour.id, 'done'); setRun(null); return; }
    saveProgress(run.user, run.tenant, run.tour.id, index);
    setRun({ ...run, index: Math.max(0, index) });
  }, [run, setRun]);
  const close = useCallback(() => { saveProgress(run.user, run.tenant, run.tour.id, 'skipped'); setRun(null); }, [run, setRun]);

  // Leva à tela do passo e espera o alvo aparecer (carregamento assíncrono).
  useEffect(() => {
    setRect(null); setMissing(false);
    const want = `${run.base}/${step.area}`;
    if (!location.pathname.startsWith(want)) navigate(want);
    let tries = 0;
    const id = setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el && el.getClientRects().length) {
        clearInterval(id);
        el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        setTimeout(() => setRect(el.getBoundingClientRect()), 250);
      } else if (++tries > 40) { clearInterval(id); setMissing(true); }
    }, 100);
    return () => clearInterval(id);
  }, [run.base, step]);

  // Alvo inexistente (recurso fora do plano/permissão): avança sozinho e conta.
  useEffect(() => {
    if (!missing) return;
    setSkipped((n) => n + 1);
    const t = setTimeout(() => go(run.index + 1), 1200);
    return () => clearTimeout(t);
  }, [missing, go, run.index]);

  useLayoutEffect(() => {
    const upd = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el) setRect(el.getBoundingClientRect());
    };
    addEventListener('resize', upd); addEventListener('scroll', upd, true);
    return () => { removeEventListener('resize', upd); removeEventListener('scroll', upd, true); };
  }, [step.target]);

  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') go(run.index + 1);
      if (e.key === 'ArrowLeft' && run.index > 0) go(run.index - 1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [close, go, run.index]);

  // Balão abaixo do alvo; se não couber, acima; no celular ocupa a largura.
  const vw = innerWidth, vh = innerHeight, w = Math.min(360, vw - 32);
  let top = vh - 220, left = (vw - w) / 2;
  if (rect) {
    const below = rect.bottom + 12, above = rect.top - 12 - 200;
    top = below + 200 < vh ? below : above > 8 ? above : Math.max(8, vh - 216);
    left = Math.min(Math.max(16, rect.left), vw - w - 16);
  }

  return (
    <div className="fixed inset-0 z-[70] pointer-events-none" aria-live="polite">
      {rect && <div className="absolute rounded-xl ring-4 ring-accent shadow-[0_0_0_9999px_rgba(16,31,48,0.45)] transition-all"
        style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      <div ref={boxRef} tabIndex={-1} role="dialog" aria-modal="false" aria-label={`Tutorial: ${run.tour.title}`}
        className="absolute pointer-events-auto rounded-2xl border border-line bg-surface text-text p-4 shadow-xl focus:outline-none"
        style={{ top, left, width: w }}>
        <p className="text-xs text-muted">{run.tour.title} · passo {run.index + 1} de {run.tour.steps.length}</p>
        <div className="h-1 rounded-full bg-surface-2 mt-2 overflow-hidden"><div className="h-full bg-secondary" style={{ width: `${((run.index + 1) / run.tour.steps.length) * 100}%` }} /></div>
        <h2 className="font-semibold mt-3">{step.title}</h2>
        <p className="text-sm mt-1">{missing ? 'Este item não está disponível no seu plano, permissão ou ainda não tem dados. Pulando…' : rect ? step.body : 'Abrindo a tela…'}</p>
        {last && skipped > 0 && <p className="text-xs text-muted mt-2">{skipped} passo(s) pulado(s) por não se aplicarem.</p>}
        <div className="mt-4 flex flex-wrap gap-2 justify-between">
          <button className="min-h-11 px-3 text-sm text-muted underline" onClick={close}>Pular tutorial</button>
          <div className="flex gap-2">
            {run.index > 0 && <button className="min-h-11 px-3 rounded-xl border border-line text-sm font-semibold" onClick={() => go(run.index - 1)}>Anterior</button>}
            <button className="min-h-11 px-4 rounded-xl bg-primary text-primary-fg text-sm font-semibold" onClick={() => go(run.index + 1)}>{last ? 'Concluir' : 'Próximo'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
