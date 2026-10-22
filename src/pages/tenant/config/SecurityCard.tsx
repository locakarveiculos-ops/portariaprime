import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useTenant } from '../../../lib/tenant';
import { useSession } from '../../../lib/session';
import { navigate, onLink } from '../../../lib/router';
import { dateTime } from '../../../lib/format';
import { Alert, Button, Card, Empty, Spinner } from '../../../components/ui';

// Ações registradas em audit_logs, em linguagem simples (as demais aparecem pelo código).
const ACTION: Record<string, string> = {
  'tenant.provisioned': 'Condomínio criado', 'portal.created': 'Portal criado', 'portal.welcome_resent': 'Link do portal reenviado',
  'invitation.accepted': 'Convite aceito', 'access_request.created': 'Cadastro solicitado', 'access_request.approved': 'Cadastro aprovado',
  'access_request.rejected': 'Cadastro recusado', 'receipt_layout.saved': 'Layout do comprovante alterado', 'app_icons.updated': 'Ícones do app atualizados',
  'package.manual_pickup': 'Retirada sem QR (justificada)', 'notification.retry': 'Aviso reenviado', 'receipt.pdf_retry': 'Comprovante reprocessado',
  'whatsapp.test': 'Teste de WhatsApp', 'device.paired': 'Totem pareado', 'device.revoked': 'Totem revogado', 'device.package_received': 'Encomenda registrada no totem',
};

/** Histórico de ações do condomínio (RLS: somente administradores) e sessão deste aparelho. */
export function SecurityCard() {
  const t = useTenant();
  const { signOut } = useSession();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const load = useCallback(async (cursor: string | null) => {
    let q = supabase.from('audit_logs').select('id, action, target_type, created_at').eq('tenant_id', t.tenant.id).order('created_at', { ascending: false }).limit(30);
    if (cursor) q = q.lt('created_at', cursor);
    const { data, error } = await q;
    if (error) { setError('Não foi possível carregar o histórico.'); return; }
    setError(null);
    setRows((r) => (cursor ? [...(r || []), ...(data || [])] : data || []));
    setMore((data || []).length === 30);
    setBefore(data?.length ? data[data.length - 1].created_at : cursor);
  }, [t.tenant.id]);
  useEffect(() => { void load(null); }, [load]);
  const base = `/c/${t.tenant.slug}`;
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <p className="font-semibold">Este aparelho</p>
        <p className="text-sm text-muted">Sair encerra a sessão apenas neste aparelho. Para tirar o acesso de alguém da equipe, revogue em Equipe e permissões.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={async () => { await signOut(); navigate('/entrar', true); }}>Sair deste aparelho</Button>
          <a href={`${base}/aplicativo`} onClick={onLink} className="inline-flex items-center text-sm underline min-h-11">Aplicativo e notificações deste aparelho</a>
        </div>
      </Card>
      {t.link.role === 'admin' && (
        <Card className="space-y-3">
          <p className="font-semibold">Histórico de ações</p>
          <p className="text-sm text-muted">Registro do sistema, sem senhas ou dados de pagamento. Visível apenas para administradores.</p>
          {error ? <Alert tone="danger">{error} <button className="underline" onClick={() => load(null)}>Tentar novamente</button></Alert>
            : !rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nenhuma ação registrada" /> : (
              <ul className="divide-y divide-line text-sm">
                {rows.map((r) => (
                  <li key={r.id} className="py-2 flex flex-wrap justify-between gap-2">
                    <span>{ACTION[r.action] || r.action}</span>
                    <span className="text-muted">{dateTime(r.created_at, t.tenant.timezone)}</span>
                  </li>
                ))}
              </ul>
            )}
          {more && <Button variant="ghost" onClick={() => load(before)}>Carregar mais</Button>}
        </Card>
      )}
    </div>
  );
}
