import { useEffect, useState } from 'react';

// ponytail: roteador mínimo por pathname (poucas rotas, sem dependência nova).
// Trocar por react-router se surgirem rotas aninhadas/loaders.
export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search + location.hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

/** Pathname atual; também re-renderiza quando só a query muda (?m=, ?aba=). */
export function usePath() {
  const [, setUrl] = useState(() => location.pathname + location.search);
  useEffect(() => {
    const on = () => setUrl(location.pathname + location.search);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return location.pathname;
}

export function query(name: string) {
  return new URLSearchParams(location.search).get(name);
}

/** /c/:slug/:area? */
export function matchTenant(path: string) {
  const m = path.match(/^\/c\/([a-z0-9-]+)(?:\/([a-z-]+))?\/?$/);
  return m ? { slug: m[1], area: m[2] || '' } : null;
}

/** Link interno sem recarregar a página. */
export function onLink(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  const href = e.currentTarget.getAttribute('href');
  if (href?.startsWith('/')) {
    e.preventDefault();
    navigate(href);
  }
}
