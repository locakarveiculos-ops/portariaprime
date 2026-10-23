import React, { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useTenant } from '../../../lib/tenant';
import { Alert, Button, Card, Field, Input, Spinner, useAction } from '../../../components/ui';

const COLS = 'reminder_enabled, reminder_after_hours, reminder_interval_hours, reminder_start_hour, reminder_end_hour, reminder_max';
interface R { reminder_enabled: boolean; reminder_after_hours: number; reminder_interval_hours: number; reminder_start_hour: number; reminder_end_hour: number; reminder_max: number }

/** Lembretes de encomenda parada (módulo Comunicações). Regras aplicadas pelo servidor a cada execução do envio. */
export function RemindersCard() {
  const t = useTenant();
  const [s, setS] = useState<R | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    supabase.from('tenant_settings').select(COLS).eq('tenant_id', t.tenant.id).single().then(({ data }) => setS(data as R | null));
  }, [t.tenant.id]);
  if (!t.can('settings')) return null;
  if (!s) return <Card><Spinner /></Card>;
  const num = (k: keyof R) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  const windowOk = s.reminder_start_hour < s.reminder_end_hour;
  const save = () => run(async () => {
    if (!windowOk) throw new Error('O horário inicial precisa ser anterior ao final.');
    const { error } = await supabase.from('tenant_settings').update(s).eq('tenant_id', t.tenant.id);
    if (error) throw new Error('Não foi possível salvar. Confira os valores.');
  }, 'Lembretes salvos.');
  return (
    <Card className="space-y-3" data-tour="config-lembretes">
      <p className="font-semibold">Lembretes de encomenda parada</p>
      <p className="text-sm text-muted">Reenvia o aviso aos moradores da unidade (mesmos canais da chegada) enquanto a encomenda aguarda retirada. Para na hora em que ela é retirada.</p>
      <label className="flex items-center gap-2 text-sm min-h-11">
        <input type="checkbox" checked={s.reminder_enabled} onChange={(e) => setS({ ...s, reminder_enabled: e.target.checked })} /> Enviar lembretes
      </label>
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label="Primeiro lembrete após (horas)"><Input type="number" min={1} max={720} value={s.reminder_after_hours} onChange={num('reminder_after_hours')} /></Field>
        <Field label="Repetir a cada (horas)"><Input type="number" min={1} max={168} value={s.reminder_interval_hours} onChange={num('reminder_interval_hours')} /></Field>
        <Field label="Máximo de lembretes"><Input type="number" min={1} max={10} value={s.reminder_max} onChange={num('reminder_max')} /></Field>
        <Field label="Enviar a partir das (hora local)"><Input type="number" min={0} max={23} value={s.reminder_start_hour} onChange={num('reminder_start_hour')} /></Field>
        <Field label="Até as (hora local)"><Input type="number" min={1} max={24} value={s.reminder_end_hour} onChange={num('reminder_end_hour')} /></Field>
      </div>
      {!windowOk && <Alert tone="warning">O horário inicial precisa ser anterior ao final.</Alert>}
      {s.reminder_enabled && (
        <p className="text-sm rounded-xl bg-surface-2 p-3" aria-label="Prévia da regra">
          Prévia: uma encomenda recebida hoje recebe o 1º lembrete após {s.reminder_after_hours} h e depois a cada {s.reminder_interval_hours} h,
          no máximo {s.reminder_max} vez(es), só entre {s.reminder_start_hour}h e {s.reminder_end_hour}h. Notificação no app: “Encomenda aguardando retirada”.
        </p>
      )}
      <Button onClick={save} loading={busy} disabled={!windowOk}>Salvar</Button>
    </Card>
  );
}
