import { useSyncExternalStore } from 'react';

// Contador de capturas abertas (assinatura, foto). Enquanto > 0, a atualização
// do app não pode recarregar a página e descartar a prova em coleta.
let busy = 0;
const subs = new Set<() => void>();
export function setCaptureBusy(on: boolean) {
  busy = Math.max(0, busy + (on ? 1 : -1));
  subs.forEach((f) => f());
}
export const useCaptureBusy = () =>
  useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => busy > 0);
