import React, { useRef, useState } from 'react';
import { api, friendly, rpc } from '../../lib/api';
import { Alert, Button, Field, Input, Modal, Select, inputCls } from '../../components/ui';
import { ACTION_EFFECTS, ACTION_LABELS, FEATURES, LIMITS, Row, UUID, actionData } from './platform-model';

export default function ActionDialog({ action, row, onClose, onDone }: { action: string; row: Row; onClose: () => void; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<{ data: Row; reason: string; request: string } | null>(null);
  const lock = useRef(false);
  const target = String(action === 'password_reset' || action === 'team_role' && row.user_id ? row.user_id : row.id);
  const close = () => { if (!lock.current) onClose(); };
  const submit = async () => {
    if (!review || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      if (action === 'password_reset') {
        const result = await api<{ ok: boolean; message?: string }>('/api/platform/users', { action, userId: target, reason: review.reason });
        if (result.ok !== true) throw new Error('Servidor não confirmou a solicitação.');
        onDone(result.message || 'Solicitação aceita pelo provedor. Entrega do e-mail não confirmada.');
      } else {
        const result = action === 'plan_change'
          ? await rpc<{ ok: boolean; request_id: string }>('platform_change_plan', { p_tenant: target, p_plan_code: review.data.plan_code, p_cycle: review.data.cycle, p_reason: review.reason, p_request: review.request })
          : await rpc<{ ok: boolean; request_id: string }>('platform_action', { p_action: action, p_target: target, p_reason: review.reason, p_data: review.data, p_request: review.request });
        if (result?.ok !== true || result.request_id !== review.request) throw new Error('Servidor não confirmou esta operação. Confira a auditoria antes de iniciar outra.');
        onDone(action === 'notification_retry' ? 'Nova tentativa aceita pelo servidor. Entrega ainda não confirmada.' : 'Alteração confirmada pelo servidor.');
      }
    } catch (e) { setError(friendly(e)); } finally { lock.current = false; setBusy(false); }
  };
  const labels: Record<string, string> = { max_units: 'Unidades', max_concierges: 'Portarias', ocr_monthly: 'OCR por mês', whatsapp_monthly: 'WhatsApp por mês', storage_mb: 'Armazenamento (MB)', feature_ocr: 'OCR', feature_whatsapp: 'WhatsApp', feature_totem: 'Totem', feature_reports_plus: 'Relatórios avançados' };
  return <Modal title={ACTION_LABELS[action] || action} onClose={close}>
    <div className="space-y-4">
      <p className="break-words"><strong>Alvo:</strong> {row.name || row.full_name || row.code || row.kind || row.event || 'Registro'}<br /><span className="font-mono text-xs">{target}</span>{row.tenant_id && <><br />Condomínio: <span className="font-mono text-xs">{row.tenant_id}</span></>}</p>
      <Alert tone="warning">{ACTION_EFFECTS[action]}</Alert>
      {error && <Alert tone="danger">{error} {review && action !== 'password_reset' ? 'Tentar novamente reutiliza o mesmo identificador de solicitação.' : ''}</Alert>}
      {review ? <div className="space-y-3">
        <h3 className="font-semibold">Revise antes de confirmar</h3>
        <dl className="text-sm space-y-1">{Object.entries(review.data).map(([key, value]) => <div key={key} className="break-words"><dt className="inline font-medium">{labels[key] || key}: </dt><dd className="inline">{typeof value === 'boolean' ? value ? 'Sim' : 'Não' : String(value)}</dd></div>)}</dl>
        <p className="text-sm whitespace-pre-wrap break-words"><strong>Justificativa:</strong> {review.reason}</p>
        <p className="text-xs text-muted">A ação só será concluída após validação e confirmação do servidor.</p>
        <div className="flex flex-wrap gap-2"><Button loading={busy} onClick={submit}>Confirmar no servidor</Button><Button disabled={busy} variant="secondary" onClick={close}>Cancelar</Button>{!error && <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Revisar campos</Button>}</div>
      </div> : <form className="space-y-3" onSubmit={e => {
        e.preventDefault(); setError('');
        try {
          const form = new FormData(e.currentTarget); const reason = String(form.get('reason') || '').trim();
          if (!UUID.test(target)) throw new Error('ID do alvo inválido. Atualize a lista.');
          if (reason.length < 10 || reason.length > 1000) throw new Error('Justificativa deve conter entre 10 e 1000 caracteres.');
          setReview({ data: actionData(action, form, row), reason, request: crypto.randomUUID() });
        } catch (e) { setError(friendly(e)); }
      }}>
        {action === 'plan_change' && <><Field label="Código do plano"><Select name="plan_code" defaultValue={row.plan_code || 'starter'}><option value="starter">starter</option><option value="pro">pro</option><option value="enterprise">enterprise</option></Select></Field><Field label="Ciclo"><Select name="cycle" defaultValue="monthly"><option value="monthly">Mensal</option><option value="quarterly">Trimestral</option><option value="yearly">Anual</option></Select></Field></>}
        {action === 'notification_retry' && <label className="flex gap-2 items-start"><input type="checkbox" name="delivery_confirmed_failed" required />Conferi o provedor e confirmo falha definitiva, sem entrega nem processamento pendente.</label>}
        {action === 'courtesy_grant' && <><Field label="Início da cortesia (horário local)"><Input type="datetime-local" name="starts_at" required /></Field><Field label="Fim da cortesia (horário local)"><Input type="datetime-local" name="ends_at" required /></Field></>}
        {action === 'trial_extend' && <><Field label="Novo fim do teste (horário local)"><Input type="datetime-local" name="ends_at" required /></Field>{row.trial_state === 'expired' && <label className="flex items-center gap-2"><input type="checkbox" name="reactivate" />Reativar explicitamente este teste expirado</label>}</>}
        {['tenant_status', 'membership_status', 'contact_status'].includes(action) && <Field label="Nova situação"><Select name="status" defaultValue={row.status}>{(action === 'tenant_status' ? ['active', 'suspended', 'closed'] : action === 'membership_status' ? ['active', 'revoked'] : ['novo', 'em_atendimento', 'resolvido']).map(value => <option key={value}>{value}</option>)}</Select></Field>}
        {action === 'team_role' && <><Field label="Papel global"><Select name="role" defaultValue={['owner', 'support', 'finance', 'auditor'].includes(row.role) ? row.role : 'support'}>{['owner', 'support', 'finance', 'auditor'].map(role => <option key={role}>{role}</option>)}</Select></Field><label className="flex gap-2 items-center"><input type="checkbox" name="active" defaultChecked={row.active !== false} />Acesso global ativo</label></>}
        {action === 'plan_publish' && <label className="flex gap-2 items-center"><input type="checkbox" name="published" defaultChecked={row.published} />Publicado para contratação</label>}
        {action === 'plan_price' && <><Field label="Ciclo"><Select name="cycle"><option value="monthly">Mensal</option><option value="quarterly">Trimestral</option><option value="yearly">Anual</option></Select></Field><Field label="Valor total em centavos"><Input name="amount_cents" type="number" min={1} step={1} required /></Field></>}
        {action === 'plan_limits' && <><div className="grid sm:grid-cols-2 gap-3">{LIMITS.map(key => <Field key={key} label={labels[key]}><Input name={key} type="number" min={0} step={1} required defaultValue={row.entitlements?.[key] ?? ''} /></Field>)}</div>{FEATURES.map(key => <label key={key} className="flex gap-2 items-center"><input type="checkbox" name={key} defaultChecked={row.entitlements?.[key] === true} />{labels[key]}</label>)}</>}
        <Field label="Justificativa (10–1000 caracteres)" hint="Não inclua senhas, segredos nem conteúdo de encomendas."><textarea name="reason" className={`${inputCls} py-2`} minLength={10} maxLength={1000} rows={3} required /></Field>
        <div className="flex gap-2"><Button type="submit">Revisar alteração</Button><Button type="button" variant="secondary" onClick={close}>Cancelar</Button></div>
      </form>}
    </div>
  </Modal>;
}
