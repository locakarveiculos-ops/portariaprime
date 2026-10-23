import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LifeBuoy, Plus } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { navigate, query } from '../../lib/router';
import { dateTime } from '../../lib/format';
import { articlesFor, searchArticles } from '../../lib/help';
import { Alert, Badge, Button, Card, Empty, Field, Input, Select, Spinner, inputCls, useAction } from '../../components/ui';

export const SUPPORT_STATUS: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger' | 'accent']> = {
  aberto: ['Aberto', 'accent'], em_atendimento: ['Em atendimento', 'accent'], aguardando_cliente: ['Aguardando sua resposta', 'warning'],
  resolvido: ['Resolvido', 'success'], encerrado: ['Encerrado', 'neutral'],
};
export const SUPPORT_CATEGORY: Record<string, string> = {
  encomendas: 'Encomendas e retiradas', moradores: 'Moradores e unidades', equipe: 'Equipe e permissões', totem: 'Totem',
  avisos: 'Avisos e notificações', cobranca: 'Plano e cobrança', acesso: 'Acesso e login', outro: 'Outro assunto',
};
export const SUPPORT_PRIORITY: Record<string, string> = { baixa: 'Baixa', normal: 'Normal', alta: 'Alta', urgente: 'Urgente' };
// Aviso apenas (não bloqueia): mensagens que parecem conter senha.
const looksLikePassword = (s: string) => /\b(senha|password|pwd)\s*[:=é]/i.test(s);
// Versão do app (opcional, definida no build). Nada é coletado automaticamente além da rota.
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) || null;

type Ticket = { id: string; protocol: string; subject: string; category: string; kind: string; priority: string; status: string;
  created_at: string; updated_at: string; opener_name: string; opened_by_me: boolean; messages?: Message[] };
type Message = { id: number; side: 'cliente' | 'equipe'; body: string; created_at: string; author: string; mine: boolean };

/** Suporte da plataforma para a equipe do condomínio: chamados com protocolo e conversa. */
export function SupportPage() {
  const t = useTenant();
  const [list, setList] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(query('chamado'));
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => rpc<Ticket[]>('support_my_tickets', { p_tenant: t.tenant.id })
    .then((r) => { setList(r); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const on = () => setSelected(query('chamado'));
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const base = `/c/${t.tenant.slug}/suporte`;
  const open = (id: string | null) => navigate(id ? `${base}?chamado=${id}` : base);

  if (!t.isStaff) return <Alert tone="info">Dúvidas sobre encomendas e cadastro são atendidas pela portaria e pela administração do seu condomínio.</Alert>;
  if (selected) return <TicketView id={selected} onBack={() => { open(null); load(); }} />;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Suporte Portaria Prime</h1><p className="text-sm text-muted mt-1">Chamados com protocolo para a equipe da plataforma.</p></div>
        {!creating && <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> Novo chamado</Button>}
      </div>
      <ServiceHours />
      {creating && <NewTicket onCancel={() => setCreating(false)} onCreated={(id) => { setCreating(false); load(); open(id); }} />}
      {error ? <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>
        : !list ? <Spinner /> : list.length === 0 ? <Card><Empty title="Nenhum chamado ainda">Antes de abrir, confira a Central de ajuda: muitas dúvidas têm passo a passo.</Empty></Card> : (
          <ul className="rounded-2xl border border-line bg-surface divide-y divide-line">
            {list.map((x) => (
              <li key={x.id}>
                <a href={`${base}?chamado=${x.id}`} onClick={(e) => { e.preventDefault(); open(x.id); }} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 min-h-12 hover:bg-surface-2">
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-muted">{x.protocol}</span>
                    <span className="block font-medium">{x.subject}</span>
                    <span className="block text-xs text-muted">{SUPPORT_CATEGORY[x.category] || x.category} · {x.opened_by_me ? 'aberto por você' : `aberto por ${x.opener_name}`} · atualizado {dateTime(x.updated_at, t.tenant.timezone)}</span>
                  </span>
                  <Badge tone={SUPPORT_STATUS[x.status]?.[1] || 'neutral'}>{SUPPORT_STATUS[x.status]?.[0] || x.status}</Badge>
                </a>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

/** Horário e canais vêm da plataforma; sem configuração não inventamos nada. */
function ServiceHours() {
  const [s, setS] = useState<{ hours: string | null; channels: string | null; first_response_target: string | null } | null | undefined>(undefined);
  useEffect(() => { rpc('support_settings_get').then(setS).catch(() => setS(null)); }, []);
  if (s === undefined) return null;
  return (
    <Card className="text-sm space-y-1">
      <p><strong>Horário de atendimento:</strong> {s?.hours || 'Horário de atendimento a definir'}</p>
      {s?.channels && <p><strong>Canais:</strong> {s.channels}</p>}
      {s?.first_response_target && <p><strong>Prazo de primeira resposta:</strong> {s.first_response_target}</p>}
      <p className="text-xs text-muted">A equipe da Portaria Prime nunca pede sua senha.</p>
    </Card>
  );
}

function NewTicket({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const t = useTenant();
  const [f, setF] = useState({ subject: '', category: 'encomendas', kind: 'operacional', priority: 'normal', body: '' });
  const [checked, setChecked] = useState(false);
  const { busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => { setF({ ...f, [k]: e.target.value }); setChecked(false); };
  const suggestions = useMemo(() => {
    const words = `${f.subject} ${f.body}`.split(/\s+/).filter((w) => w.length > 3).slice(0, 12);
    if (!words.length) return [];
    const mine = articlesFor(t.link.role);
    // Qualquer palavra relevante já sugere (busca por termo, tolerante a acentos e sinônimos).
    const hits = new Map<string, ReturnType<typeof articlesFor>[number]>();
    for (const w of words) for (const a of searchArticles(mine, w)) if (a.slug !== 'suporte') hits.set(a.slug, a);
    return Array.from(hits.values()).slice(0, 4);
  }, [f.subject, f.body, t.link.role]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Primeiro envio mostra artigos relacionados; segundo envio confirma. Nunca bloqueia.
    if (suggestions.length && !checked) { setChecked(true); return; }
    run(async () => {
      const r = await rpc<{ id: string; protocol: string }>('support_open', {
        p_tenant: t.tenant.id, p_kind: f.kind, p_subject: f.subject, p_category: f.category, p_body: f.body, p_priority: f.priority,
        p_route: location.pathname, p_app_version: APP_VERSION,
      });
      onCreated(r.id);
      return r;
    }, 'Chamado aberto. Acompanhe por aqui.');
  };
  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <h2 className="font-semibold">Novo chamado</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Assunto"><Input required minLength={3} maxLength={140} value={f.subject} onChange={set('subject')} /></Field>
          <Field label="Tema"><Select value={f.category} onChange={set('category')}>{Object.entries(SUPPORT_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Tipo"><Select value={f.kind} onChange={set('kind')}><option value="operacional">Operacional (uso do sistema)</option><option value="comercial">Comercial (plano, contrato)</option></Select></Field>
          <Field label="Prioridade" hint="Urgência é definida pela equipe de suporte."><Select value={f.priority} onChange={set('priority')}><option value="baixa">Baixa</option><option value="normal">Normal</option><option value="alta">Alta — operação parada</option></Select></Field>
        </div>
        <Field label="Mensagem" hint="Descreva a tela, o que tentou fazer e a mensagem de erro. Não envie senhas nem dados de moradores.">
          <textarea required maxLength={4000} rows={5} className={`${inputCls} py-2`} value={f.body} onChange={set('body')} />
        </Field>
        {looksLikePassword(f.body) && <Alert tone="warning">Parece que a mensagem contém uma senha. Remova antes de enviar: a equipe nunca pede senha.</Alert>}
        {checked && suggestions.length > 0 && (
          <Alert>
            <p className="font-medium">Estes artigos podem resolver agora:</p>
            <ul className="list-disc pl-5">{suggestions.map((a) => <li key={a.slug}><a className="underline" href={`/c/${t.tenant.slug}/ajuda?artigo=${a.slug}`} target="_blank" rel="noopener">{a.title}</a></li>)}</ul>
            <p className="mt-1">Se não resolver, toque em “Enviar mesmo assim”.</p>
          </Alert>
        )}
        <p className="text-xs text-muted">Junto com o chamado registramos só a tela em que você está e a versão do app. Nada mais é coletado automaticamente.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy}>{checked && suggestions.length ? 'Enviar mesmo assim' : 'Abrir chamado'}</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>
        </div>
      </form>
    </Card>
  );
}

function TicketView({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTenant();
  const [tk, setTk] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const { busy, run } = useAction();
  const load = useCallback(() => rpc<Ticket>('support_ticket', { p_ticket: id }).then((r) => { setTk(r); setError(null); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const closed = tk?.status === 'encerrado';
  return (
    <section className="space-y-4 max-w-3xl">
      <button className="inline-flex items-center gap-1 text-sm underline min-h-11" onClick={onBack}><ArrowLeft className="w-4 h-4" /> Meus chamados</button>
      {error ? <Alert tone="danger">{error}</Alert> : !tk ? <Spinner /> : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="font-mono text-xs text-muted">{tk.protocol}</p><h1 className="text-xl font-semibold">{tk.subject}</h1>
              <p className="text-xs text-muted">{SUPPORT_CATEGORY[tk.category] || tk.category} · prioridade {SUPPORT_PRIORITY[tk.priority]?.toLowerCase()} · aberto {dateTime(tk.created_at, t.tenant.timezone)}</p></div>
            <Badge tone={SUPPORT_STATUS[tk.status]?.[1] || 'neutral'}>{SUPPORT_STATUS[tk.status]?.[0] || tk.status}</Badge>
          </div>
          <ol className="space-y-3" aria-label="Conversa">
            {tk.messages!.map((m) => (
              <li key={m.id} className={`rounded-2xl border border-line p-3 ${m.side === 'equipe' ? 'bg-surface-2' : 'bg-surface'}`}>
                <p className="text-xs text-muted mb-1">{m.side === 'equipe' ? <><LifeBuoy className="inline w-3 h-3" aria-hidden /> {m.author}</> : m.mine ? 'Você' : m.author} · {dateTime(m.created_at, t.tenant.timezone)}</p>
                <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p>
              </li>
            ))}
          </ol>
          {closed ? <Alert>Chamado encerrado. Se precisar, abra um novo chamado citando o protocolo {tk.protocol}.</Alert> : (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await rpc('support_reply', { p_ticket: id, p_body: body }); setBody(''); await load(); }, 'Resposta enviada.'); }}>
              <Field label="Responder" hint="Não envie senhas."><textarea required maxLength={4000} rows={3} className={`${inputCls} py-2`} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
              {looksLikePassword(body) && <Alert tone="warning">Parece que a mensagem contém uma senha. Remova antes de enviar.</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={busy}>Enviar resposta</Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => confirm('Encerrar este chamado? Não será possível responder depois.') && run(async () => { await rpc('support_close', { p_ticket: id }); await load(); }, 'Chamado encerrado.')}>Encerrar chamado</Button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
