/**
 * Configuração do servidor. Variável obrigatória ausente = erro claro, sem
 * fallback para URL antiga nem valor inventado.
 */
export class ConfigError extends Error {}

export function env(name: string): string {
  const v = (process.env[name] || '').replace(/^["']|["']$/g, '').trim();
  if (!v) throw new ConfigError(`Variável de ambiente ${name} não configurada no servidor.`);
  return v;
}

export function optionalEnv(name: string): string | null {
  const v = (process.env[name] || '').replace(/^["']|["']$/g, '').trim();
  return v || null;
}

/** Primeiro nome configurado (nomes do projeto ou os da integração Supabase da Vercel). */
export function envAny(...names: string[]): string {
  for (const n of names) {
    const v = optionalEnv(n);
    if (v) return v;
  }
  throw new ConfigError(`Variável de ambiente ${names[0]} não configurada no servidor.`);
}

/** URL pública confiável do app (nunca derivada do Host da requisição). */
export function appUrl(): string {
  const u = new URL(env('APP_URL'));
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) {
    throw new ConfigError('APP_URL precisa usar https.');
  }
  return u.origin;
}
