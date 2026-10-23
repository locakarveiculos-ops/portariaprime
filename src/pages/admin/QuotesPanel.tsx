import React, { useCallback, useEffect, useState } from 'react';
import { api, friendly, rpc } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { brl, CYCLE_LABEL, dateTime } from '../../lib/format';
import { toCents } from '../../components/QuoteForm';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner, inputCls } from '../../components/ui';

type Row = Record<string, any>;
const STATUS: Record<string, string> = { recebida: 'Recebida', em_analise: 'Em análise', proposta_enviada: 'Proposta enviada', aceita: 'Aceita', encerrada: 'Encerrada' };
const P_STATUS: Record<string, string> = { draft: 'Rascunho', sent: 'Enviada', accepted: 'Aceita', expired: 'Vencida', withdrawn: 'Retirada' };

async function downloadPdf(proposalId: string) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/api/commercial/proposal_pdf', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` }, body: JSON.stringify({ proposalId }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Não foi possível gerar o PDF.');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'proposta.pdf';
  const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function Detail({ id, can, onChanged }: { id: string; can: (c: string) => boolean; onChanged: () => void }) {
  const [d, setD] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ title: string; run: (reason: string) => Promise<unknown> } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => rpc('quote_detail', { p_quote: id }).then(setD).catch(e => setError(friendly(e))), [id]);
  useEffect(() => { load(); }, [load]);
  const act = (title: string, action: string, data: Row = {}) => setPending({ title, run: r => rpc('quote_action', { p_action: action, p_quote: id, p_data: data, p_reason: r }) });
  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setError('');
    try { await pending.run(reason); setPending(null); setReason(''); await load(); onChanged(); }
    catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  };
  const openAttachment = async () => {
    try { const r = await api<{ url: string }>('/api/commercial/attachment', { quoteId: id }); window.open(r.url, '_blank', 'noopener,noreferrer'); }
    catch (e) { setError(friendly(e)); }
  };
  if (!d) return error ? <Alert tone="danger">{error}</Alert> : <Spinner />;
  const q = d.quote, s = d.suggestion;
  const rows: [string, React.ReactNode][] = [
    ['Protocolo', q.protocol], ['Contato', `${q.contact_name} · ${q.email}${q.phone ? ` · ${q.phone}` : ''}`],
    ['Organização', `${q.org_name} (${q.org_kind === 'administradora' ? 'administradora' : 'condomínio'})`],
    ['Porte', `${q.units} unidades · ${q.concierges} portaria(s) · ${q.condos_count} condomínio(s)`],
    ['Fornecedor atual', q.current_vendor || '—'],
    ['Orçamento', q.budget_cents ? `${brl(q.budget_cents)} ${CYCLE_LABEL[q.budget_cycle]?.toLowerCase()}${q.budget_valid_until ? ` · válido até ${q.budget_valid_until}` : ''}` : 'Não informado'],
    ['Escopo', <span className="whitespace-pre-line">{q.scope || '—'}</span>],
  ];
  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <dl className="divide-y divide-line text-sm">{rows.map(([k, v]) => <div key={k} className="grid sm:grid-cols-[10rem_1fr] gap-1 py-1.5"><dt className="text-muted">{k}</dt><dd>{v}</dd></div>)}</dl>
      <div className="flex flex-wrap gap-2">
        {q.has_attachment && <Button variant="secondary" onClick={openAttachment}>Abrir anexo (link de 2 min)</Button>}
        {can('quote_manage') && <>
          <Button variant="ghost" onClick={() => act('Assumir atendimento', 'assign')}>Assumir</Button>
          <Button variant="ghost" onClick={() => act('Registrar nota', 'note')}>Nota</Button>
          {q.status !== 'encerrada' && <Button variant="ghost" onClick={() => act('Encerrar solicitação', 'status', { status: 'encerrada' })}>Encerrar</Button>}
        </>}
      </div>
      <Card className="space-y-1">
        <h3 className="font-semibold">Sugestão (interna, não é promessa)</h3>
        <p className="text-sm"><Badge tone={s.status === 'ok' || s.status === 'catalog' ? 'success' : 'warning'}>{s.status === 'needs_review' ? 'Revisão necessária' : s.status === 'catalog' ? 'Catálogo' : 'Sugerido'}</Badge>{' '}
          {s.plan_name || s.plan} {s.suggested_cents ? `· ${brl(s.suggested_cents)} ${CYCLE_LABEL[s.cycle]?.toLowerCase() || ''}` : ''}</p>
        <p className="text-sm text-muted">{s.reason}{s.missing ? ` Faltam: ${s.missing.join(', ')}.` : ''}</p>
      </Card>
      <section className="space-y-2">
        <h3 className="font-semibold">Propostas</h3>
        {d.proposals.length === 0 && <p className="text-sm text-muted">Nenhuma proposta.</p>}
        {d.proposals.map((p: Row) => (
          <div key={p.id} className="border border-line rounded-xl p-3 space-y-1 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><strong>v{p.version} · {p.plan_name} · {brl(p.amount_cents)} {CYCLE_LABEL[p.cycle]?.toLowerCase()}</strong><Badge tone={p.status === 'accepted' ? 'success' : p.status === 'sent' ? 'accent' : 'neutral'}>{P_STATUS[p.status]}</Badge></div>
            <p className="text-muted">{p.protocol || 'Sem protocolo (rascunho)'} · validade {p.valid_until ? dateTime(p.valid_until) : `${p.valid_days} dias após envio`}</p>
            <p className="whitespace-pre-line">{p.conditions}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="secondary" onClick={() => downloadPdf(p.id).catch(e => setError(friendly(e)))}>PDF</Button>
              {can('quote_manage') && p.status === 'draft' && <Button onClick={() => setPending({ title: 'Enviar proposta ao solicitante', run: r => api('/api/commercial/send_proposal', { proposalId: p.id, reason: r }) })}>Enviar</Button>}
              {can('quote_manage') && ['draft', 'sent'].includes(p.status) && <Button variant="ghost" onClick={() => act('Retirar proposta', 'proposal_withdraw', { proposal_id: p.id })}>Retirar</Button>}
            </div>
          </div>))}
        {can('quote_manage') && !['aceita', 'encerrada'].includes(q.status) && (
          <form className="grid sm:grid-cols-2 gap-2 border-t border-line pt-3" onSubmit={e => {
            e.preventDefault(); const f = new FormData(e.currentTarget); const cents = toCents(String(f.get('amount') || ''));
            if (!cents) { setError('Preço inválido.'); return; }
            act('Criar rascunho de proposta', 'proposal_draft', { plan: f.get('plan'), cycle: f.get('cycle'), amount_cents: cents,
              valid_days: Number(f.get('valid_days')), conditions: String(f.get('conditions') || '') });
          }}>
            <Field label="Plano"><Select name="plan" defaultValue={s.plan || 'profissional'}>{['essencial', 'profissional', 'prime', 'sob-medida'].map(c => <option key={c} value={c}>{c}</option>)}</Select></Field>
            <Field label="Ciclo"><Select name="cycle" defaultValue={s.cycle || 'monthly'}>{Object.entries(CYCLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Preço total por ciclo (R$)"><Input name="amount" required inputMode="decimal" defaultValue={s.suggested_cents ? (s.suggested_cents / 100).toFixed(2).replace('.', ',') : ''} /></Field>
            <Field label="Validade (dias)"><Input name="valid_days" type="number" min={1} max={90} defaultValue={15} /></Field>
            <div className="sm:col-span-2"><Field label="Condições"><textarea name="conditions" required minLength={10} rows={3} className={`${inputCls} py-2`} /></Field></div>
            <div><Button type="submit" variant="secondary">Criar rascunho</Button></div>
          </form>
        )}
      </section>
      <section>
        <h3 className="font-semibold">Histórico</h3>
        <ol className="text-sm space-y-1 mt-1">{d.events.map((e: Row, i: number) => <li key={i} className="text-muted">{dateTime(e.created_at)} · {e.kind}{e.data?.reason ? ` · ${e.data.reason}` : ''}</li>)}</ol>
      </section>
      {pending && (
        <Modal title={pending.title} onClose={() => !busy && setPending(null)}>
          <div className="space-y-3">
            <Field label="Justificativa (registrada no histórico)" hint="Mínimo de 10 caracteres.">
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} className={`${inputCls} py-2`} />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>Cancelar</Button>
              <Button onClick={confirm} loading={busy} disabled={reason.trim().length < 10}>Confirmar</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Admin Master › Orçamentos e propostas. Leitura: 'quotes'. Ações: 'quote_manage'. */
export default function QuotesPanel({ capabilities }: { capabilities: string[] }) {
  const can = (c: string) => capabilities.includes(c);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [list, setList] = useState<{ total: number; rows: Row[] } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => { setError(''); rpc('quote_list', { p_status: status, p_query: query, p_page: page }).then(setList).catch(e => setError(friendly(e))); }, [status, query, page]);
  useEffect(load, [load]);
  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-3 gap-2">
        <Field label="Buscar"><Input value={query} maxLength={120} onChange={e => { setPage(0); setQuery(e.target.value); }} /></Field>
        <Field label="Situação"><Select value={status} onChange={e => { setPage(0); setStatus(e.target.value); }}><option value="">Todas</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!list ? <Spinner /> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted"><th className="py-2 pr-3">Protocolo</th><th className="pr-3">Organização</th><th className="pr-3">Unidades</th><th className="pr-3">Orçamento</th><th className="pr-3">Situação</th><th>Recebida</th></tr></thead>
            <tbody>{list.rows.map(r => (
              <tr key={r.id} className="border-t border-line">
                <td className="py-2 pr-3"><button className="underline" onClick={() => setOpen(r.id)}>{r.protocol}</button></td>
                <td className="pr-3">{r.org_name}{r.has_attachment ? ' (anexo)' : ''}</td><td className="pr-3">{r.units}</td>
                <td className="pr-3">{r.budget_cents ? `${brl(r.budget_cents)} ${CYCLE_LABEL[r.budget_cycle]?.toLowerCase()}` : '—'}</td>
                <td className="pr-3"><Badge>{STATUS[r.status]}</Badge></td><td>{dateTime(r.created_at)}</td>
              </tr>))}</tbody>
          </table>
          <div className="flex justify-between items-center pt-3 text-sm">
            <span className="text-muted">{list.total} solicitação(ões)</span>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button>
              <Button variant="ghost" disabled={(page + 1) * 25 >= list.total} onClick={() => setPage(page + 1)}>Próxima</Button>
            </div>
          </div>
        </Card>
      )}
      {open && <Modal wide title="Solicitação de orçamento" onClose={() => setOpen(null)}><Detail id={open} can={can} onChanged={load} /></Modal>}
    </div>
  );
}
