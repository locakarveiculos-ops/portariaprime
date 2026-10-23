import React, { useEffect, useState } from 'react';
import { friendly, rpc } from '../../lib/api';
import { Alert, Button, Card, Field, Input, Spinner, useAction } from '../../components/ui';
import type { PlatformContext } from './platform-model';

/** Admin Master › Suporte › Atendimento: horário, canais e prazo de 1ª resposta exibidos aos clientes. */
export default function SupportSettings({ context }: { context: PlatformContext }) {
  const manage = context.capabilities.includes('support_manage');
  const [f, setF] = useState<{ hours: string; channels: string; target: string; approved: boolean } | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useAction();
  useEffect(() => {
    rpc('support_settings_get').then((s) => setF({ hours: s?.hours || '', channels: s?.channels || '', target: s?.first_response_target || '', approved: !!s?.approved }))
      .catch((e) => setError(friendly(e)));
  }, []);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!f) return <Spinner />;
  return (
    <Card>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(() => rpc('support_settings_save', { p_hours: f.hours, p_channels: f.channels, p_first_response_target: f.target, p_approved: f.approved }), 'Configuração salva.'); }}>
        <h3 className="font-semibold">Atendimento exibido aos condomínios</h3>
        <Field label="Horário de atendimento" hint="Vazio: os clientes veem “Horário de atendimento a definir”."><Input maxLength={300} disabled={!manage} value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} placeholder="Ex.: segunda a sexta, 9h às 18h (exceto feriados)" /></Field>
        <Field label="Canais"><Input maxLength={300} disabled={!manage} value={f.channels} onChange={(e) => setF({ ...f, channels: e.target.value })} placeholder="Ex.: chamado no app" /></Field>
        <Field label="Prazo de primeira resposta" hint="Só é exibido aos clientes quando aprovado abaixo."><Input maxLength={120} disabled={!manage} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder="Ex.: até 4 horas úteis" /></Field>
        <label className="flex items-center gap-2 text-sm min-h-11"><input type="checkbox" disabled={!manage} checked={f.approved} onChange={(e) => setF({ ...f, approved: e.target.checked })} /> Prazo aprovado para divulgação (compromisso comercial)</label>
        {manage ? <Button type="submit" loading={busy}>Salvar</Button> : <Alert>Seu papel permite apenas leitura.</Alert>}
      </form>
    </Card>
  );
}
