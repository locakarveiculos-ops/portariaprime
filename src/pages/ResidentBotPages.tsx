import React, { useEffect, useState } from 'react';
import { PortariaPrimeLogo } from '../components/Brand';
import { QRCodeDisplay } from '../components/VisualCodes';
import { Alert, Button, Card, Field, Input, Spinner } from '../components/ui';
import { onLink, query } from '../lib/router';

type QrPayload = { token?: string; expires_at?: string; carrier?: string; unit?: string; tenant_name?: string; invalid?: boolean; used?: boolean; unavailable?: boolean; error?: string };
type TermPayload = { title: string; content: string; version: string; hash: string; error?: string };
type PasswordPayload = { ok?: boolean; valid?: boolean; slug?: string; tenant_name?: string; expires_at?: string; invalid?: boolean; used?: boolean; expired?: boolean; unavailable?: boolean; error?: string };

const CODE = /^[0-9a-f]{40}$/;
const TOKEN = /^[0-9a-f]{64}$/;

function PageShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg text-text px-4 py-8">
      <div className="max-w-lg mx-auto space-y-5">
        <PortariaPrimeLogo />
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; data: T }> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, data };
}

export function ResidentQrPage() {
  const code = (query('c') || '').trim();
  const validCode = CODE.test(code);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QrPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openQr = async () => {
    if (!validCode || busy) return;
    setBusy(true); setError(null);
    try {
      const { ok, data } = await postJson<QrPayload>('/api/portal/qr', { c: code });
      if (!ok) setError(data.error || 'Não foi possível abrir o QR.');
      else setResult(data);
    } catch {
      setError('Falha de conexão. Tente novamente ou peça outro link no WhatsApp.');
    } finally { setBusy(false); }
  };

  return (
    <PageShell title="QR de retirada" subtitle={result?.tenant_name || 'Mostre este código apenas ao porteiro no momento da retirada.'}>
      <Card className="space-y-4">
        {!validCode && <Alert tone="danger">Link inválido. Peça um novo QR pelo WhatsApp ou abra o aplicativo do condomínio.</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        {validCode && !result && (
          <>
            <p className="text-sm text-muted">Este link vale para uma única abertura. Toque abaixo somente quando estiver pronto para mostrar o QR na portaria.</p>
            <Button className="w-full" loading={busy} onClick={openQr}>Mostrar QR agora</Button>
          </>
        )}
        {result?.invalid && <Alert tone="danger">Link inválido. Peça um novo QR pelo WhatsApp.</Alert>}
        {result?.used && <Alert tone="warning">Este link já foi aberto. Peça um novo QR pelo WhatsApp ou use o aplicativo.</Alert>}
        {result?.unavailable && <Alert tone="warning">Esta encomenda não está mais aguardando retirada ou o código expirou. Peça um novo QR pelo WhatsApp.</Alert>}
        {result?.token && (
          <div className="space-y-4 text-center">
            <div className="bg-white p-4 rounded-2xl inline-block mx-auto"><QRCodeDisplay value={result.token} size={240} /></div>
            <div className="text-sm space-y-1">
              {result.unit && <p className="font-semibold">Unidade: {result.unit}</p>}
              {result.carrier && <p className="text-muted">Remetente/transportadora: {result.carrier}</p>}
              {result.expires_at && <p className="text-xs text-muted">Válido até {new Date(result.expires_at).toLocaleString('pt-BR')}.</p>}
            </div>
            <Alert tone="info">Se fechar esta página, peça outro link pelo WhatsApp.</Alert>
          </div>
        )}
      </Card>
    </PageShell>
  );
}

export function ResidentTermPage({ slug }: { slug: string }) {
  const [term, setTerm] = useState<TermPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    fetch(`/api/portal/term?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' })
      .then(async (r) => ({ ok: r.ok, data: (await r.json().catch(() => ({}))) as TermPayload }))
      .then(({ ok, data }) => { if (active) { if (ok && data.content) setTerm(data); else setError(data.error || 'Termo indisponível.'); } })
      .catch(() => { if (active) setError('Não foi possível carregar o termo.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [slug]);

  return (
    <PageShell title={term?.title || 'Termo de tratamento de dados'} subtitle={term ? `Versão ${term.version}` : undefined}>
      {loading && <Spinner />}
      {error && <Alert tone="danger">{error}</Alert>}
      {term && (
        <Card className="space-y-4">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{term.content}</div>
          <p className="text-xs text-muted">Código de verificação do texto: {term.hash}</p>
        </Card>
      )}
      <a className="inline-block text-sm underline" href={`/c/${slug}`} onClick={onLink}>Voltar ao portal do condomínio</a>
    </PageShell>
  );
}

export function ResidentPasswordPage({ slug }: { slug: string }) {
  const [token] = useState(() => location.hash.replace(/^#/, '').trim());
  const validToken = TOKEN.test(token);
  const [state, setState] = useState<PasswordPayload | null>(validToken ? null : { invalid: true });
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Strip the fragment from the address bar and keep the capability only in component memory.
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (!validToken) return;
    let active = true;
    postJson<PasswordPayload>('/api/portal/password-peek', { token, slug })
      .then(({ ok, data }) => { if (active) { if (ok) setState(data); else setError(data.error || 'Não foi possível validar o link.'); } })
      .catch(() => { if (active) setError('Falha de conexão. Tente novamente.'); });
    return () => { active = false; };
  }, [slug, token, validToken]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validToken || busy) return;
    if (password.length < 6 || password.length > 128) { setError('A senha deve ter entre 6 e 128 caracteres.'); return; }
    if (password !== confirmation) { setError('As senhas não conferem.'); return; }
    setBusy(true); setError(null);
    try {
      const { ok, data } = await postJson<PasswordPayload>('/api/portal/password-set', { token, slug, password });
      if (!ok) setError(data.error || 'Não foi possível salvar a senha.');
      else if (data.ok) setDone(true);
      else setState(data);
    } catch {
      setError('Falha de conexão. Se a senha já tiver sido salva, tente entrar ou use recuperar senha.');
    } finally { setBusy(false); }
  };

  const loginHref = `/entrar?portal=${encodeURIComponent(slug)}&next=${encodeURIComponent(`/c/${slug}/inicio`)}`;
  const recoverHref = `/recuperar-senha?portal=${encodeURIComponent(slug)}`;

  return (
    <PageShell title="Criar senha de acesso" subtitle={state?.tenant_name}>
      <Card className="space-y-4">
        {!state && !error && <Spinner />}
        {error && <Alert tone="danger">{error}</Alert>}
        {done && (
          <div className="space-y-3">
            <Alert tone="success">Senha criada com sucesso. Você já pode entrar no aplicativo do condomínio.</Alert>
            <a className="block text-center font-semibold underline" href={loginHref} onClick={onLink}>Entrar no aplicativo</a>
          </div>
        )}
        {!done && state?.invalid && <Alert tone="danger">Link inválido ou de outro condomínio.</Alert>}
        {!done && state?.used && <Alert tone="warning">Este link já foi utilizado. Se precisa trocar a senha, use a recuperação de senha.</Alert>}
        {!done && state?.expired && <Alert tone="warning">Este link expirou. Use a opção recuperar senha para receber um novo acesso.</Alert>}
        {!done && state?.unavailable && <Alert tone="warning">Seu cadastro não está ativo para criar senha por este link.</Alert>}
        {!done && state?.valid && (
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Nova senha" hint="Mínimo de 6 e máximo de 128 caracteres.">
              <Input type="password" value={password} minLength={6} maxLength={128} autoComplete="new-password" required onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirmar nova senha">
              <Input type="password" value={confirmation} minLength={6} maxLength={128} autoComplete="new-password" required onChange={(e) => setConfirmation(e.target.value)} />
            </Field>
            <Button type="submit" className="w-full" loading={busy}>Salvar senha</Button>
          </form>
        )}
        <div className="text-xs text-muted flex flex-wrap gap-3 pt-1">
          <a className="underline" href={loginHref} onClick={onLink}>Ir para o login</a>
          <a className="underline" href={recoverHref} onClick={onLink}>Recuperar senha pelo app</a>
        </div>
      </Card>
    </PageShell>
  );
}
