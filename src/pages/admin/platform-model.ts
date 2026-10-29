export type Row = Record<string, any>;
export type PlatformContext = { user_id: string; role: string | null; capabilities: string[] };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LIMITS = ['max_units', 'max_concierges', 'ocr_monthly', 'whatsapp_monthly', 'storage_mb'] as const;
export const FEATURES = ['feature_ocr', 'feature_whatsapp', 'feature_totem', 'feature_reports_plus'] as const;
export const ACTION_LABELS: Record<string, string> = {
  tenant_status: 'Alterar situação', trial_extend: 'Estender teste', membership_status: 'Alterar vínculo',
  team_role: 'Alterar equipe global', incident_resolve: 'Resolver incidente', notification_retry: 'Repetir aviso',
  plan_limits: 'Editar franquias', plan_publish: 'Publicação do catálogo', plan_price: 'Versionar preço',
  contact_status: 'Atualizar atendimento', password_reset: 'Enviar redefinição de senha',
  courtesy_grant: 'Conceder cortesia temporária', courtesy_revoke: 'Revogar cortesia',
  plan_change: 'Trocar plano contratado', contact_reveal: 'Ver contato completo',
};
/** Ações que não são capacidades próprias: exigem a capacidade indicada. */
const ACTION_CAPABILITY: Record<string, string> = { contact_reveal: 'contact_status' };
export const ACTION_EFFECTS: Record<string, string> = {
  tenant_status: 'Altera acesso operacional ao condomínio. Não confirma pagamento.',
  trial_extend: 'Define o prazo final absoluto. Reativação de teste expirado exige escolha explícita.',
  membership_status: 'Altera somente este vínculo com o condomínio; não bloqueia a conta global.',
  team_role: 'Altera privilégios globais deste usuário. O servidor protege o último proprietário.',
  incident_resolve: 'Encerra o incidente. NÃO ativa assinatura, não quita pedido e não confirma Pix.',
  notification_retry: 'Solicita nova tentativa de um aviso terminal. Não garante entrega.',
  plan_limits: 'Altera franquias para novas contratações. Assinaturas existentes preservam seus limites contratados.',
  plan_change: 'Altera o plano e ciclo do condomínio no servidor. Valida limites existentes e cancela pedidos abertos sem conciliação externa pendente.',
  courtesy_grant: 'Concede acesso comercial temporário no intervalo informado. Não confirma pagamento nem reativa condomínio suspenso.',
  courtesy_revoke: 'Revoga esta concessão de acesso temporário; não altera pagamentos nem outras concessões.',
  plan_publish: 'Altera a disponibilidade do plano no catálogo público para contratação.',
  plan_price: 'Cria uma versão de preço para o ciclo; não modifica pedidos pagos retroativamente.',
  contact_status: 'Atualiza a situação do atendimento.',
  password_reset: 'Solicita e-mail de recuperação pelo fluxo oficial. Nenhuma senha será exibida.',
  contact_reveal: 'Mostra e-mail e telefone completos deste contato para retorno. A consulta e a justificativa ficam na auditoria. Não copie o dado para fora dos canais de atendimento.',
};
export function rowActions(section: string, row: Row, ctx: PlatformContext): string[] {
  const actions = section === 'tenants' ? ['tenant_status'] : section === 'trials' ? ['trial_extend']
    : section === 'users' ? [...(row.tenant_id && row.status !== 'unassigned' ? ['membership_status'] : []), 'password_reset', 'team_role'] : section === 'team' ? ['team_role']
    : section === 'incidents' && !row.resolved_at ? ['incident_resolve']
    : section === 'notifications' && row.status === 'failed' && row.retryable === true ? ['notification_retry']
    : section === 'plans' ? ['plan_publish', 'plan_price', 'plan_limits']
    : section === 'contacts' ? ['contact_status', 'contact_reveal'] : [];
  return actions.filter(action => ctx.capabilities.includes(ACTION_CAPABILITY[action] || action));
}
export function actionData(action: string, form: FormData, row: Row): Row {
  if (action === 'plan_change') {
    const plan = String(form.get('plan_code') || '').trim();
    const cycle = String(form.get('cycle') || '').trim();
    if (!plan || !['monthly', 'quarterly', 'yearly'].includes(cycle)) throw new Error('Selecione plano e ciclo válidos.');
    return { plan_code: plan, cycle };
  }
  if (action === 'notification_retry') {
    if (form.get('delivery_confirmed_failed') !== 'on') throw new Error('Confirme a falha definitiva antes de solicitar nova tentativa.');
    return { delivery_confirmed_failed: true };
  }
  if (action === 'courtesy_grant') {
    const starts = new Date(String(form.get('starts_at'))), ends = new Date(String(form.get('ends_at')));
    if (!Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts || ends.getTime() <= Date.now()) throw new Error('Informe intervalo válido com fim futuro.');
    return { starts_at: starts.toISOString(), ends_at: ends.toISOString() };
  }
  if (action === 'trial_extend') {
    const ends = new Date(String(form.get('ends_at')));
    if (!Number.isFinite(ends.getTime()) || ends.getTime() <= Date.now()) throw new Error('Informe uma data futura válida.');
    if (row.trial_ends_at && ends.getTime() <= new Date(row.trial_ends_at).getTime()) throw new Error('O novo prazo deve ser posterior ao prazo atual.');
    if (!['active', 'expired'].includes(row.trial_state)) throw new Error('Este condomínio não possui teste elegível.');
    if (row.trial_state === 'expired' && form.get('reactivate') !== 'on') throw new Error('Confirme explicitamente a reativação do teste expirado.');
    return { ends_at: ends.toISOString(), trial_state: row.trial_state };
  }
  if (['tenant_status', 'membership_status', 'contact_status'].includes(action)) return { status: String(form.get('status')) };
  if (action === 'team_role') return { role: String(form.get('role')), active: form.get('active') === 'on' };
  if (action === 'plan_publish') return { published: form.get('published') === 'on' };
  if (action === 'plan_price') {
    const amount = Number(form.get('amount_cents'));
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Preço deve ser inteiro positivo em centavos.');
    return { cycle: String(form.get('cycle')), amount_cents: amount };
  }
  if (action === 'plan_limits') {
    const data: Row = {};
    for (const key of LIMITS) {
      const raw = String(form.get(key) ?? '');
      const value = Number(raw);
      if (!raw || !Number.isSafeInteger(value) || value < 0) throw new Error('Franquias devem ser inteiros não negativos.');
      data[key] = value;
    }
    for (const key of FEATURES) data[key] = form.get(key) === 'on';
    return data;
  }
  return {};
}
