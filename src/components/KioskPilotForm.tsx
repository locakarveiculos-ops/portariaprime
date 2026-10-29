import React, { useState } from 'react';
import { api } from '../lib/api';
import { ANDROID_VERSIONS, KIOSK } from '../lib/kiosk-offer';
import { onLink } from '../lib/router';
import { Alert, Button, Field, Input, Select } from './ui';

/** Nota obrigatória sob "Modo Portaria Exclusiva para Android*" em todo cartão de plano. */
export function KioskPlanNote({ className = '' }: { className?: string }) {
  return <p className={`text-xs text-muted ${className}`}>* {KIOSK.planNote} {KIOSK.pilot}</p>;
}

const empty = { condoName: '', name: '', role: 'Síndico(a)', email: '', phone: '', brand: '', model: '', android: '', devices: '1', notes: '', website: '' };

/** "Solicitar ativação piloto": só confirma depois que o servidor gravou (protocolo PQ-…). Honeypot contra robôs. */
export function KioskPilotForm() {
  const [f, setF] = useState(empty);
  const [dedicated, setDedicated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<string | null>(null);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await api<{ protocol: string | null }>('/api/public/kiosk-pilot', { ...f, devices: Number(f.devices), dedicated });
      setProtocol(r.protocol || 'recebida');
    } catch (err: any) {
      setError(err.message || 'Não foi possível enviar agora. Tente de novo em instantes.');
    } finally { setBusy(false); }
  };
  if (protocol) return (
    <Alert tone="success">
      Solicitação <strong>{protocol}</strong> registrada. A equipe confere a compatibilidade do aparelho e responde pelo e-mail informado.
      Nada é ativado nem cobrado com este envio.
    </Alert>
  );
  return (
    <form onSubmit={submit} className="grid sm:grid-cols-2 gap-3" aria-describedby="piloto-req">
      <Field label="Nome do condomínio"><Input required minLength={2} maxLength={200} autoComplete="organization" value={f.condoName} onChange={set('condoName')} /></Field>
      <Field label="Seu nome"><Input required minLength={2} maxLength={120} autoComplete="name" value={f.name} onChange={set('name')} /></Field>
      <Field label="Cargo"><Input maxLength={80} value={f.role} onChange={set('role')} /></Field>
      <Field label="E-mail"><Input required type="email" maxLength={200} autoComplete="email" value={f.email} onChange={set('email')} /></Field>
      <Field label="Celular com DDD (opcional)"><Input type="tel" inputMode="tel" maxLength={20} autoComplete="tel" value={f.phone} onChange={set('phone')} /></Field>
      <Field label="Marca do aparelho" hint="Ex.: Samsung, Motorola, Lenovo."><Input required minLength={2} maxLength={60} value={f.brand} onChange={set('brand')} /></Field>
      <Field label="Modelo" hint="Em Configurações › Sobre o dispositivo."><Input required maxLength={80} value={f.model} onChange={set('model')} /></Field>
      <Field label="Versão do Android"><Select required value={f.android} onChange={set('android')}>
        <option value="">Selecione</option>{ANDROID_VERSIONS.map((v) => <option key={v} value={v}>Android {v}</option>)}<option value="nao-sei">Não sei</option>
      </Select></Field>
      <Field label="Quantidade de aparelhos"><Input required type="number" min={1} max={20} inputMode="numeric" value={f.devices} onChange={set('devices')} /></Field>
      <div className="sm:col-span-2"><Field label="Observações (opcional)" hint="Não envie senhas.">
        <textarea maxLength={500} rows={2} value={f.notes} onChange={set('notes')} className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent" />
      </Field></div>
      <div className="hidden" aria-hidden><label>Site<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label></div>
      <label className="sm:col-span-2 flex gap-3 items-start text-sm">
        <input type="checkbox" className="mt-1 w-5 h-5" checked={dedicated} onChange={(e) => setDedicated(e.target.checked)} required />
        <span>O aparelho é do condomínio e será dedicado à portaria. Sei que a configuração pode exigir restauração de fábrica, que apaga os dados do aparelho.</span>
      </label>
      <p id="piloto-req" className="sm:col-span-2 text-xs text-muted">{KIOSK.requirement} {KIOSK.pilot} Dados usados só para responder a esta solicitação, conforme a <a href="/privacidade" onClick={onLink} className="underline">política de privacidade</a>.</p>
      {error && <div className="sm:col-span-2"><Alert tone="danger">{error}</Alert></div>}
      <div className="sm:col-span-2"><Button type="submit" loading={busy}>{KIOSK.cta}</Button></div>
    </form>
  );
}
