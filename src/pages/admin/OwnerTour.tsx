import React, { useEffect, useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { OWNER_TOUR, PlatformSection } from '../../lib/platform-help';

export default function OwnerTour({ userId, onNavigate }: { userId: string; onNavigate: (section: PlatformSection) => void }) {
  const key = `platform-tour:v1:${userId}`;
  const [saved, setSaved] = useState(() => { try { const n = Number(localStorage.getItem(key)); return Number.isInteger(n) && n >= 0 && n <= OWNER_TOUR.length ? n : 0; } catch { return 0; } });
  const [step, setStep] = useState<number | null>(null);
  const save = (n: number) => { setSaved(n); try { localStorage.setItem(key, String(n)); } catch { /* Progresso opcional; navegação funciona sem armazenamento. */ } };
  const move = (n: number) => { if (n >= OWNER_TOUR.length) { save(OWNER_TOUR.length); setStep(null); } else { save(n); setStep(n); } };
  useEffect(() => {
    if (step === null) return;
    onNavigate(OWNER_TOUR[step].section);
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(`[data-tour="${OWNER_TOUR[step].target}"]`);
      element?.scrollIntoView({ block: 'center', behavior: 'instant' });
      element?.classList.add('ring-2', 'ring-accent');
    });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); move(step + 1); }
      if (event.key === 'ArrowLeft' && step > 0) { event.preventDefault(); move(step - 1); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keyboard);
      document.querySelectorAll('[data-tour]').forEach(element => element.classList.remove('ring-2', 'ring-accent'));
    };
  }, [step, onNavigate]);
  return <>
    <div className="flex flex-wrap items-center gap-2"><Button variant="secondary" onClick={() => move(saved < OWNER_TOUR.length ? saved : 0)}>{saved > 0 && saved < OWNER_TOUR.length ? 'Continuar tour opcional' : 'Iniciar tour opcional'}</Button>{saved > 0 && <Button variant="ghost" onClick={() => move(0)}>Reiniciar tour</Button>}<span className="text-xs text-muted">{saved === OWNER_TOUR.length ? 'Tour concluído neste navegador.' : 'Nenhuma ação será executada.'}</span></div>
    {step !== null && <Modal title={`${step + 1}/${OWNER_TOUR.length} · ${OWNER_TOUR[step].title}`} onClose={() => setStep(null)}>
      <div className="space-y-4"><p>{OWNER_TOUR[step].text}</p><p className="text-sm text-muted">O controle destacado pertence à tela real. Escape fecha; setas navegam. Feche para interagir por conta própria.</p><div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={step === 0} onClick={() => move(step - 1)}>Anterior</Button><Button onClick={() => move(step + 1)}>{step === OWNER_TOUR.length - 1 ? 'Concluir' : 'Próximo'}</Button><Button variant="ghost" onClick={() => setStep(null)}>Sair do tour</Button></div></div>
    </Modal>}
  </>;
}
