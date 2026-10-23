import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { friendly, rpc } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, inputCls, useAction } from '../../components/ui';
import { SUPPORT_CATEGORY, SUPPORT_PRIORITY, SUPPORT_STATUS } from '../tenant/SupportPage';
import type { PlatformContext } from './platform-model';

const FILTERS = { status: 'ativos', priority: '', category: '', query: '', mine: false };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const hours = (h: number | null | undefined) => (h == null ? '—' : h < 24 ? `${h} h` : `${(h / 24).toFixed(1)} dias`);

/** Admin Master › Suporte: fila, filtros, detalhe com conversa, resposta, nota interna, situação e métricas. */
export default function SupportPanel({ context }: { context: PlatformContext }) {
  const manage = context.capabilities.includes('support_manage');
  const [draft, setDraft] = useState(FILTERS);
  const [filters, setFilters] = useState(FILTERS);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; rows: any[] } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    setData(null); setError('');
    rpc('support_admin_list', { p_status: filters.status, p_priority: filters.priority, p_category: filters.category, p_query: filters.query,
      p_tenant: null, p_mine: filters.mine, p_page: page }).then(setData).catch((e) => setError(friendly(e)));
  }, [filters, page]);
  useEffect(() => { if (!open) load(); }, [load, open]);
  if (open) return <AdminTicket id={open} manage={manage} onBack={() => setOpen(null)} />;
  return (
    <div className="space-y-4">
      <Metrics />
      <Card>
        <form className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); setPage(0); setFilters(draft); }}>
          <Field label="Situação"><Select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            <option value="ativos">Ativos (não resolvidos)</option><option value="">Todas</option>
            {Object.entries(SUPPORT_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Prioridade"><Select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
            <option value="">Todas</option>{Object.entries(SUPPORT_PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Tema"><Select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
            <option value="">Todos</option>{Object.entries(SUPPORT_CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Protocolo ou assunto"><Input type="search" maxLength={120} value={draft.query} onChange={(e) => setDraft({ ...draft, query: e.target.value })} /></Field>
          <div className="flex flex-wrap gap-2 items-center">
            <label className="flex items-center gap-2 text-sm min-h-11"><input type="checkbox" checked={draft.mine} onChange={(e) => setDraft({ ...draft, mine: e.target.checked })} /> Só meus</label>
            <Button type="submit">Filtrar</Button>
          </div>
        </form>
      </Card>
      {error ? <Alert tone="danger">{error}</Alert> : !data ? <Spinner /> : (
        <>
          <p className="text-sm" role="status">{data.total} chamado(s) · página {page + 1} de {Math.max(1, Math.ceil(data.total / 25))}</p>
          {data.rows.length === 0 ? <Card>Nenhum chamado para os filtros.</Card> : (
            <ul className="rounded-2xl border border-line bg-surface divide-y divide-line">
              {data.rows.map((r) => (
                <li key={r.id}>
                  <button className="w-full text-left flex flex-wrap items-center justify-between gap-2 px-4 py-3 min-h-12 hover:bg-surface-2" onClick={() => setOpen(r.id)}>
                    <span className="min-w-0">
                      <span className="font-mono text-xs text-muted">{r.protocol}</span> {r.awaiting_team && <Badge tone="warning">aguardando equipe</Badge>}
                      <span className="block font-medium">{r.subject}</span>
                      <span className="block text-xs text-muted">{r.tenant_name || 'Sem condomínio'} · {SUPPORT_CATEGORY[r.category] || r.category} · {r.kind} · aberto {dateTime(r.created_at)}{r.assigned_name ? ` · com ${r.assigned_to_me ? 'você' : r.assigned_name}` : ''}</span>
                    </span>
                    <span className="flex gap-1">
                      <Badge tone={r.priority === 'urgente' ? 'danger' : r.priority === 'alta' ? 'warning' : 'neutral'}>{SUPPORT_PRIORITY[r.priority]}</Badge>
                      <Badge tone={SUPPORT_STATUS[r.status]?.[1] || 'neutral'}>{SUPPORT_STATUS[r.status]?.[0] || r.status}</Badge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between gap-3">
            <Button variant="secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Página anterior</Button>
            <Button variant="secondary" disabled={(page + 1) * 25 >= data.total} onClick={() => setPage((p) => p + 1)}>Próxima página</Button>
          </div>
        </>
      )}
    </div>
  );
}

function Metrics() {
  const [range, setRange] = useState({ from: iso(new Date(Date.now() - 29 * 864e5)), to: iso(new Date()) });
  const [m, setM] = useState<any | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; setM(null); setError('');
    rpc('support_metrics', { p_from: range.from, p_to: range.to }).then((r) => alive && setM(r)).catch((e) => alive && setError(friendly(e)));
    return () => { alive = false; };
  }, [range]);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="font-semibold">Indicadores do suporte</h3>
        <div className="flex gap-2">
          <Field label="De"><Input type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="Até"><Input type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} /></Field>
        </div>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : !m ? <Spinner /> : (
        <>
          <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <div><dt className="text-muted">Chamados abertos no período</dt><dd className="text-2xl font-semibold tabular-nums">{m.opened}</dd></div>
            <div><dt className="text-muted">1ª resposta (mediana / média)</dt><dd className="text-2xl font-semibold tabular-nums">{hours(m.first_response.median_h)}</dd><dd className="text-xs text-muted">média {hours(m.first_response.avg_h)} · {m.first_response.n} respondidos · {m.first_response.pending} sem resposta</dd></div>
            <div><dt className="text-muted">Resolução (mediana / média)</dt><dd className="text-2xl font-semibold tabular-nums">{hours(m.resolution.median_h)}</dd><dd className="text-xs text-muted">média {hours(m.resolution.avg_h)} · {m.resolution.n} resolvidos</dd></div>
            <div><dt className="text-muted">Fila atual</dt><dd className="text-sm">{Object.entries(m.backlog).map(([k, v]) => `${SUPPORT_STATUS[k]?.[0] || k}: ${v}`).join(' · ') || 'vazia'}</dd></div>
          </dl>
          <div className="text-sm"><p className="text-muted">Por tema</p>
            {m.by_category.length === 0 ? <p>Sem chamados no período.</p> : <ul className="flex flex-wrap gap-2 mt-1">{m.by_category.map((c: any) => <li key={c.category}><Badge>{SUPPORT_CATEGORY[c.category] || c.category}: {c.n}</Badge></li>)}</ul>}
          </div>
          <p className="text-xs text-muted">Tempos calculados dos registros (abertura, primeira resposta pública e resolução), em horas corridas, fuso de São Paulo. Notas internas não contam como resposta.</p>
        </>
      )}
    </Card>
  );
}

function AdminTicket({ id, manage, onBack }: { id: string; manage: boolean; onBack: () => void }) {
  const [tk, setTk] = useState<any | null>(null);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const { busy, run } = useAction();
  const load = useCallback(() => rpc('support_admin_ticket', { p_ticket: id }).then(setTk).catch((e) => setError(friendly(e))), [id]);
  useEffect(() => { load(); }, [load]);
  const act = (fn: string, args: Record<string, unknown>, ok: string) => run(async () => { await rpc(fn, { p_ticket: id, ...args }); await load(); }, ok);
  return (
    <div className="space-y-4 max-w-4xl">
      <button className="inline-flex items-center gap-1 text-sm underline min-h-11" onClick={onBack}><ArrowLeft className="w-4 h-4" /> Fila</button>
      {error ? <Alert tone="danger">{error}</Alert> : !tk ? <Spinner /> : (
        <>
          <Card className="space-y-2">
            <p className="font-mono text-xs text-muted">{tk.protocol}</p>
            <h3 className="text-lg font-semibold">{tk.subject}</h3>
            <dl className="grid sm:grid-cols-3 gap-2 text-sm">
              <div><dt className="text-muted">Condomínio</dt><dd>{tk.tenant_name || '—'}{tk.tenant_slug ? ` (/c/${tk.tenant_slug})` : ''}</dd></div>
              <div><dt className="text-muted">Aberto por</dt><dd>{tk.opener_name} ({tk.opener_role})</dd></div>
              <div><dt className="text-muted">Tema / tipo</dt><dd>{SUPPORT_CATEGORY[tk.category]} · {tk.kind}</dd></div>
              <div><dt className="text-muted">Tela / versão</dt><dd className="break-all">{tk.ctx_route || '—'} · {tk.ctx_app_version || '—'}</dd></div>
              <div><dt className="text-muted">Responsável</dt><dd>{tk.assigned_name ? (tk.assigned_to_me ? 'Você' : tk.assigned_name) : 'Ninguém'}</dd></div>
              <div><dt className="text-muted">1ª resposta</dt><dd>{dateTime(tk.first_response_at)}</dd></div>
            </dl>
            {manage && (
              <div className="flex flex-wrap gap-2 items-end border-t border-line pt-3">
                {!tk.assigned_to_me && <Button variant="secondary" loading={busy} onClick={() => act('support_admin_assign', {}, 'Chamado assumido.')}>Assumir</Button>}
                <Field label="Situação"><Select value={tk.status} disabled={busy} onChange={(e) => act('support_admin_set', { p_status: e.target.value, p_priority: null }, 'Situação atualizada.')}>
                  {Object.entries(SUPPORT_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
                <Field label="Prioridade"><Select value={tk.priority} disabled={busy} onChange={(e) => act('support_admin_set', { p_status: null, p_priority: e.target.value }, 'Prioridade atualizada.')}>
                  {Object.entries(SUPPORT_PRIORITY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              </div>
            )}
          </Card>
          <ol className="space-y-3" aria-label="Conversa">
            {tk.messages.map((m: any) => (
              <li key={m.id} className={`rounded-2xl border p-3 ${m.internal ? 'border-warning/40 bg-warning-bg' : m.side === 'equipe' ? 'border-line bg-surface-2' : 'border-line bg-surface'}`}>
                <p className="text-xs text-muted mb-1">{m.internal ? 'Nota interna · ' : ''}{m.side === 'equipe' ? (m.mine ? 'Você (equipe)' : 'Equipe') : m.author} · {dateTime(m.created_at)}</p>
                <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
              </li>
            ))}
          </ol>
          {manage ? (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await rpc('support_admin_reply', { p_ticket: id, p_body: body, p_internal: internal }); setBody(''); await load(); }, internal ? 'Nota interna registrada.' : 'Resposta enviada ao cliente.'); }}>
              <Field label={internal ? 'Nota interna (o cliente não vê)' : 'Resposta ao cliente'} hint="Nunca peça senha. A resposta pública avisa quem abriu por e-mail e push.">
                <textarea required maxLength={4000} rows={4} className={`${inputCls} py-2`} value={body} onChange={(e) => setBody(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm min-h-11"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Nota interna</label>
              <Button type="submit" loading={busy} variant={internal ? 'secondary' : 'primary'}>{internal ? 'Salvar nota interna' : 'Responder ao cliente'}</Button>
            </form>
          ) : <Alert>Seu papel permite apenas leitura dos chamados.</Alert>}
        </>
      )}
    </div>
  );
}
