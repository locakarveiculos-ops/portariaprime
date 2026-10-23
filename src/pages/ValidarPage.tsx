import React, { useState } from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { query } from '../lib/router';
import { AuthLayout } from './auth/AuthLayout';
import { Alert, Button, Field, Input } from '../components/ui';

interface Result { valid: boolean; delivered_at?: string; tenant_name?: string }

/**
 * Página pública /validar: confirma se um comprovante de entrega existe a partir
 * do código impresso no PDF. Mostra só validade, data da entrega e condomínio —
 * nenhum dado pessoal (nome, unidade, foto, assinatura).
 */
export default function ValidarPage() {
  const [code, setCode] = useState(() => query('c') || '');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setRes(null);
    try {
      const { data, error } = await supabase.rpc('verify_receipt', { p_code: code.trim() });
      if (error) throw error;
      setRes(data as Result);
    } catch {
      setError('Não foi possível consultar agora. Tente novamente em instantes.');
    } finally { setBusy(false); }
  };

  return (
    <AuthLayout title="Validar comprovante" subtitle="Informe o código de verificação impresso no comprovante de entrega em PDF.">
      <form onSubmit={check} className="space-y-4">
        <Field label="Código de verificação" hint="20 caracteres, ex.: 1A2B-3C4D-5E6F-7A8B-9C0D">
          <Input value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} autoComplete="off" spellCheck={false} required className="font-mono uppercase" />
        </Field>
        <Button type="submit" loading={busy} className="w-full">Validar</Button>
      </form>
      <div className="mt-4 space-y-2" aria-live="polite">
        {error && <Alert tone="danger">{error}</Alert>}
        {res?.valid && (
          <Alert tone="success">
            <span className="flex gap-2"><CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden />
              <span>Comprovante válido. Entrega registrada em <strong>{new Date(res.delivered_at!).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</strong> no condomínio <strong>{res.tenant_name}</strong>.</span>
            </span>
          </Alert>
        )}
        {res && !res.valid && (
          <Alert tone="warning">
            <span className="flex gap-2"><ShieldAlert className="w-5 h-5 shrink-0" aria-hidden />
              <span>Código não encontrado. Confira os caracteres. Comprovantes emitidos antes desta verificação não têm código.</span>
            </span>
          </Alert>
        )}
        <p className="text-xs text-muted">Por privacidade, esta página não mostra nomes, unidade, fotos nem assinatura. Para ver o comprovante completo, o morador acessa o app do condomínio.</p>
      </div>
    </AuthLayout>
  );
}
