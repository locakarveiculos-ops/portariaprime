import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { friendly } from '../../lib/api';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '../../components/ui';

export default function MfaSettings() {
  const [factors, setFactors] = useState<{ id: string; friendly_name?: string }[]>([]);
  const [factor, setFactor] = useState('');
  const [pending, setPending] = useState<{ id: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  const refresh = async () => {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) throw error;
    const verified = data.totp.filter(item => item.status === 'verified');
    setFactors(verified);
    setFactor(current => verified.some(item => item.id === current) ? current : verified[0]?.id || '');
  };
  useEffect(() => { let active = true; refresh().catch(e => active && setError(friendly(e))).finally(() => active && setLoading(false)); return () => { active = false; }; }, []);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (e) { setError(friendly(e)); } finally { lock.current = false; setBusy(false); }
  };
  return <Card data-tour="platform-mfa" className="space-y-4">
    <h2 className="font-semibold">Autenticador da sua conta</h2>
    <p className="text-sm text-muted">QR e código ficam somente em memória nesta tela. Não compartilhe nem capture o QR. MFA não substitui as permissões do servidor.</p>
    {error && <Alert tone="danger">{error}</Alert>}{message && <Alert tone="success">{message}</Alert>}
    {loading ? <Spinner /> : <>
      {pending ? <div className="space-y-3">
        <img src={pending.qr} alt="QR privado para cadastrar seu aplicativo autenticador" className="h-52 w-52 max-w-full bg-white p-2" />
        <p className="text-sm">Leia com seu autenticador e confirme o código. Cancele antes de sair se não concluir.</p>
      </div> : <>
        <p>{factors.length ? `${factors.length} autenticador(es) verificado(s).` : 'Nenhum autenticador verificado.'}</p>
        {factors.length > 0 && <Field label="Autenticador para validar esta sessão"><Select value={factor} onChange={e => setFactor(e.target.value)} disabled={busy}>{factors.map(item => <option key={item.id} value={item.id}>{item.friendly_name || 'Aplicativo autenticador'}</option>)}</Select></Field>}
        <Button variant="secondary" disabled={busy} onClick={() => run(async () => {
          const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Painel global ${new Date().toISOString().slice(0, 19)}` });
          if (error) throw error;
          setPending({ id: data.id, qr: data.totp.qr_code }); setCode('');
        })}>Cadastrar autenticador</Button>
      </>}
      {(pending || factor) && <form className="space-y-3" onSubmit={e => { e.preventDefault(); run(async () => {
        if (!/^\d{6}$/.test(code)) throw new Error('Informe os seis dígitos do autenticador.');
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: pending?.id || factor, code });
        if (error) throw error;
        setPending(null); setCode(''); await refresh(); setMessage('Código verificado pelo servidor. Sessão autenticada em dois fatores.');
      }); }}>
        <Field label="Código de seis dígitos"><Input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy} /></Field>
        <div className="flex flex-wrap gap-2"><Button type="submit" loading={busy}>{pending ? 'Confirmar cadastro' : 'Validar sessão'}</Button>{pending && <Button type="button" variant="secondary" disabled={busy} onClick={() => run(async () => {
          const { error } = await supabase.auth.mfa.unenroll({ factorId: pending.id });
          if (error) throw error;
          setPending(null); setCode(''); setMessage('Cadastro pendente cancelado.');
        })}>Cancelar cadastro pendente</Button>}</div>
      </form>}
    </>}
  </Card>;
}
