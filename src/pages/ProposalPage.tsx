import React, { useEffect, useState } from 'react';
import { rpc } from '../lib/api';
import { brl, CYCLE_LABEL, dateOnly, dateTime } from '../lib/format';
import { navigate } from '../lib/router';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';

type View = {
  protocol: string; quote_protocol: string; version: number; status: 'sent' | 'accepted' | 'expired' | 'withdrawn';
  org_name: string; units: number; condos_count: number; plan_name: string; is_custom: boolean; cycle: string;
  amount_cents: number; limits: Record<string, number | boolean>; valid_until: string; conditions: string;
  accepted_at: string | null; content_sha256: string;
};

/** Token vem do fragmento (#), que o navegador não envia ao servidor nem no Referer. */
const readToken = () => {
  const t = decodeURIComponent(location.hash.replace(/^#/, ''));
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
};

/** Página pública /proposta#<token>: condições congeladas da proposta enviada. */
export default function ProposalPage() {
  const [token] = useState(readToken);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) { setError('Link de proposta inválido. Confira o endereço recebido por e-mail.'); return; }
    rpc<View>('proposal_view', { p_token: token }).then(setView).catch(e => setError(e.message || 'Proposta não encontrada.'));
  }, [token]);

  const accept = async () => {
    if (!token) return;
    setBusy(true); setError('');
    try {
      await rpc('proposal_accept', { p_token: token });
      navigate(`/contratar?proposta=${encodeURIComponent(token)}`);
    } catch (e: any) {
      setError(e.message || 'Não foi possível aceitar agora. Tente novamente.');
    } finally { setBusy(false); }
  };

  const L = view?.limits || {};
  const rows: [string, React.ReactNode][] = view ? [
    ['Para', view.org_name],
    ['Plano', view.plan_name],
    ['Preço', <><strong>{brl(view.amount_cents)}</strong> por ciclo {(CYCLE_LABEL[view.cycle] || view.cycle).toLowerCase()}</>],
    ['Validade', `até ${dateOnly(view.valid_until, 'America/Sao_Paulo')}`],
    ['Unidades', String(L.max_units ?? '—')],
    ['Portarias', String(L.max_concierges ?? '—')],
    ['Leituras de etiqueta (OCR) por mês', L.feature_ocr ? String(L.ocr_monthly) : 'Não incluso'],
    ['Mensagens de WhatsApp por mês', L.feature_whatsapp ? String(L.whatsapp_monthly) : 'Não incluso'],
    ['Totem de autoatendimento', L.feature_totem ? 'Incluso' : 'Não incluso'],
  ] : [];
  const tone = { sent: 'accent', accepted: 'success', expired: 'warning', withdrawn: 'danger' } as const;
  const label = { sent: 'Aguardando aceite', accepted: 'Aceita', expired: 'Vencida', withdrawn: 'Retirada' };

  return (
    <main className="min-h-screen bg-bg px-4 py-8">
      <div className="max-w-2xl mx-auto space-y-4">
        <PortariaPrimeLogo />
        <h1 className="text-2xl font-bold text-text">Proposta comercial</h1>
        {error && <Alert tone="danger">{error}</Alert>}
        {!view && !error && <Spinner label="Carregando proposta…" />}
        {view && (
          <Card className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted">Protocolo {view.protocol} · versão {view.version}</p>
              <Badge tone={tone[view.status]}>{label[view.status]}</Badge>
            </div>
            <dl className="divide-y divide-line">
              {rows.map(([k, v]) => (
                <div key={k} className="flex flex-col sm:flex-row sm:justify-between gap-1 py-2">
                  <dt className="text-sm text-muted">{k}</dt><dd className="text-sm text-text sm:text-right">{v}</dd>
                </div>
              ))}
            </dl>
            <section aria-labelledby="cond">
              <h2 id="cond" className="font-semibold text-text">Condições</h2>
              <p className="mt-1 whitespace-pre-line text-sm text-text">{view.conditions}</p>
            </section>
            <p className="text-xs text-muted">
              Franquia: cada mensagem aceita pelo provedor por destinatário consome 1 unidade; falhas e duplicatas não consomem; o contador reinicia todo mês.
            </p>
            <p className="text-xs text-muted">Proposta sujeita às condições descritas. Código de integridade: <code className="break-all">{view.content_sha256}</code></p>
            {view.status === 'sent' && <Button onClick={accept} loading={busy}>Aceitar e seguir para contratação</Button>}
            {view.status === 'accepted' && (
              <Alert tone="success">
                Proposta aceita em {dateTime(view.accepted_at, 'America/Sao_Paulo')}.{' '}
                <a className="underline" href={`/contratar?proposta=${token}`}>Continuar contratação</a>
              </Alert>
            )}
            {view.status === 'expired' && <Alert tone="warning">Esta proposta venceu. Responda o e-mail recebido para solicitar uma nova.</Alert>}
            {view.status === 'withdrawn' && <Alert tone="warning">Esta proposta foi retirada. Fale com a equipe Portaria Prime.</Alert>}
          </Card>
        )}
      </div>
    </main>
  );
}
