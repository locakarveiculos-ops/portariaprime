import React, { useCallback, useEffect, useState } from 'react';
import { rpc } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { dateTime } from '../../../lib/format';
import { Alert, Badge, Button, Card, Spinner, useAction } from '../../../components/ui';

const STATUS: Record<string, [string, 'warning' | 'success' | 'neutral' | 'danger']> = {
  pending: ['Aguardando sua decisão', 'warning'], active: ['Autorizada', 'success'], rejected: ['Recusada', 'neutral'], revoked: ['Encerrada', 'neutral'],
};

/** Administradoras (síndico com permissão de configurações): aprovar, recusar ou revogar o acesso da carteira. */
export function OrgLinkCard() {
  const t = useTenant();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const allowed = t.can('settings');
  const load = useCallback(() => rpc<any[]>('tenant_org_links', { p_tenant: t.tenant.id })
    .then((r) => { setRows(r); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { if (allowed) load(); }, [load, allowed]);
  if (!allowed) return null;
  const decide = (l: any, d: 'approve' | 'reject' | 'revoke') => {
    if (d === 'approve' && !confirm(`Autorizar ${l.org_name} a ver indicadores agregados deste condomínio (encomendas aguardando, ocupação, falhas de aviso e situação comercial)? Ela não verá moradores, fotos nem assinaturas.`)) return;
    if (d === 'revoke' && !confirm(`Revogar o acesso de ${l.org_name}? Vale imediatamente.`)) return;
    run(async () => { await rpc('tenant_org_decide', { p_link: l.id, p_decision: d }); await load(); },
      d === 'approve' ? 'Administradora autorizada.' : d === 'reject' ? 'Pedido recusado.' : 'Acesso revogado.');
  };
  return (
    <Card className="space-y-3">
      <div><p className="font-semibold">Administradoras</p>
        <p className="text-sm text-muted">Administradoras só veem números agregados deste condomínio depois da sua aprovação. Nunca veem moradores, fotos ou assinaturas.</p></div>
      {error ? <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>
        : !rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-muted">Nenhum pedido de administradora.</p> : (
          <ul className="divide-y divide-line">
            {rows.map((l) => (
              <li key={l.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <strong>{l.org_name}</strong> <Badge tone={STATUS[l.status]?.[1] || 'neutral'}>{STATUS[l.status]?.[0] || l.status}</Badge>
                  <span className="block text-xs text-muted">
                    {l.org_document ? `Documento ${l.org_document} · ` : ''}{l.source === 'platform' ? 'Vínculo criado pela Portaria Prime' : `Pedido por ${l.requested_by_email || '—'}`} · {dateTime(l.requested_at, t.tenant.timezone)}
                  </span>
                </span>
                <span className="flex gap-2">
                  {l.status === 'pending' && <><Button loading={busy} onClick={() => decide(l, 'approve')}>Aprovar</Button><Button variant="ghost" loading={busy} onClick={() => decide(l, 'reject')}>Recusar</Button></>}
                  {l.status === 'active' && <Button variant="ghost" loading={busy} onClick={() => decide(l, 'revoke')}>Revogar acesso</Button>}
                </span>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
}
