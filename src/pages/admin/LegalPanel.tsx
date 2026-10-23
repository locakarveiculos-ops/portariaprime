// Admin Master › Jurídico: dados da contratada (com pendências), documentos legais
// (draft → review → approved → published), prévia, diff simples e aceites com evidências mascaradas.
// Leitura exige capacidade `legal`; ações, `legal_manage` (MFA quando configurado) — validado no servidor.
import React, { useEffect, useState } from 'react';
import { friendly, rpc } from '../../lib/api';
import { brl, dateTime } from '../../lib/format';
import { DRAFT_KINDS, draftDoc, LegalKind, LEGAL_LABEL, Markdown } from '../../lib/legal';
import { lineDiff } from '../../lib/legal-text';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select, Spinner } from '../../components/ui';

const FIELDS: [string, string][] = [['razao_social', 'Razão social'], ['cnpj', 'CNPJ'], ['endereco', 'Endereço'], ['email_contato', 'E-mail de contato'],
  ['canal_privacidade', 'Canal de privacidade'], ['encarregado', 'Encarregado(a) de dados'], ['foro', 'Foro'], ['representante', 'Representante legal'],
  ['horario_suporte', 'Horário de suporte'], ['disponibilidade', 'Meta de disponibilidade (texto)']];
const NEXT: Record<string, [string, string][]> = {
  draft: [['review', 'Enviar para revisão']], review: [['approved', 'Aprovar'], ['draft', 'Devolver ao rascunho']],
  approved: [['published', 'Publicar'], ['draft', 'Devolver ao rascunho']],
};
const TONE: Record<string, 'neutral' | 'warning' | 'accent' | 'success'> = { draft: 'neutral', review: 'warning', approved: 'accent', published: 'success', archived: 'neutral' };

export default function LegalPanel({ canManage }: { canManage: boolean }) {
  const [status, setStatus] = useState<any>(null);
  const [docs, setDocs] = useState<any[] | null>(null);
  const [accs, setAccs] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ver, setVer] = useState(0);
  const [entity, setEntity] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [diff, setDiff] = useState<{ a: any; b: any } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true; setError('');
    Promise.all([rpc('legal_entity_status'), rpc('platform_legal_docs'), rpc('platform_contract_acceptances', { p_tenant: null })])
      .then(([s, d, a]) => { if (!on) return; setStatus(s); setDocs(d); setAccs(a); setEntity(Object.fromEntries(FIELDS.map(([k]) => [k, s.entity?.[k] || '']))); })
      .catch((e) => on && setError(friendly(e)));
    return () => { on = false; };
  }, [ver]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); setNotice(ok); setVer((v) => v + 1); } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  };

  if (!status && !error) return <Spinner />;
  return <div className="space-y-5">
    {error && <Alert tone="danger">{error}</Alert>}
    {notice && <Alert tone="success">{notice}</Alert>}
    {status && <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">Dados da contratada</h3>
        <Badge tone={status.complete ? 'success' : 'warning'}>{status.complete ? 'Completos' : `${status.missing.length} pendente(s)`}</Badge></div>
      <p className="text-sm text-muted">Preenchem os campos {'{{…}}'} dos documentos na publicação. Nenhum valor é sugerido: informe os dados oficiais da empresa.</p>
      {!status.complete && <Alert tone="warning">Pendentes: {status.missing.map((k: string) => FIELDS.find(([f]) => f === k)?.[1] || k).join(', ')}. Sem eles, nenhum documento pode ser publicado.</Alert>}
      <form className="grid sm:grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); act(() => rpc('platform_legal_entity_set', { p: entity }), 'Dados da contratada salvos.'); }}>
        {FIELDS.map(([k, label]) => <Field key={k} label={label}><Input value={entity[k] || ''} disabled={!canManage} onChange={(e) => setEntity((x) => ({ ...x, [k]: e.target.value }))} /></Field>)}
        {canManage && <div className="sm:col-span-2"><Button type="submit" loading={busy}>Salvar dados</Button></div>}
      </form>
    </Card>}

    {docs && <Card className="space-y-3">
      <div className="flex flex-wrap justify-between gap-2 items-center"><h3 className="font-semibold">Documentos</h3>
        {canManage && <Button variant="secondary" onClick={() => setEdit({ id: null, kind: 'contrato_saas', version: '', content_md: '', summary: '', change_note: '', material_change: true })}>Nova versão</Button>}</div>
      {docs.length === 0 && <p className="text-sm text-muted">Nenhum documento cadastrado. Use "Nova versão" e carregue a minuta do repositório como rascunho.</p>}
      <ul className="divide-y divide-line">{docs.map((d) => <li key={d.id} className="py-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2"><strong>{LEGAL_LABEL[d.kind as LegalKind] || d.kind}</strong><span className="text-sm">v{d.version}</span><Badge tone={TONE[d.status]}>{d.status}</Badge>
          {d.pending_marks?.length > 0 && d.status !== 'published' && <Badge tone="warning">{d.pending_marks.length} pendência(s) no texto</Badge>}</div>
        <p className="text-xs text-muted break-all">SHA-256 {d.sha256} · criado {dateTime(d.created_at)}{d.published_at ? ` · publicado ${dateTime(d.published_at)}` : ''}{d.effective_until ? ` · vigente até ${dateTime(d.effective_until)}` : ''}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setPreview(d)}>Prévia</Button>
          {(() => { const prev = docs.find((o) => o.kind === d.kind && o.id !== d.id && new Date(o.created_at) < new Date(d.created_at)); return prev && <Button variant="ghost" onClick={() => setDiff({ a: prev, b: d })}>Diferenças para v{prev.version}</Button>; })()}
          {canManage && d.status === 'draft' && <Button variant="ghost" onClick={() => setEdit(d)}>Editar</Button>}
          {canManage && (NEXT[d.status] || []).map(([to, label]) => <Button key={to} variant={to === 'published' ? 'primary' : 'secondary'} loading={busy}
            onClick={() => (to !== 'published' || confirm('Publicar torna o texto imutável e vigente para novos aceites. Continuar?')) && act(() => rpc('platform_legal_doc_transition', { p_id: d.id, p_to: to, p_note: null }), `Documento: ${label.toLowerCase()}.`)}>{label}</Button>)}
        </div>
      </li>)}</ul>
    </Card>}

    {accs && <Card className="space-y-3">
      <h3 className="font-semibold">Aceites de contrato</h3>
      <p className="text-sm text-muted">Evidências mascaradas (representante, e-mail, CPF, IP). O registro completo fica no banco, imutável.</p>
      {accs.length === 0 ? <p className="text-sm">Nenhum aceite registrado.</p> : <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-muted">{['Condomínio', 'Tipo', 'Situação', 'Versão', 'Plano', 'Valor', 'Representante', 'IP', 'Aceito em', 'E-mail confirmado'].map((h) => <th key={h} className="p-2 border-b border-line">{h}</th>)}</tr></thead>
        <tbody>{accs.map((a) => <tr key={a.id} className="border-b border-line align-top">
          <td className="p-2">{a.tenant_name}</td><td className="p-2">{a.kind}</td><td className="p-2">{a.status}</td><td className="p-2">{a.document_version}</td>
          <td className="p-2">{a.plan} · {a.cycle}{a.source === 'proposal' ? ' (proposta)' : ''}</td><td className="p-2">{brl(Number(a.amount_cents || 0))}</td>
          <td className="p-2">{a.representative} · {a.representative_email}{a.representative_cpf ? ` · ${a.representative_cpf}` : ''}</td>
          <td className="p-2">{a.ip || '—'}</td><td className="p-2">{dateTime(a.accepted_at)}</td><td className="p-2">{a.email_verified_at ? dateTime(a.email_verified_at) : 'Pendente'}</td>
        </tr>)}</tbody>
      </table></div>}
    </Card>}

    {edit && <Modal wide title={edit.id ? `Editar rascunho v${edit.version}` : 'Nova versão de documento'} onClose={() => setEdit(null)}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); act(async () => { await rpc('platform_legal_doc_save', { p_id: edit.id, p_kind: edit.kind, p_version: edit.version,
        p_content: edit.content_md, p_summary: edit.summary || null, p_change_note: edit.change_note || null, p_material: edit.material_change }); setEdit(null); }, 'Rascunho salvo.'); }}>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Documento"><Select value={edit.kind} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{Object.entries(LEGAL_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Versão" hint="Ex.: 1.0"><Input required disabled={!!edit.id} pattern="[0-9A-Za-z.\-]{1,40}" value={edit.version} onChange={(e) => setEdit({ ...edit, version: e.target.value })} /></Field>
        </div>
        {!edit.id && DRAFT_KINDS.includes(edit.kind) && <Button type="button" variant="ghost" onClick={() => { const d = draftDoc(edit.kind)!; setEdit({ ...edit, content_md: d.content_md, summary: d.summary || '' }); }}>Carregar minuta do repositório</Button>}
        <Field label="Resumo em linguagem simples"><Input maxLength={2000} value={edit.summary || ''} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} /></Field>
        <Field label="Texto (markdown)"><textarea required className="w-full min-h-[40vh] rounded-xl border border-line bg-surface p-3 font-mono text-xs" value={edit.content_md} onChange={(e) => setEdit({ ...edit, content_md: e.target.value })} /></Field>
        <Field label="Nota da alteração"><Input maxLength={1000} value={edit.change_note || ''} onChange={(e) => setEdit({ ...edit, change_note: e.target.value })} /></Field>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={!!edit.material_change} onChange={(e) => setEdit({ ...edit, material_change: e.target.checked })} />Mudança material (exige novo aceite de quem já contratou)</label>
        <Button type="submit" loading={busy}>Salvar rascunho</Button>
      </form>
    </Modal>}
    {preview && <Modal wide title={`${LEGAL_LABEL[preview.kind as LegalKind]} v${preview.version}`} onClose={() => setPreview(null)}>
      {preview.status !== 'published' && <div className="mb-3"><Alert tone="warning">Prévia. Campos {'{{…}}'} serão preenchidos com os dados da contratada na publicação.</Alert></div>}
      <Markdown md={preview.content_md} />
    </Modal>}
    {diff && <Modal wide title={`Diferenças v${diff.a.version} → v${diff.b.version}`} onClose={() => setDiff(null)}>
      <pre className="text-xs whitespace-pre-wrap break-words">{lineDiff(diff.a.content_md, diff.b.content_md).map((l, i) =>
        <div key={i} className={l.op === '+' ? 'bg-success/10 text-success' : l.op === '-' ? 'bg-danger-bg text-danger' : 'text-muted'}>{l.op} {l.text}</div>)}</pre>
    </Modal>}
  </div>;
}
