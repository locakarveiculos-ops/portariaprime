import React, { useCallback, useEffect, useState } from 'react';
import { friendly, rpc } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Modal, Spinner, useAction } from '../../components/ui';
import { UUID, type PlatformContext } from './platform-model';

const LINK: Record<string, string> = { pending: 'pendente', active: 'ativo', rejected: 'recusado', revoked: 'encerrado' };

/** Admin Master › Administradoras: consulta e, com organizations_manage, vínculo direto auditado. */
export default function OrganizationsPanel({ context }: { context: PlatformContext }) {
  const manage = context.capabilities.includes('organizations_manage');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'link' | 'end' | 'status'; org: any; link?: any } | null>(null);
  const load = useCallback(() => { setRows(null); setError(''); rpc<any[]>('org_platform_list', { p_query: query }).then(setRows).catch((e) => setError(friendly(e))); }, [query]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="space-y-4">
      <Alert>Administradoras usam papéis próprios e só veem indicadores agregados dos condomínios que autorizaram. Vínculo criado aqui dispensa a aprovação do síndico: use só com contrato e justificativa; o síndico vê e pode revogar.</Alert>
      <Card><form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <Field label="Nome ou documento"><Input type="search" maxLength={120} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Button type="submit">Buscar</Button>
      </form></Card>
      {error ? <Alert tone="danger">{error}</Alert> : !rows ? <Spinner /> : rows.length === 0 ? <Card>Nenhuma administradora encontrada.</Card> : (
        <div className="space-y-3">{rows.map((o) => (
          <Card key={o.id} className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="font-semibold">{o.name} {o.status !== 'active' && <Badge tone="danger">suspensa</Badge>}</p>
                <p className="text-xs text-muted">ID {o.id}{o.document ? ` · doc. ${o.document}` : ''} · {o.members_active} membro(s) ativo(s) · desde {dateTime(o.created_at)}</p></div>
              {manage && <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDialog({ kind: 'link', org: o })}>Vincular condomínio</Button>
                <Button variant="ghost" onClick={() => setDialog({ kind: 'status', org: o })}>{o.status === 'active' ? 'Suspender' : 'Reativar'}</Button>
              </div>}
            </div>
            {o.links.length > 0 && <ul className="text-sm divide-y divide-line">{o.links.map((l: any) => (
              <li key={l.id} className="py-1 flex flex-wrap items-center justify-between gap-2">
                <span>{l.tenant_name} · <Badge tone={l.status === 'active' ? 'success' : 'neutral'}>{LINK[l.status]}</Badge>{l.source === 'platform' && <span className="text-xs text-muted"> (plataforma)</span>}</span>
                {manage && ['active', 'pending'].includes(l.status) && <Button variant="ghost" onClick={() => setDialog({ kind: 'end', org: o, link: l })}>Encerrar</Button>}
              </li>))}</ul>}
          </Card>
        ))}</div>
      )}
      {dialog && <ActionModal {...dialog} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />}
    </div>
  );
}

function ActionModal({ kind, org, link, onClose, onDone }: { kind: 'link' | 'end' | 'status'; org: any; link?: any; onClose: () => void; onDone: () => void }) {
  const [tenant, setTenant] = useState('');
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const title = kind === 'link' ? `Vincular condomínio a ${org.name}` : kind === 'end' ? `Encerrar vínculo com ${link.tenant_name}` : `${org.status === 'active' ? 'Suspender' : 'Reativar'} ${org.name}`;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (kind === 'link' && !UUID.test(tenant)) { alert('Informe o ID (UUID) do condomínio.'); return; }
    run(async () => {
      if (kind === 'link') await rpc('org_platform_link', { p_org: org.id, p_tenant: tenant, p_reason: reason });
      else if (kind === 'end') await rpc('org_platform_end_link', { p_link: link.id, p_reason: reason });
      else await rpc('org_platform_set_status', { p_org: org.id, p_status: org.status === 'active' ? 'suspended' : 'active', p_reason: reason });
      onDone();
    }, 'Registrado com auditoria.');
  };
  return <Modal title={title} onClose={onClose}>
    <form className="space-y-3" onSubmit={submit}>
      {kind === 'link' && <Field label="ID do condomínio"><Input required value={tenant} onChange={(e) => setTenant(e.target.value.trim())} placeholder="UUID" /></Field>}
      <Field label="Justificativa" hint="Mínimo de 10 caracteres. Fica na auditoria; não inclua dados pessoais."><Input required minLength={10} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Button type="submit" loading={busy}>Confirmar</Button>
    </form>
  </Modal>;
}
