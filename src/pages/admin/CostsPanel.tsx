import React, { useCallback, useEffect, useState } from 'react';
import { friendly, rpc } from '../../lib/api';
import { brl, CYCLE_LABEL, dateTime } from '../../lib/format';
import { toCents } from '../../components/QuoteForm';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner, inputCls } from '../../components/ui';

type Sim = { validated: boolean; missing: string[]; usage: Record<string, number | boolean>; total_cost_cents?: number;
  floor_month_cents?: number; margin_pct?: number | null; viable?: boolean; price_month_cents?: number };
type Overview = {
  costs: { key: string; label: string; unit: 'cents' | 'percent'; value: number | null; source: string | null; updated_at: string | null; updated_by: string | null }[];
  missing: string[];
  policy: { discount_pct: number; campaign_active: boolean; criteria_text: string | null; updated_at: string };
  drafts: { id: string; plan: string; plan_name: string; cycle: string; amount_cents: number; status: string; note: string; current_cents: number | null; viability: Sim | null; created_at: string }[];
  plans: { code: string; name: string; is_custom: boolean; price_month_cents: number | null; typical: Sim | null; high: Sim | null }[];
};
type Pending = { action: string; target: string; data: Record<string, unknown>; title: string };

function SimCell({ sim }: { sim: Sim | null }) {
  if (!sim) return <span className="text-muted">Sob proposta</span>;
  if (!sim.validated) return <Badge tone="warning">Viabilidade não validada</Badge>;
  return (
    <div className="space-y-0.5 text-xs">
      <div>Custo: <strong>{brl(sim.total_cost_cents || 0)}</strong> · Piso: {brl(sim.floor_month_cents || 0)}</div>
      <div>Margem: {sim.margin_pct ?? '—'}% <Badge tone={sim.viable ? 'success' : 'danger'}>{sim.viable ? 'Viável' : 'Abaixo do piso'}</Badge></div>
      <div className="text-muted">{String(sim.usage.packages)} encomendas · {String(sim.usage.notices)} avisos · WhatsApp {String(sim.usage.whatsapp)}{sim.usage.whatsapp_capped ? ' (franquia)' : ''}</div>
    </div>
  );
}

/** Admin Master › Custos e viabilidade. Leitura: 'costs'. Ações: 'costs_manage'; ativar preço: 'plan_price'. */
export default function CostsPanel({ capabilities }: { capabilities: string[] }) {
  const can = (c: string) => capabilities.includes(c);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(() => { setError(''); rpc<Overview>('commercial_overview').then(setData).catch(e => setError(friendly(e))); }, []);
  useEffect(load, [load]);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      await rpc('commercial_action', { p_action: pending.action, p_target: pending.target, p_data: pending.data, p_reason: reason });
      setNotice(`${pending.title}: registrado e auditado.`); setPending(null); setReason(''); load();
    } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  };

  const editCost = (e: React.FormEvent<HTMLFormElement>, c: Overview['costs'][number]) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const raw = String(f.get('value') || '').trim().replace(',', '.');
    if (raw && !/^\d+(\.\d{1,4})?$/.test(raw)) { setError('Valor numérico inválido.'); return; }
    setPending({ action: 'cost_set', target: c.key, title: `Custo: ${c.label}`, data: { value: raw ? Number(raw) : null, source: String(f.get('source') || '') } });
  };

  if (error && !data) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {data.missing.length > 0 && (
        <Alert tone="warning">Viabilidade não validada: faltam {data.missing.length} custo(s). Custos ausentes nunca são tratados como zero; preços e propostas abaixo do catálogo ficam bloqueados.</Alert>
      )}

      <Card className="space-y-3">
        <h2 className="font-semibold">Simulação por plano (por mês)</h2>
        <p className="text-sm text-muted">Típico: 60% das unidades, 2 encomendas/unidade, 4 moradores avisados por encomenda (chegada e retirada). Alto: plano lotado, 4 encomendas/unidade, todos os avisos por WhatsApp e e-mail. WhatsApp e OCR param na franquia.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted"><th className="py-2 pr-3">Plano</th><th className="pr-3">Preço/mês</th><th className="pr-3">Típico</th><th>Alto</th></tr></thead>
            <tbody>{data.plans.map(p => (
              <tr key={p.code} className="border-t border-line align-top">
                <td className="py-2 pr-3 font-medium">{p.name}</td>
                <td className="pr-3">{p.is_custom ? 'Sob proposta' : p.price_month_cents ? brl(p.price_month_cents) : '—'}</td>
                <td className="pr-3"><SimCell sim={p.typical} /></td><td><SimCell sim={p.high} /></td>
              </tr>))}</tbody>
          </table>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Preços propostos (só novos contratos)</h2>
        <p className="text-sm text-muted">Assinaturas existentes mantêm preço e limites contratados. Ativar exige aprovação, viabilidade validada e preço acima do piso no cenário alto.</p>
        {data.drafts.length === 0 ? <p className="text-sm text-muted">Nenhum rascunho.</p> : data.drafts.map(d => (
          <div key={d.id} className="flex flex-wrap items-start justify-between gap-3 border-t border-line pt-3">
            <div className="space-y-1">
              <p className="font-medium">{d.plan_name} · {CYCLE_LABEL[d.cycle]} · {brl(d.amount_cents)} <span className="text-muted text-sm">(atual {d.current_cents ? brl(d.current_cents) : '—'})</span></p>
              <p className="text-xs text-muted">{d.note} · {dateTime(d.created_at)}</p>
              <SimCell sim={d.viability} />
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <Badge tone={d.status === 'active' ? 'success' : d.status === 'approved' ? 'accent' : 'neutral'}>{d.status}</Badge>
              {d.status === 'draft' && can('costs_manage') && <Button variant="secondary" onClick={() => setPending({ action: 'price_approve', target: d.id, data: {}, title: 'Aprovar preço' })}>Aprovar</Button>}
              {d.status === 'approved' && can('plan_price') && <Button onClick={() => setPending({ action: 'price_activate', target: d.id, data: {}, title: 'Ativar preço para novos contratos' })} disabled={!d.viability?.validated}>Ativar</Button>}
              {['draft', 'approved'].includes(d.status) && can('costs_manage') && <Button variant="ghost" onClick={() => setPending({ action: 'price_discard', target: d.id, data: {}, title: 'Descartar rascunho' })}>Descartar</Button>}
            </div>
          </div>))}
        {can('costs_manage') && (
          <form className="grid sm:grid-cols-4 gap-2 border-t border-line pt-3" onSubmit={e => {
            e.preventDefault(); const f = new FormData(e.currentTarget); const cents = toCents(String(f.get('amount') || ''));
            if (!cents) { setError('Preço inválido.'); return; }
            setPending({ action: 'price_draft', target: 'new', title: 'Novo rascunho de preço', data: { plan: f.get('plan'), cycle: f.get('cycle'), amount_cents: cents } });
          }}>
            <Field label="Plano"><Select name="plan">{data.plans.filter(p => !p.is_custom).map(p => <option key={p.code} value={p.code}>{p.name}</option>)}</Select></Field>
            <Field label="Ciclo"><Select name="cycle">{Object.entries(CYCLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
            <Field label="Preço (R$)"><Input name="amount" inputMode="decimal" required /></Field>
            <div className="flex items-end"><Button type="submit" variant="secondary">Criar rascunho</Button></div>
          </form>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Custos de viabilidade</h2>
        {data.costs.map(c => (
          <form key={c.key} onSubmit={e => editCost(e, c)} className="grid sm:grid-cols-[1fr_8rem_1fr_auto] gap-2 items-end border-t border-line pt-3">
            <div className="text-sm"><p className="font-medium">{c.label}</p>
              <p className="text-xs text-muted">{c.value == null ? <Badge tone="warning">Ausente</Badge> : `Atualizado ${dateTime(c.updated_at)} · fonte: ${c.source}`}</p></div>
            <Field label={c.unit === 'percent' ? '%' : 'Centavos'}><Input name="value" defaultValue={c.value ?? ''} inputMode="decimal" disabled={!can('costs_manage')} /></Field>
            <Field label="Fonte"><Input name="source" defaultValue={c.source ?? ''} maxLength={300} disabled={!can('costs_manage')} /></Field>
            {can('costs_manage') && <Button type="submit" variant="secondary">Salvar</Button>}
          </form>))}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Política de cobertura de orçamento</h2>
        <p className="text-sm text-muted">Desconto sugerido: {data.policy.discount_pct}% abaixo do orçamento elegível, respeitando o piso (custo + margem mínima). Sugestão nunca é promessa: a proposta só vale após envio pelo responsável.</p>
        <p className="text-sm">Campanha pública: <Badge tone={data.policy.campaign_active ? 'success' : 'neutral'}>{data.policy.campaign_active ? 'Ativa' : 'Desligada'}</Badge></p>
        {can('costs_manage') && (
          <form className="grid gap-2" onSubmit={e => {
            e.preventDefault(); const f = new FormData(e.currentTarget);
            setPending({ action: 'policy_set', target: 'policy', title: 'Política de cobertura', data: {
              discount_pct: Number(String(f.get('discount_pct')).replace(',', '.')), campaign_active: f.get('campaign_active') === 'on', criteria_text: String(f.get('criteria_text') || '') } });
          }}>
            <Field label="Desconto sugerido (%)"><Input name="discount_pct" defaultValue={data.policy.discount_pct} inputMode="decimal" /></Field>
            <Field label="Critérios e exclusões (obrigatório para campanha pública)">
              <textarea name="criteria_text" rows={3} defaultValue={data.policy.criteria_text ?? ''} className={`${inputCls} py-2`} />
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="campaign_active" defaultChecked={data.policy.campaign_active} /> Campanha pública ativa</label>
            <div><Button type="submit" variant="secondary">Revisar alteração</Button></div>
          </form>
        )}
      </Card>

      {pending && (
        <Modal title={pending.title} onClose={() => !busy && setPending(null)}>
          <div className="space-y-3">
            <pre className="text-xs bg-surface-2 rounded-lg p-2 overflow-x-auto">{JSON.stringify(pending.data, null, 2)}</pre>
            <Field label="Justificativa (registrada na auditoria)" hint="Mínimo de 10 caracteres. Não inclua segredos.">
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
