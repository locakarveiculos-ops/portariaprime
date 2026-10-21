import React, { useState } from 'react';
import { api } from '../lib/api';
import { Alert, Button, Field, Input } from './ui';

/** Formulário de contato real: só confirma depois que o servidor gravou. Honeypot contra robôs. */
export function ContactForm({ context = 'landing' }: { context?: string }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', message: '', website: '' });
  const [state, setState] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setState('busy');
    try {
      await api('/api/contact', { ...f, source: context.replace(/[^a-z0-9:_-]/g, '').slice(0, 80) || 'landing' });
      setState('ok');
    } catch (err: any) {
      setError(err.status === 429 ? err.message : err.message || 'Não foi possível enviar agora. Tente de novo em instantes.');
      setState('idle');
    }
  };
  if (state === 'ok') return <Alert tone="success">Mensagem recebida. A equipe da Portaria Prime responde pelo e-mail informado.</Alert>;
  return (
    <form onSubmit={submit} className="grid sm:grid-cols-2 gap-3">
      <Field label="Nome"><Input required minLength={2} maxLength={120} autoComplete="name" value={f.name} onChange={set('name')} /></Field>
      <Field label="E-mail"><Input required type="email" maxLength={200} autoComplete="email" value={f.email} onChange={set('email')} /></Field>
      <Field label="Telefone (opcional)"><Input type="tel" maxLength={30} autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
      <div className="hidden" aria-hidden><label>Site<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label></div>
      <div className="sm:col-span-2"><Field label="Mensagem" hint="Conte o tamanho do condomínio ou o que precisa. Não envie senhas.">
        <textarea required minLength={5} maxLength={2000} rows={4} value={f.message} onChange={set('message')} className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent" />
      </Field></div>
      {error && <div className="sm:col-span-2"><Alert tone="danger">{error}</Alert></div>}
      <div className="sm:col-span-2"><Button type="submit" loading={state === 'busy'}>Enviar mensagem</Button></div>
    </form>
  );
}
