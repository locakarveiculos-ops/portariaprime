import React, { useCallback, useEffect, useState } from 'react';
import { rpc } from '../lib/api';
import { supabase } from '../lib/supabase';
import { loadCatalog, PlanRow } from '../lib/catalog';
import { brl, dateTime } from '../lib/format';
import { Alert, Button, Card, Field, Input, Select, Spinner, useAction } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';

const FUNNEL_LABEL: Record<string, string> = {
  landing_view: 'Visitaram a página', pricing_view: 'Viram os planos', cta_trial_click: 'Clicaram em testar',
  signup_started: 'Abriram o cadastro', signup_completed: 'Criaram conta', trial_started: 'Ativaram o mês grátis',
};

function FunnelCard() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [rows, setRows] = useState<{ event: string; visitors: number }[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setRows(null); rpc('funnel_summary', { p_from: from, p_to: to }).then(setRows).catch((e) => setError(e.message)); }, [from, to]);
  const top = rows?.find((r) => r.event === 'landing_view')?.visitors || 0;
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Funil da landing (visitantes anônimos únicos)</h2>
      <div className="flex flex-wrap gap-3"><Field label="De"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="Até"><Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></Field></div>
      {error ? <Alert tone="danger">{error}</Alert> : !rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-muted">Sem eventos no período.</p> : (
        <ol className="space-y-1 text-sm">{Object.keys(FUNNEL_LABEL).map((k) => { const n = rows.find((r) => r.event === k)?.visitors || 0; return <li key={k} className="flex justify-between border-b border-line py-1"><span>{FUNNEL_LABEL[k]}</span><span>{n}{top ? ` · ${Math.round((n / top) * 100)}%` : ''}</span></li>; })}</ol>
      )}
      <p className="text-xs text-muted">Sem nome, e-mail ou IP. Eventos de QA na stack local não vão para produção.</p>
    </Card>
  );
}

function ContactsAdmin() {
  const [rows, setRows] = useState<any[] | null>(null);
  const { run } = useAction();
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('contact_requests').select('id, name, email, phone, message, source, status, created_at').neq('status', 'resolvido').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    setRows(data || []);
  }, []);
  useEffect(() => { load().catch(() => setRows([])); }, [load]);
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Contatos e suporte em aberto</h2>
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="text-sm text-muted">Nenhuma mensagem em aberto.</p> : (
        <ul className="divide-y divide-line">{rows.map((c) => (
          <li key={c.id} className="py-3 space-y-1 text-sm">
            <p><strong>{c.name}</strong> · {c.email}{c.phone ? ` · ${c.phone}` : ''} · {c.source} · {dateTime(c.created_at)}</p>
            <p className="text-muted whitespace-pre-wrap">{c.message}</p>
            <div className="flex gap-2">{(['em_atendimento', 'resolvido'] as const).filter((s) => s !== c.status).map((s) => (
              <Button key={s} variant="ghost" onClick={() => run(async () => { const { error } = await supabase.from('contact_requests').update({ status: s }).eq('id', c.id); if (error) throw error; await load(); }, 'Atualizado.')}>{s === 'resolvido' ? 'Marcar resolvido' : 'Em atendimento'}</Button>
            ))}</div>
          </li>
        ))}</ul>
      )}
    </Card>
  );
}

export default function AdminPage() {
  const [overview, setOverview] = useState<any>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [error, setError] = useState('');
  const { busy, run } = useAction();
  const load = useCallback(async () => {
    try {
      const [o, p, { data, error: ie }] = await Promise.all([
        rpc('admin_overview'), loadCatalog(), supabase.from('billing_incidents').select('*').is('resolved_at', null).order('created_at', { ascending: false }).limit(100),
      ]);
      if (ie) throw ie;
      setOverview(o); setPlans(p); setIncidents(data || []);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return <main className="max-w-6xl mx-auto px-4 py-8 space-y-5">
    <PortariaPrimeLogo /><h1 className="text-2xl font-semibold">Administração da plataforma</h1>
    <a href="/app" className="underline">Voltar aos condomínios</a>
    <Alert>Suporte global não concede acesso automático a fotos, assinaturas ou encomendas dos clientes.</Alert>
    {error && <Alert tone="danger">{error}</Alert>}
    {!overview ? <Spinner /> : <>
      <Card><p>Ocorrências financeiras abertas: {overview.incidents_open} · Eventos pendentes: {overview.events_pending} · Avisos com falha: {overview.jobs_failed}</p></Card>
      <Card><h2 className="font-semibold mb-3">Condomínios</h2><ul className="divide-y divide-line">
        {overview.tenants.map((t: any) => <li key={t.id} className="py-3 space-y-2"><p><strong>{t.name}</strong> · {t.plan} · {t.subscription} · {t.status}</p>
          <p className="text-sm text-muted">Fim do teste: {dateTime(t.trial_ends_at)} · Período pago: {dateTime(t.period_end)}</p>
          <Button variant="secondary" disabled={busy} onClick={() => {
            const reason = prompt('Justificativa da alteração administrativa (mín. 10 caracteres):');
            if (reason) run(async () => { await rpc('admin_set_tenant_status', { p_tenant: t.id, p_status: t.status === 'active' ? 'suspended' : 'active', p_reason: reason }); await load(); }, 'Situação atualizada.');
          }}>{t.status === 'active' ? 'Suspender por segurança' : 'Reativar'}</Button>
        </li>)}
      </ul></Card>
      <Card><h2 className="font-semibold mb-3">Catálogo de planos</h2><Alert tone="warning">Preços iniciais são hipóteses comerciais. Revise valores e franquias antes de publicar. Publicar permite contratação real quando o ambiente estiver habilitado.</Alert>
        {plans.map(p => <div key={p.id} className="border-t border-line py-4 space-y-2">
          <p className="font-semibold">{p.name} · {p.published ? 'publicado' : 'não publicado'}</p>
          <p className="text-sm">{p.prices.map(pr => `${pr.cycle}: ${brl(pr.amount_cents)}`).join(' · ')}</p>
          <p className="text-sm text-muted">Unidades: {p.ent?.max_units} · Portarias: {p.ent?.max_concierges} · OCR: {p.ent?.ocr_monthly}/mês · WhatsApp: {p.ent?.whatsapp_monthly}/mês</p>
          <form className="flex flex-wrap gap-3 items-end" onSubmit={event => {
            event.preventDefault(); const data = new FormData(event.currentTarget);
            run(async () => { await rpc('admin_set_price', { p_plan_code: p.code, p_cycle: data.get('cycle'), p_amount_cents: Number(data.get('amount')) }); await load(); }, 'Nova versão de preço salva.');
          }}>
            <Field label="Ciclo"><Select name="cycle"><option value="monthly">Mensal</option><option value="quarterly">Trimestral</option><option value="yearly">Anual</option></Select></Field>
            <Field label="Total em centavos"><Input name="amount" type="number" min={1} step={1} required /></Field><Button type="submit" loading={busy}>Versionar preço</Button>
          </form>
          <Button variant="secondary" disabled={busy} onClick={() => {
            if (!confirm(p.published ? 'Retirar este plano do catálogo público?' : 'Publicar este plano e seus preços para contratação?')) return;
            run(async () => { const { error } = await supabase.from('plans').update({ published: !p.published }).eq('id', p.id); if (error) throw error; await load(); });
          }}>{p.published ? 'Despublicar' : 'Publicar após revisão'}</Button>
        </div>)}
      </Card>
      <FunnelCard />
      <ContactsAdmin />
      <Card><h2 className="font-semibold">Ocorrências financeiras</h2>{incidents.length ? incidents.map(i => <p key={i.id} className="py-2 border-b border-line">{i.kind} · pedido {i.order_id || 'desconhecido'} · {dateTime(i.created_at)}</p>) : <p>Nenhuma ocorrência aberta.</p>}</Card>
    </>}
  </main>;
}
