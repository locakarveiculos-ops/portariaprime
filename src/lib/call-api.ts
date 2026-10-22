// Lógica do cliente HTTP sem depender do singleton do Supabase (testável no Node).
export type AuthLike = {
  getSession: () => Promise<{ data: { session: { access_token: string } | null } }>;
  refreshSession: () => Promise<{ data: { session: { access_token: string } | null }; error: unknown }>;
  signOut: (o: { scope: 'local' }) => Promise<unknown>;
};

/** Mensagem amigável a partir de erro do Postgres/PostgREST/rede. */
export function friendly(e: unknown): string {
  const m = (e as any)?.message || String(e || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
  if (/JWT|jwt expired|invalid claim/i.test(m)) return 'Sua sessão expirou. Entre novamente.';
  if (/permission denied/i.test(m)) return 'Você não tem permissão para esta ação.';
  return m.replace(/^.*?ERROR:\s*/, '') || 'Algo deu errado. Tente novamente.';
}

export async function callApi<T = any>(auth: AuthLike, path: string, body?: unknown, method = 'POST'): Promise<T> {
  const send = async (token?: string) => {
    try {
      return await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(friendly(e));
    }
  };
  const { data } = await auth.getSession();
  let res = await send(data.session?.access_token);
  // O servidor valida a sessão no Auth; um token ainda aceito pelo banco pode já ter sido
  // encerrado lá (ex.: logout em outro aparelho). Renova uma vez; se acabou, volta ao login.
  if (res.status === 401 && data.session) {
    const { data: fresh, error } = await auth.refreshSession();
    if (error || !fresh.session) {
      await auth.signOut({ scope: 'local' });
      throw new Error('Sua sessão foi encerrada (por exemplo, ao sair em outro aparelho). Entre novamente.');
    }
    res = await send(fresh.session.access_token);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(json.error || `Falha (${res.status}).`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}
