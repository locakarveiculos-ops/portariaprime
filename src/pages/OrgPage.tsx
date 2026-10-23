import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Building2, Copy } from 'lucide-react';
import { rpc } from '../lib/api';
import { useSession } from '../lib/session';
import { navigate, onLink, usePath } from '../lib/router';
import { dateTime } from '../lib/format';
import { Alert, Badge, Button, Card, Empty, Field, Input, Modal, Select, Spinner, toast, useAction } from '../components/ui';
import { PortariaPrimeLogo } from '../components/Brand';

const COMMERCIAL: Record<string, [string, 'success' | 'warning' | 'danger']> = { full: ['Em dia', 'success'], grace: ['Em carência', 'warning'], restricted: ['Restrito', 'danger'] };
const LINK_STATUS: Record<string, string> = { pending: 'Aguardando aprovação do síndico', active: 'Ativo', rejected: 'Recusado', revoked: 'Encerrado' };
const ROLE: Record<string, string> = { org_admin: 'Administrador', org_viewer: 'Leitura' };
const pct = (o: { used: number; capacity: number | null } | null) => (o?.capacity ? `${Math.round((o.used / o.capacity) * 100)}%` : '—');

/** Administradoras: /org (lista), /org/{id} (carteira), /org/convite#token (aceite de convite). */
export default function OrgPage() {
  const path = usePath();
  if (path === '/org/convite') return <OrgInvite />;
  const id = path.match(/^\/org\/([0-9a-f-]{36})\/?$/i)?.[1];
  return <main className="max-w-6xl mx-auto px-4 py-6 sm:py-8 space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><PortariaPrimeLogo /><a href="/app" onClick={onLink} className="underline min-h-11 inline-flex items-center">Voltar aos condomínios</a></header>
    {id ? <OrgView id={id} /> : <OrgList />}
  </main>;
}

function OrgList() {
  const [orgs, setOrgs] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [doc, setDoc] = useState('');
  const { busy, run } = useAction();
  const load = useCallback(() => rpc<any[]>('my_orgs').then(setOrgs).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  return <>
    <h1 className="text-2xl font-semibold">Administradoras</h1>
    <p className="text-sm text-muted">Carteira consolidada dos condomínios que autorizaram sua administradora. Somente indicadores agregados: nada de moradores, fotos ou assinaturas.</p>
    {error ? <Alert tone="danger">{error}</Alert> : !orgs ? <Spinner /> : orgs.length === 0 ? <Card><Empty title="Você não participa de nenhuma administradora">Peça um convite a quem administra a sua ou cadastre uma abaixo.</Empty></Card> : (
      <ul className="grid sm:grid-cols-2 gap-3">{orgs.map((o) => <li key={o.id}><Card>
        <a href={`/org/${o.id}`} onClick={onLink} className="font-semibold underline">{o.name}</a>
        <p className="text-sm text-muted">{ROLE[o.role]} · {o.tenants_active} condomínio(s) ativo(s){o.status !== 'active' && ' · suspensa'}</p>
      </Card></li>)}</ul>
    )}
    <Card>
      <form className="grid sm:grid-cols-3 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await rpc<{ id: string }>('org_create', { p_name: name, p_document: doc || null }); navigate(`/org/${r.id}`); }, 'Administradora cadastrada.'); }}>
        <Field label="Nome da administradora"><Input required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="CNPJ ou CPF (opcional)"><Input inputMode="numeric" maxLength={18} value={doc} onChange={(e) => setDoc(e.target.value)} /></Field>
        <Button type="submit" loading={busy}>Cadastrar administradora</Button>
      </form>
    </Card>
  </>;
}

function OrgView({ id }: { id: string }) {
  const [org, setOrg] = useState<any | null>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState<string | null>(null);
  const load = useCallback(() => Promise.all([rpc('org_detail', { p_org: id }), rpc<any[]>('org_portfolio', { p_org: id })])
    .then(([o, p]) => { setOrg(o); setRows(p); setError(''); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <Alert tone="danger">{error} <a className="underline" href="/org" onClick={onLink}>Voltar</a></Alert>;
  if (!org || !rows) return <Spinner />;
  const admin = org.role === 'org_admin';
  const total = (k: string) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return <>
    <a href="/org" onClick={onLink} className="inline-flex items-center gap-1 text-sm underline min-h-11"><ArrowLeft className="w-4 h-4" /> Administradoras</a>
    <h1 className="text-2xl font-semibold flex items-center gap-2"><Building2 className="w-6 h-6" aria-hidden /> {org.name}</h1>
    <section className="space-y-3" aria-label="Carteira">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[['Condomínios', rows.length], ['Aguardando retirada', total('waiting_now')], ['Acima de 72 h', total('stale_now')], ['Falhas de aviso', total('notification_failures')]].map(([l, v]) =>
          <Card key={l as string}><p className="text-sm text-muted">{l}</p><p className="text-2xl font-semibold tabular-nums">{v}</p></Card>)}
      </div>
      {rows.length === 0 ? <Card><Empty title="Nenhum condomínio autorizou ainda">{admin ? 'Peça o vínculo abaixo; o síndico aprova em Configurações › Equipe.' : 'Aguarde a aprovação dos síndicos.'}</Empty></Card> : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted border-b border-line">{['Condomínio', 'Aguardando agora', 'Acima de 72 h', 'Ocupação', 'Falhas de aviso', 'Situação comercial', ''].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r.tenant_id} className="border-b border-line last:border-0">
              <td className="px-3 py-2 font-medium">{r.name}</td>
              <td className="px-3 py-2 tabular-nums">{r.waiting_now}</td>
              <td className="px-3 py-2 tabular-nums">{r.stale_now > 0 ? <Badge tone="warning">{r.stale_now}</Badge> : 0}</td>
              <td className="px-3 py-2 tabular-nums">{pct(r.occupancy)}</td>
              <td className="px-3 py-2 tabular-nums">{r.notification_failures > 0 ? <Badge tone="danger">{r.notification_failures}</Badge> : 0}</td>
              <td className="px-3 py-2"><Badge tone={COMMERCIAL[r.commercial_state]?.[1] || 'warning'}>{COMMERCIAL[r.commercial_state]?.[0] || r.commercial_state}</Badge></td>
              <td className="px-3 py-2"><Button variant="ghost" onClick={() => setDrill(r.tenant_id)}>Detalhar</Button></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">Atualizado agora. “Acima de 72 h”: encomendas aguardando retirada há mais de 72 horas. Ocupação considera só locais com capacidade cadastrada.</p>
    </section>
    <Links org={org} admin={admin} onChange={load} />
    <Members org={org} admin={admin} onChange={load} />
    {drill && <Drill org={id} tenant={drill} onClose={() => setDrill(null)} />}
  </>;
}

function Drill({ org, tenant, onClose }: { org: string; tenant: string; onClose: () => void }) {
  const [d, setD] = useState<any | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { rpc('org_tenant_overview', { p_org: org, p_tenant: tenant }).then(setD).catch((e) => setError(e.message)); }, [org, tenant]);
  return <Modal title={d?.name || 'Condomínio'} onClose={onClose} wide>
    {error ? <Alert tone="danger">{error}</Alert> : !d ? <Spinner /> : <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[['Aguardando agora', d.waiting_now], ['Acima de 72 h', d.stale_now], ['Recebidas hoje', d.received_today], ['Retiradas hoje', d.picked_today],
          ['Sem local de guarda', d.unstored_now], ['Pré-registros a conferir', d.preregistered], ['Falhas de aviso', d.notification_failures],
          ['Falhas de comprovante', d.receipt_failures], ['Cadastros pendentes', d.pending_access_requests], ['Unidades ativas', d.units_active],
          ['Ocupação', pct(d.occupancy)], ['Situação comercial', COMMERCIAL[d.commercial_state]?.[0] || d.commercial_state]].map(([l, v]) =>
          <div key={l as string}><dt className="text-muted">{l}</dt><dd className="text-lg font-semibold tabular-nums">{v}</dd></div>)}
      </dl>
      {d.locations.length > 0 && <div><p className="font-medium mb-1">Locais de guarda</p><ul className="space-y-1">{d.locations.map((l: any) =>
        <li key={l.code} className="flex justify-between gap-2"><span>{l.code}{l.is_contingency ? ' (contingência)' : ''}</span><span className="tabular-nums">{l.used}/{l.capacity}</span></li>)}</ul></div>}
      <p className="text-xs text-muted">Somente leitura e somente números agregados. Dados {dateTime(d.as_of, d.timezone)} ({d.timezone}).</p>
    </div>}
  </Modal>;
}

function Links({ org, admin, onChange }: { org: any; admin: boolean; onChange: () => void }) {
  const [slug, setSlug] = useState('');
  const { busy, run } = useAction();
  return <Card className="space-y-3">
    <h2 className="font-semibold">Condomínios vinculados</h2>
    {org.links.length === 0 ? <p className="text-sm text-muted">Nenhum pedido de vínculo.</p> : <ul className="divide-y divide-line">{org.links.map((l: any) =>
      <li key={l.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span><strong>{l.tenant_name}</strong> <Badge tone={l.status === 'active' ? 'success' : l.status === 'pending' ? 'warning' : 'neutral'}>{LINK_STATUS[l.status]}</Badge>
          <span className="block text-xs text-muted">{l.status === 'active' ? `Autorizado em ${dateTime(l.authorized_at)}${l.source === 'platform' ? ' (pela plataforma)' : ''}` : `Pedido em ${dateTime(l.requested_at)}`}</span></span>
        {admin && ['active', 'pending'].includes(l.status) && <Button variant="ghost" loading={busy} onClick={() => confirm(`Encerrar o vínculo com ${l.tenant_name}?`) && run(async () => { await rpc('org_end_link', { p_org: org.id, p_link: l.id }); onChange(); }, 'Vínculo encerrado.')}>Encerrar</Button>}
      </li>)}</ul>}
    {admin && <form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); run(async () => {
      const r = await rpc<{ status: string }>('org_request_link', { p_org: org.id, p_slug: slug.replace(/^.*\/c\//, '').replace(/[/?#].*$/, '') });
      setSlug(''); onChange(); return r;
    }, 'Pedido enviado. O síndico precisa aprovar.'); }}>
      <Field label="Endereço do condomínio" hint="O final do link do portal, ex.: residencial-flores (de /c/residencial-flores)."><Input required value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
      <Button type="submit" variant="secondary" loading={busy}>Pedir vínculo</Button>
    </form>}
  </Card>;
}

function Members({ org, admin, onChange }: { org: any; admin: boolean; onChange: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('org_viewer');
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useAction();
  return <Card className="space-y-3">
    <h2 className="font-semibold">Pessoas da administradora</h2>
    <ul className="divide-y divide-line">{org.members.map((m: any) =>
      <li key={m.user_id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span><strong>{m.name}</strong>{m.email && <span className="text-muted"> · {m.email}</span>} <Badge tone={m.role === 'org_admin' ? 'accent' : 'neutral'}>{ROLE[m.role]}</Badge> {m.status !== 'active' && <Badge tone="danger">revogado</Badge>}</span>
        {admin && !m.me && <Button variant="ghost" loading={busy} onClick={() => (m.status !== 'active' || confirm(`Revogar o acesso de ${m.name}? Vale imediatamente.`)) && run(async () => {
          await rpc('org_set_member_status', { p_org: org.id, p_user: m.user_id, p_status: m.status === 'active' ? 'revoked' : 'active' }); onChange();
        }, m.status === 'active' ? 'Acesso revogado.' : 'Acesso reativado.')}>{m.status === 'active' ? 'Revogar' : 'Reativar'}</Button>}
      </li>)}</ul>
    {admin && org.invitations.length > 0 && <div className="text-sm"><p className="font-medium">Convites pendentes</p><ul className="divide-y divide-line">{org.invitations.map((i: any) =>
      <li key={i.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
        <span>{i.email} · {ROLE[i.role]} · {i.expired ? 'expirado' : `vale até ${dateTime(i.expires_at)}`}</span>
        <Button variant="ghost" loading={busy} onClick={() => run(async () => { await rpc('org_revoke_invitation', { p_org: org.id, p_invitation: i.id }); onChange(); }, 'Convite revogado.')}>Revogar convite</Button>
      </li>)}</ul></div>}
    {admin && <form className="grid sm:grid-cols-3 gap-3 items-end" onSubmit={(e) => { e.preventDefault(); run(async () => {
      const r = await rpc<{ token: string }>('org_invite', { p_org: org.id, p_email: email, p_role: role });
      setLink(`${location.origin}/org/convite#${r.token}`); setEmail(''); onChange();
    }); }}>
      <Field label="E-mail" hint="O convite só vale para este e-mail, uma vez, por 7 dias."><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Papel"><Select value={role} onChange={(e) => setRole(e.target.value)}><option value="org_viewer">Leitura — vê a carteira</option><option value="org_admin">Administrador — convida e pede vínculos</option></Select></Field>
      <Button type="submit" variant="secondary" loading={busy}>Gerar convite</Button>
    </form>}
    {link && <Modal title="Convite criado" onClose={() => setLink(null)}><div className="space-y-3">
      <Alert tone="warning">Envie este link à pessoa por um canal seguro. Ele não será exibido de novo.</Alert>
      <Input readOnly value={link} onFocus={(e) => e.target.select()} />
      <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(link); toast.success('Link copiado.'); }}><Copy className="w-4 h-4" /> Copiar link</Button>
    </div></Modal>}
  </Card>;
}

function OrgInvite() {
  const token = location.hash.slice(1);
  const { session, ctx, loading } = useSession();
  const [preview, setPreview] = useState<{ org_name: string; role: string; valid: boolean } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (token) rpc('org_invitation_preview', { p_token: token }).then(setPreview).catch(() => setPreview(null)); else setPreview(null); }, [token]);
  const here = `/org/convite${location.hash}`;
  if (preview === undefined || loading) return <Spinner />;
  return <main className="max-w-md mx-auto px-4 py-10 space-y-4">
    <PortariaPrimeLogo />
    <h1 className="text-2xl font-semibold">Convite da administradora</h1>
    {!preview || !preview.valid ? <Alert tone="warning">Convite inválido, expirado ou já utilizado. Peça um novo a quem administra a administradora.</Alert> : <>
      <p>{preview.org_name} convidou você com acesso de {ROLE[preview.role]?.toLowerCase()}.</p>
      {!session ? <div className="space-y-3">
        <p className="text-sm text-muted">Entre ou crie sua conta com o mesmo e-mail que recebeu o convite.</p>
        <Button className="w-full" onClick={() => navigate(`/cadastro?next=${encodeURIComponent(here)}`)}>Criar conta</Button>
        <Button variant="secondary" className="w-full" onClick={() => navigate(`/entrar?next=${encodeURIComponent(here)}`)}>Já tenho conta</Button>
      </div> : <div className="space-y-3">
        <p className="text-sm text-muted">Conectado como <strong>{ctx?.email}</strong>.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button className="w-full" loading={busy} onClick={() => run(async () => {
          try { const r = await rpc<{ org_id: string }>('org_accept_invitation', { p_token: token }); navigate(`/org/${r.org_id}`, true); } catch (e: any) { setError(e.message); }
        })}>Aceitar convite</Button>
      </div>}
    </>}
  </main>;
}
