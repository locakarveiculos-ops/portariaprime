import React, { useRef, useState } from 'react';
import { Alert, Button, Field, Input, Select, inputCls } from './ui';

/** Texto curto para a landing. Não é promessa de cobertura: campanha pública só quando ativada no Admin Master. */
export const QUOTE_POLICY_SUMMARY =
  'Tem um orçamento de outro fornecedor? Envie para análise. A equipe compara escopo, porte e validade e responde com uma proposta '
  + 'formal quando houver condição viável. Nenhum desconto vale antes do envio da proposta pelo responsável.';

const MAX = 5 * 1024 * 1024;
const empty = { contact_name: '', email: '', phone: '', org_kind: 'condominio', org_name: '', units: '', concierges: '1', condos_count: '1',
  current_vendor: '', budget: '', budget_cycle: 'monthly', budget_valid_until: '', scope: '', website: '' };

/** Converte "1.234,56" / "1234.56" / "1234" em centavos inteiros; null se inválido. */
export function toCents(v: string): number | null {
  const s = v.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  const norm = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return null;
  return Math.round(Number(norm) * 100);
}

/** Formulário "Tenho um orçamento para comparar" (envio multipart para /api/quote). */
export function QuoteForm({ policyHref = '/privacidade' }: { policyHref?: string }) {
  const [f, setF] = useState(empty);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [result, setResult] = useState<{ protocol: string; attachment: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const x = e.target.files?.[0] || null;
    setError(null);
    if (x && x.size > MAX) { setError('O anexo passa de 5 MB. Reduza o arquivo ou envie sem anexo.'); e.target.value = ''; setFile(null); return; }
    if (x && !/^(application\/pdf|image\/(jpeg|png))$/.test(x.type)) { setError('Anexo deve ser PDF, JPEG ou PNG.'); e.target.value = ''; setFile(null); return; }
    setFile(x);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cents = f.budget ? toCents(f.budget) : null;
    if (f.budget && !cents) { setError('Valor do orçamento inválido. Exemplo: 189,90'); return; }
    const body = new FormData();
    for (const [k, v] of Object.entries(f)) if (k !== 'budget' && v !== '' && !(k === 'budget_cycle' && !cents)) body.set(k, v);
    if (cents) body.set('budget_cents', String(cents));
    if (file) body.set('attachment', file);
    setState('busy');
    try {
      const res = await fetch('/api/quote', { method: 'POST', body, signal: AbortSignal.timeout(60000) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Falha (${res.status}).`);
      setResult(json); setState('ok');
    } catch (err: any) {
      setError(/Failed to fetch|NetworkError|Load failed|timed out|aborted/i.test(err?.message || '')
        ? 'Sem conexão com o servidor. Seus dados continuam no formulário; tente enviar de novo.'
        : err.message || 'Não foi possível enviar agora. Tente de novo em instantes.');
      setState('idle');
    }
  };

  if (state === 'ok' && result) {
    return (
      <Alert tone="success">
        Solicitação recebida. Protocolo <strong>{result.protocol}</strong>. A equipe responde pelo e-mail informado.
        {result.attachment === 'failed' && ' O anexo não pôde ser salvo; se necessário, responda o e-mail com o arquivo.'}
      </Alert>
    );
  }
  const admin = f.org_kind === 'administradora';
  return (
    <form onSubmit={submit} className="grid sm:grid-cols-2 gap-3" aria-describedby="quote-summary" noValidate={false}>
      <p id="quote-summary" className="sm:col-span-2 text-sm text-muted">{QUOTE_POLICY_SUMMARY}</p>
      <Field label="Seu nome"><Input required minLength={2} maxLength={120} autoComplete="name" value={f.contact_name} onChange={set('contact_name')} /></Field>
      <Field label="E-mail"><Input required type="email" maxLength={200} autoComplete="email" value={f.email} onChange={set('email')} /></Field>
      <Field label="Telefone (opcional)"><Input type="tel" maxLength={30} autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
      <Field label="Você representa">
        <Select value={f.org_kind} onChange={set('org_kind')}>
          <option value="condominio">Um condomínio</option>
          <option value="administradora">Uma administradora</option>
        </Select>
      </Field>
      <Field label={admin ? 'Nome da administradora' : 'Nome do condomínio'}><Input required minLength={2} maxLength={160} value={f.org_name} onChange={set('org_name')} /></Field>
      <Field label={admin ? 'Total de unidades (somando os condomínios)' : 'Unidades'}><Input required inputMode="numeric" pattern="\d{1,6}" value={f.units} onChange={set('units')} /></Field>
      <Field label="Portarias"><Input inputMode="numeric" pattern="\d{1,2}" value={f.concierges} onChange={set('concierges')} /></Field>
      {admin && <Field label="Número de condomínios"><Input inputMode="numeric" pattern="\d{1,4}" value={f.condos_count} onChange={set('condos_count')} /></Field>}
      <Field label="Fornecedor atual (opcional)"><Input maxLength={120} value={f.current_vendor} onChange={set('current_vendor')} /></Field>
      <Field label="Valor do orçamento (R$, opcional)" hint="Valor total cobrado por ciclo.">
        <Input inputMode="decimal" placeholder="189,90" value={f.budget} onChange={set('budget')} />
      </Field>
      <Field label="Periodicidade do orçamento">
        <Select value={f.budget_cycle} onChange={set('budget_cycle')} disabled={!f.budget}>
          <option value="monthly">Mensal</option><option value="quarterly">Trimestral</option><option value="yearly">Anual</option>
        </Select>
      </Field>
      <Field label="Validade do orçamento (opcional)"><Input type="date" value={f.budget_valid_until} onChange={set('budget_valid_until')} /></Field>
      <div className="sm:col-span-2">
        <Field label="Escopo do orçamento (opcional)" hint="O que está incluído: portarias, avisos, WhatsApp, totem, prazos.">
          <textarea maxLength={2000} rows={3} value={f.scope} onChange={set('scope')} className={`${inputCls} py-2`} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Anexo do orçamento (opcional — PDF, JPEG ou PNG, até 5 MB)"
          hint="Antes de enviar, oculte dados pessoais desnecessários (CPF, telefones e nomes de moradores, dados bancários). Guardamos o anexo em área privada por até 180 dias.">
          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" onChange={pick}
            className="block w-full text-sm text-text file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-text" />
        </Field>
      </div>
      <div className="hidden" aria-hidden><label>Site<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label></div>
      <p className="sm:col-span-2 text-xs text-muted">
        Ao enviar, você concorda com o uso destes dados para responder à solicitação, conforme a <a className="underline" href={policyHref}>política de privacidade</a>.
      </p>
      {error && <div className="sm:col-span-2"><Alert tone="danger">{error}</Alert></div>}
      <div className="sm:col-span-2"><Button type="submit" loading={state === 'busy'}>{error ? 'Tentar enviar de novo' : 'Enviar orçamento para análise'}</Button></div>
    </form>
  );
}
