import React, { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api, rpc } from '../../../lib/api';
import { useTenant } from '../../../lib/tenant';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../../../components/ui';

const ROLE: Record<string, string> = { admin: 'Administrador', porteiro: 'Porteiro' };
const PERM: Record<string, string> = { team: 'equipe', approve: 'aprova moradores', settings: 'configurações', billing: 'pagamentos' };

/** Equipe (administradores e porteiros): convites, papéis e revogação. Moradores ficam em Unidades e moradores. */
export function TeamCard() {
  const t = useTenant();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const { busy, run } = useAction();
  const load = useCallback(() => rpc<any[]>('list_members', { p_tenant: t.tenant.id })
    .then((m) => { setRows(m.filter((x) => x.role !== 'morador')); setError(null); })
    .catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  if (!t.can('team')) return null;
  const toggle = (m: any) => {
    const revoking = m.status === 'active';
    if (revoking && !confirm(`Revogar o acesso de ${m.full_name || m.email}? A pessoa perde o acesso imediatamente, mesmo com o app aberto.`)) return;
    run(async () => { await rpc('set_membership_status', { p_membership: m.membership_id, p_status: revoking ? 'revoked' : 'active' }); await load(); },
      revoking ? 'Acesso revogado.' : 'Acesso reativado.');
  };
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">Pessoas da equipe</p>
        <Button variant="secondary" onClick={() => setInviting(true)} data-tour="config-equipe">Convidar equipe</Button>
      </div>
      {error ? <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>
        : !rows ? <Spinner /> : rows.length === 0 ? <Empty title="Ninguém na equipe ainda" /> : (
          <ul className="divide-y divide-line">
            {rows.map((m) => (
              <li key={m.membership_id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <strong>{m.full_name || m.email}</strong>{m.full_name && <span className="text-muted"> · {m.email}</span>}{' '}
                  <Badge tone={m.role === 'admin' ? 'accent' : 'neutral'}>{ROLE[m.role] || m.role}</Badge>{' '}
                  {m.status !== 'active' && <Badge tone="danger">revogado</Badge>}
                  {m.role === 'admin' && m.permissions?.length > 0 && <span className="block text-xs text-muted">Pode: {m.permissions.map((p: string) => PERM[p] || p).join(', ')}</span>}
                </span>
                <Button variant="ghost" loading={busy} onClick={() => toggle(m)}>{m.status === 'active' ? 'Revogar acesso' : 'Reativar'}</Button>
              </li>
            ))}
          </ul>
        )}
      {inviting && <InviteTeamModal onClose={() => setInviting(false)} onDone={() => { setInviting(false); load(); }} />}
    </Card>
  );
}

function InviteTeamModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTenant();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('porteiro');
  const [perms, setPerms] = useState<string[]>(['team', 'approve', 'settings']);
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/invitations/send', { tenantId: t.tenant.id, email, role, unitId: null, permissions: role === 'admin' ? perms : [] });
      if (r.manualLink) setLink(r.manualLink);
      else { toast.success('Convite enviado por e-mail.'); onDone(); }
    });
  };
  return (
    <Modal title="Convidar equipe" onClose={link ? onDone : onClose}>
      {link ? (
        <div className="space-y-3">
          <Alert tone="warning">O convite foi criado, mas o e-mail não pôde ser enviado (serviço de e-mail não configurado ou indisponível). Envie este link à pessoa por um canal seguro:</Alert>
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(link); toast.success('Link copiado.'); }}><Copy className="w-4 h-4" /> Copiar link</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="E-mail da pessoa" hint="O convite só funciona com este e-mail e vale 7 dias."><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Papel">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="porteiro">Porteiro — recebe e entrega encomendas</option>
              <option value="admin">Administrador — síndico/gestão</option>
            </Select>
          </Field>
          {role === 'admin' && (
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium mb-1">Permissões do administrador</legend>
              {[['team', 'Gerenciar equipe'], ['approve', 'Aprovar moradores'], ['settings', 'Configurações e marca'], ['billing', 'Assinatura e pagamentos']].map(([k, l]) => (
                <label key={k} className="flex gap-2 items-center min-h-9"><input type="checkbox" checked={perms.includes(k)} onChange={(e) => setPerms(e.target.checked ? [...perms, k] : perms.filter((x) => x !== k))} /> {l}</label>
              ))}
            </fieldset>
          )}
          <Button type="submit" loading={busy} className="w-full">Enviar convite</Button>
        </form>
      )}
    </Modal>
  );
}
