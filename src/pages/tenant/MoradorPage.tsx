import React, { useEffect, useState } from 'react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { dateTime } from '../../lib/format';
import { Alert, Button, Card, Empty, Spinner } from '../../components/ui';
import { Notif, notifTarget, useNotifications } from '../../components/NotificationBell';
import { onLink } from '../../lib/router';

/** Central de notificações: as do próprio usuário (leitura individual), paginadas. */
export function AvisosPage() {
  const t = useTenant();
  const base = `/c/${t.tenant.slug}`;
  const [onlyUnread, setOnlyUnread] = useState(false);
  const { data, error, load, markRead } = useNotifications(onlyUnread);
  const [older, setOlder] = useState<Notif[]>([]);
  const [more, setMore] = useState(true);
  useEffect(() => { setOlder([]); setMore(true); }, [onlyUnread, data]);
  const rows = data ? [...data.items, ...older] : null;
  const loadMore = async () => {
    const last = rows![rows!.length - 1];
    const r = await rpc<{ items: Notif[] }>('my_notifications', { p_tenant: t.tenant.id, p_unread: onlyUnread, p_before: last.created_at, p_limit: 20 });
    setOlder((o) => [...o, ...r.items]); setMore(r.items.length === 20);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-2"><h1 className="text-2xl font-semibold">Notificações</h1>
        <div className="flex flex-wrap gap-2">
          <div role="radiogroup" aria-label="Filtro" className="inline-flex rounded-xl border border-line p-1">
            <button role="radio" aria-checked={!onlyUnread} onClick={() => setOnlyUnread(false)} className={`px-3 min-h-10 rounded-lg text-sm ${!onlyUnread ? 'bg-surface-2 font-semibold' : ''}`}>Todas</button>
            <button role="radio" aria-checked={onlyUnread} onClick={() => setOnlyUnread(true)} className={`px-3 min-h-10 rounded-lg text-sm ${onlyUnread ? 'bg-surface-2 font-semibold' : ''}`}>Não lidas{data?.unread ? ` (${data.unread > 99 ? '99+' : data.unread})` : ''}</button>
          </div>
          <Button variant="ghost" disabled={!data?.unread} onClick={() => markRead()}>Marcar todas como lidas</Button>
        </div></div>
      <Card>
        {error ? <Alert tone="danger">Não foi possível carregar. <button className="underline" onClick={load}>Tentar novamente</button></Alert>
          : !rows ? <Spinner /> : rows.length === 0 ? <Empty title={onlyUnread ? 'Tudo lido' : 'Nenhuma notificação'} /> : (
          <ul className="divide-y divide-line">
            {rows.map((n) => (
              <li key={n.id} className="py-3 flex gap-3 items-start">
                <span className={`mt-2 h-2 w-2 rounded-full shrink-0 ${n.read_at ? 'bg-transparent' : 'bg-primary'}`} aria-label={n.read_at ? undefined : 'não lida'} />
                <a href={notifTarget(base, n)} onClick={(e) => { if (!n.read_at) void markRead(n.id); onLink(e); }} className="min-w-0 flex-1">
                  <p className="font-medium">{n.title}</p>
                  <p className="text-sm text-muted">{n.body}</p>
                  <p className="text-xs text-muted mt-1">{dateTime(n.created_at, t.tenant.timezone)}</p>
                </a>
                {!n.read_at && <button className="text-xs underline text-muted min-h-9 shrink-0" onClick={() => markRead(n.id)}>Marcar como lida</button>}
              </li>
            ))}
          </ul>
        )}
        {rows && rows.length >= 20 && more && <Button variant="ghost" className="mt-2" onClick={loadMore}>Carregar mais</Button>}
      </Card>
    </div>
  );
}
