// A ausência de clientes não torna produção um ambiente de testes.
// Política local: suítes mutáveis só podem usar uma stack Supabase de loopback.
export function assertLocalSupabase(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('SUPABASE_URL inválida.'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password) {
    throw new Error('E2E mutável bloqueado: use Supabase local isolado, nunca o projeto publicado.');
  }
}
