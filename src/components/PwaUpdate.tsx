import { useRegisterSW } from 'virtual:pwa-register/react';
import { useCaptureBusy } from '../lib/capture';

/** Atualização explícita: nunca descarta um formulário; bloqueada durante assinatura/foto. */
export function PwaUpdate() {
  const { needRefresh: [waiting], updateServiceWorker } = useRegisterSW({ immediate: true });
  const capturing = useCaptureBusy();
  if (!waiting) return null;
  return (
    <aside role="status" aria-label="Atualização disponível" className="fixed inset-x-4 bottom-4 z-[70] mx-auto max-w-lg rounded-xl border border-line bg-surface p-4 shadow-lg">
      <p className="font-semibold">Nova versão disponível</p>
      <p className="mt-1 text-sm text-muted">
        {capturing ? 'Conclua a entrega em andamento (assinatura e foto) para atualizar.' : 'Conclua o que estiver preenchendo antes de atualizar. A página será recarregada.'}
      </p>
      <button type="button" disabled={capturing} className="mt-3 min-h-11 rounded-lg bg-primary px-4 text-primary-fg disabled:opacity-50" onClick={() => void updateServiceWorker(true)}>
        Atualizar aplicativo
      </button>
    </aside>
  );
}
