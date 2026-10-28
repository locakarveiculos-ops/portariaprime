import React, { useCallback, useEffect, useState } from 'react';
import { friendly, rpc } from '../lib/api';
import { brl, dateTime, download, toCsv } from '../lib/format';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';
import { PLATFORM_SECTIONS, PlatformSection, searchPlatformHelp } from '../lib/platform-help';
import ActionDialog from './admin/ActionDialog';
import MfaSettings from './admin/MfaSettings';
import OwnerTour from './admin/OwnerTour';
import TenantDetailModal from './admin/TenantDetailModal';
import SupportPanel from './admin/SupportPanel';
import SupportSettings from './admin/SupportSettings';
import OrganizationsPanel from './admin/OrganizationsPanel';
import DevicesPanel from './admin/DevicesPanel';
import QuotesPanel from './admin/QuotesPanel';
import CostsPanel from './admin/CostsPanel';
import LegalPanel from './admin/LegalPanel';
import { ACTION_LABELS, PlatformContext, Row, UUID, rowActions } from './admin/platform-model';

const COLUMNS: Record<string, [string, string][]> = {
  tenants: [['name', 'Condomínio'], ['slug', 'Endereço'], ['status', 'Situação'], ['plan_code', 'Plano'], ['subscription_status', 'Assinatura'], ['commercial_state', 'Acesso comercial'], ['trial_ends_at', 'Fim do teste'], ['period_end', 'Fim do período pago']],
  trials: [['name', 'Condomínio'], ['trial_state', 'Teste'], ['trial_ends_at', 'Fim do teste'], ['status', 'Situação'], ['plan_code', 'Plano']],
  plans: [['name', 'Plano'], ['code', 'Código'], ['published', 'Publicado'], ['prices', 'Preços atuais'], ['entitlements', 'Franquias']],
  orders: [['tenant_id', 'Condomínio'], ['status', 'Situação'], ['amount_cents', 'Valor'], ['cycle', 'Ciclo'], ['kind', 'Tipo'], ['paid_at', 'Pagamento'], ['created_at', 'Criação']],
  incidents: [['order_id', 'Pedido'], ['kind', 'Tipo'], ['resolved_at', 'Resolução'], ['created_at', 'Criação']],
  users: [['full_name', 'Nome'], ['email', 'E-mail protegido'], ['tenant_id', 'Condomínio'], ['user_id', 'Usuário'], ['role', 'Papel local'], ['status', 'Vínculo']],
  team: [['full_name', 'Nome'], ['email', 'E-mail protegido'], ['role', 'Papel global'], ['active', 'Ativo']],
  notifications: [['tenant_id', 'Condomínio'], ['event', 'Evento'], ['channel', 'Canal'], ['recipient', 'Destinatário protegido'], ['status', 'Situação'], ['attempts', 'Tentativas'], ['next_attempt_at', 'Próxima tentativa']],
  contacts: [['name', 'Nome'], ['email', 'E-mail protegido'], ['phone', 'Telefone protegido'], ['source', 'Origem'], ['status', 'Atendimento'], ['created_at', 'Criação']],
  audit: [['actor_id', 'Ator'], ['action', 'Ação'], ['target_type', 'Tipo do alvo'], ['target_id', 'Alvo'], ['created_at', 'Horário']],
};
const METRICS: [string, string][] = [['tenants_total', 'Condomínios'], ['tenants_active', 'Condomínios ativos'], ['trial_active', 'Testes ativos'], ['trial_expired', 'Testes expirados'], ['paid_cents', 'Pagamentos confirmados no período'], ['orders_pending', 'Pedidos pendentes'], ['incidents_open', 'Incidentes abertos'], ['jobs_failed', 'Avisos com falha'], ['contacts_total', 'Contatos']];
const FUNNEL_LABEL: Record<string, string> = { landing_view: 'Visitaram a página', pricing_view: 'Viram os planos', cta_trial_click: 'Clicaram em testar', signup_started: 'Abriram cadastro', signup_completed: 'Criaram conta', trial_started: 'Ativaram o teste' };
const DEFAULT_FILTERS = { query: '', status: '', tenant: '', from: '', to: '' };
type Filters = typeof DEFAULT_FILTERS;
function display(key: string, value: unknown): string {
  if (value == null) return '—';
  if (key === 'amount_cents') return brl(Number(value));
  if (key.endsWith('_at') || ['trial_ends_at', 'period_end'].includes(key)) return dateTime(String(value));
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (key === 'prices' && Array.isArray(value)) return value.map(p => `${p.cycle}: ${brl(p.amount_cents)}`).join(' · ') || 'Sem preços';
  if (key === 'entitlements' && typeof value === 'object') return Object.entries(value).filter(([k]) => /^(max_units|max_concierges|ocr_monthly|whatsapp_monthly|storage_mb|feature_ocr|feature_whatsapp|feature_totem|feature_reports_plus)$/.test(k)).map(([k, v]) => `${k}: ${typeof v === 'boolean' ? v ? 'Sim' : 'Não' : v}`).join(' · ');
  return typeof value === 'object' ? '—' : String(value);
}
function Funnel({ from, to }: { from: string; to: string }) {
  const [rows, setRows] = useState<{ event: string; visitors: number }[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setRows(null); setError('');
    rpc('funnel_summary', { p_from: from || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10), p_to: to || new Date().toISOString().slice(0, 10) }).then(data => { if (active) setRows(data); }).catch(e => { if (active) setError(friendly(e)); });
    return () => { active = false; };
  }, [from, to]);
  return <Card className="space-y-3"><h2 className="font-semibold">Funil da landing</h2><p className="text-sm text-muted">Visitantes anônimos únicos por etapa; não equivale a vendas. Sem período selecionado: últimos 30 dias.</p>{error ? <Alert tone="danger">{error}</Alert> : !rows ? <Spinner /> : <dl className="space-y-2">{Object.entries(FUNNEL_LABEL).map(([key, label]) => <div key={key} className="flex justify-between gap-4 border-b border-line py-1"><dt>{label}</dt><dd className="font-semibold tabular-nums">{rows.find(item => item.event === key)?.visitors ?? 0}</dd></div>)}</dl>}</Card>;
}

export default function AdminPage() {
  const [context, setContext] = useState<PlatformContext | null>(null);
  const [contextError, setContextError] = useState('');
  const [contextVersion, setContextVersion] = useState(0);
  const [section, setSection] = useState<PlatformSection>('overview');
  const [source, setSource] = useState('tenants');
  const [orderTab, setOrderTab] = useState('orders');
  const [draft, setDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ rows: Row[]; total: number } | null>(null);
  const [overview, setOverview] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filterError, setFilterError] = useState('');
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState<{ name: string; row: Row } | null>(null);
  const [detailTenant, setDetailTenant] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [helpQuery, setHelpQuery] = useState('');
  const can = (name: string) => context?.capabilities.includes(name) === true;
  const listSection = section === 'orders' ? orderTab : section === 'reports' ? source : section;
  const navigate = useCallback((next: PlatformSection) => { setSection(next); setPage(0); setResult(null); setOverview(null); setError(''); setFilterError(''); setDraft(DEFAULT_FILTERS); setFilters(DEFAULT_FILTERS); setNotice(''); }, []);
  useEffect(() => {
    let active = true; setContext(null); setContextError('');
    rpc<PlatformContext>('platform_context').then(data => {
      if (!active) return;
      if (!data || !Array.isArray(data.capabilities)) throw new Error('Contexto da plataforma inválido.');
      setContext(data);
      setSource(Object.keys(COLUMNS).find(name => data.capabilities.includes(name)) || 'tenants');
      setOrderTab(data.capabilities.includes('orders') ? 'orders' : 'incidents');
    }).catch(e => { if (active) setContextError(friendly(e)); });
    return () => { active = false; };
  }, [contextVersion]);
  useEffect(() => {
    if (!context) return;
    let active = true; setResult(null); setOverview(null); setError('');
    if (['help', 'settings', 'support', 'organizations', 'quotes', 'costs', 'legal'].includes(section)) { setLoading(false); return; }
    if (!context.capabilities.includes(section === 'overview' ? 'overview' : listSection)) { setLoading(false); return; }
    setLoading(true);
    const request = section === 'overview'
      ? rpc<Row>('platform_overview', { p_from: filters.from || null, p_to: filters.to || null })
      : rpc<{ rows: Row[]; total: number }>('platform_list', { p_section: listSection, p_query: filters.query, p_status: filters.status, p_tenant: filters.tenant || null, p_page: page, p_from: filters.from || null, p_to: filters.to || null });
    request.then(data => {
      if (!active) return;
      if (section === 'overview') setOverview(data);
      else {
        if (!Array.isArray(data.rows) || !Number.isFinite(data.total) || data.rows.length > 25) throw new Error('Resposta de listagem inválida.');
        setResult(data as { rows: Row[]; total: number });
      }
    }).catch(e => { if (active) setError(friendly(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [context, section, listSection, filters, page, version]);
  if (contextError) return <main className="max-w-4xl mx-auto p-4 space-y-4"><Alert tone="danger">{contextError}</Alert><Button onClick={() => setContextVersion(v => v + 1)}>Tentar novamente</Button><a href="/app" className="underline block">Voltar aos condomínios</a></main>;
  if (!context) return <Spinner label="Verificando acesso global…" />;
  if (!context.role) return <main className="p-4"><Alert tone="danger">Sua conta não tem acesso global à plataforma.</Alert><a href="/app" className="underline">Voltar aos condomínios</a></main>;
  const readable = Object.keys(COLUMNS).filter(name => can(name));
  const visibleSections = PLATFORM_SECTIONS.filter(([name]) => ['help', 'settings', 'reports'].includes(name) || can(name) || name === 'orders' && can('incidents'));
  const columns = [['id', 'ID'], ...(COLUMNS[listSection] || [])] as [string, string][];
  return <main className="max-w-7xl mx-auto px-4 py-6 sm:py-8 space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-2"><PortariaPrimeLogo /><h1 className="text-2xl font-semibold">Administração global</h1><p className="text-sm text-muted">Portaria Prime · <Badge>{context.role}</Badge></p></div><a href="/app" className="underline min-h-11 inline-flex items-center">Voltar aos condomínios</a></header>
    <Alert>Somente metadados autorizados. Acesso global não permite consultar fotos, assinaturas ou conteúdo de encomendas dos clientes.</Alert>
    <nav data-tour="platform-navigation" aria-label="Áreas da administração global" className="flex flex-wrap gap-2">{visibleSections.map(([name, label]) => <Button key={name} variant={section === name ? 'primary' : 'secondary'} aria-current={section === name ? 'page' : undefined} onClick={() => navigate(name)}>{label}</Button>)}</nav>
    {context.role === 'owner' && <OwnerTour key={context.user_id} userId={context.user_id} onNavigate={navigate} />}
    {notice && <Alert tone="success">{notice}</Alert>}
    <h2 className="text-xl font-semibold">{PLATFORM_SECTIONS.find(([key]) => key === section)?.[1]}</h2>
    {section === 'support' && can('support') ? <><SupportPanel context={context} />{can('support_manage') && <SupportSettings context={context} />}</>
      : section === 'organizations' && can('organizations') ? <OrganizationsPanel context={context} />
      : section === 'devices' && can('devices') ? <DevicesPanel context={context} />
      : section === 'quotes' && can('quotes') ? <QuotesPanel capabilities={context.capabilities} />
      : section === 'costs' && can('costs') ? <CostsPanel capabilities={context.capabilities} />
      : section === 'legal' && can('legal') ? <LegalPanel canManage={can('legal_manage')} />
      : section === 'help' ? <Card className="space-y-4"><Field label="Pesquisar ajuda"><Input type="search" value={helpQuery} onChange={e => setHelpQuery(e.target.value)} placeholder="Teste, senha, planos, auditoria…" /></Field><div aria-live="polite" className="space-y-3">{searchPlatformHelp(helpQuery).map(item => <article key={item.section} className="border-t border-line pt-3 space-y-1"><h3 className="font-semibold">{item.title}</h3><p className="text-sm text-muted">{item.text}</p>{visibleSections.some(([name]) => name === item.section) && item.section !== 'help' && <Button variant="ghost" onClick={() => navigate(item.section)}>Abrir área</Button>}</article>)}{searchPlatformHelp(helpQuery).length === 0 && <p>Nenhum tópico encontrado. Tente outro termo.</p>}</div></Card> : section === 'settings' ? <><MfaSettings /><Alert>Integrações, segredos e configurações de infraestrutura não são editáveis neste painel.</Alert></> : <>
      {section === 'reports' && <Card className="space-y-3"><p>Relatórios de metadados autorizados. CSV contém somente a página carregada, até 25 registros; não é exportação da base inteira.</p><Field label="Fonte do relatório"><Select value={source} onChange={e => { setSource(e.target.value); setPage(0); setResult(null); }}>{readable.map(name => <option key={name} value={name}>{name === 'incidents' ? 'Incidentes' : PLATFORM_SECTIONS.find(([key]) => key === name)?.[1] || name}</option>)}</Select></Field></Card>}
      {section === 'orders' && <div className="flex gap-2">{['orders', 'incidents'].filter(can).map(name => <Button key={name} variant={orderTab === name ? 'primary' : 'secondary'} onClick={() => { setOrderTab(name); setPage(0); setResult(null); }}>{name === 'orders' ? 'Pedidos' : 'Incidentes financeiros'}</Button>)}</div>}
      <Card data-tour="platform-filters"><form className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 items-end" onSubmit={e => {
        e.preventDefault(); setFilterError('');
        if (draft.tenant && !UUID.test(draft.tenant)) { setFilterError('Informe um ID de condomínio válido (UUID).'); return; }
        if (draft.from && draft.to && draft.from > draft.to) { setFilterError('Início deve ser anterior ou igual ao fim.'); return; }
        setPage(0); setResult(null); setFilters({ ...draft }); setVersion(v => v + 1);
      }}>
        {section !== 'overview' && <><Field label="Busca"><Input type="search" maxLength={120} value={draft.query} onChange={e => setDraft(d => ({ ...d, query: e.target.value }))} /></Field><Field label="Situação exata" hint="Vazio inclui todas as situações autorizadas."><Input maxLength={40} value={draft.status} onChange={e => setDraft(d => ({ ...d, status: e.target.value }))} placeholder="Ex.: active, failed, novo" /></Field><Field label="ID do condomínio"><Input value={draft.tenant} onChange={e => setDraft(d => ({ ...d, tenant: e.target.value.trim() }))} placeholder="UUID (opcional)" /></Field></>}
        <Field label="De (UTC)"><Input type="date" value={draft.from} max={draft.to || undefined} onChange={e => setDraft(d => ({ ...d, from: e.target.value }))} /></Field><Field label="Até (UTC, inclusivo)"><Input type="date" value={draft.to} min={draft.from || undefined} onChange={e => setDraft(d => ({ ...d, to: e.target.value }))} /></Field><div className="flex gap-2"><Button type="submit" loading={loading}>Aplicar filtros</Button><Button type="button" variant="ghost" onClick={() => { setDraft(DEFAULT_FILTERS); setFilters(DEFAULT_FILTERS); setPage(0); setResult(null); setFilterError(''); }}>Limpar</Button></div>
      </form>{filterError && <Alert tone="danger">{filterError}</Alert>}</Card>
      {error && <div className="space-y-2"><Alert tone="danger">{error}</Alert><Button variant="secondary" onClick={() => setVersion(v => v + 1)}>Tentar carregar novamente</Button></div>}
      <section data-tour="platform-results" aria-label="Resultados autorizados" aria-busy={loading} className="space-y-4">
        {loading ? <Spinner /> : section === 'overview' ? overview ? <><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">{METRICS.filter(([key]) => overview[key] != null).map(([key, label]) => <Card key={key}><p className="text-sm text-muted">{label}</p><p className="text-2xl font-semibold tabular-nums mt-2">{key === 'paid_cents' ? brl(Number(overview[key])) : String(overview[key])}</p></Card>)}</div><p className="text-xs text-muted">Totais operacionais representam o estado atual; pagamento confirmado respeita o período selecionado. Nenhum valor é estimado.</p></> : !error && <Alert>Visão geral não autorizada para este papel. Escolha uma área disponível.</Alert> : result ? <>
          <div className="flex flex-wrap justify-between gap-3 items-center"><p className="text-sm" role="status">{result.total} registro(s) · página {page + 1} de {Math.max(1, Math.ceil(result.total / 25))} · até 25 por página</p><Button variant="secondary" disabled={!result.rows.length} onClick={() => {
            const safeRows = result.rows.map(row => Object.fromEntries(columns.map(([key]) => [key, display(key, row[key])])));
            download(`plataforma-${listSection}-pagina-${page + 1}.csv`, toCsv(safeRows, columns));
          }}>Exportar esta página CSV</Button></div>
          {result.rows.length === 0 ? <Card>Nenhum registro para os filtros aplicados.</Card> : <div className="space-y-3">{result.rows.map((row, index) => <Card key={String(row.id || index)} className="space-y-3"><dl className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">{columns.map(([key, label]) => <div key={key} className="min-w-0"><dt className="text-muted">{label}</dt><dd className="break-words whitespace-pre-wrap">{display(key, row[key])}</dd></div>)}</dl><div className="flex flex-wrap gap-2 border-t border-line pt-3">{['tenants', 'trials'].includes(listSection) && <Button variant="secondary" onClick={() => setDetailTenant(String(row.id || row.tenant_id))}>Ver detalhes</Button>}{section !== 'reports' && rowActions(listSection, row, context).map(name => <Button key={name} variant="secondary" onClick={() => setAction({ name, row })}>{ACTION_LABELS[name]}</Button>)}</div></Card>)}</div>}
          <div className="flex justify-between gap-3"><Button variant="secondary" disabled={page === 0} onClick={() => { setResult(null); setPage(p => p - 1); }}>Página anterior</Button><Button variant="secondary" disabled={(page + 1) * 25 >= result.total} onClick={() => { setResult(null); setPage(p => p + 1); }}>Próxima página</Button></div>
        </> : !error && <Alert>Esta consulta não está autorizada para seu papel. Escolha uma fonte disponível.</Alert>}
      </section>
      {section === 'overview' && context.role === 'owner' && <Funnel from={filters.from} to={filters.to} />}
    </>}
    {action && <ActionDialog action={action.name} row={action.row} onClose={() => setAction(null)} onDone={message => { setAction(null); setNotice(message); setResult(null); setVersion(v => v + 1); }} />}
    {detailTenant && <TenantDetailModal tenantId={detailTenant} context={context} onClose={() => setDetailTenant(null)} onAction={(name, row) => { setAction({ name, row }); }} />}
  </main>;
}
