import React, { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useTenant } from '../../../lib/tenant';
import { Alert, Card, Spinner } from '../../../components/ui';

const fmtDoc = (d?: string | null) => !d ? '—' : d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;

/** Dados cadastrais (somente leitura: não há edição self-service destes campos). */
export function CondoCard() {
  const t = useTenant();
  const [d, setD] = useState<any>(undefined);
  useEffect(() => {
    supabase.from('tenants').select('name, slug, document, contact_email, contact_phone, timezone, created_at').eq('id', t.tenant.id).single()
      .then(({ data }) => setD(data || null));
  }, [t.tenant.id]);
  if (d === undefined) return <Spinner />;
  if (!d) return <Alert tone="danger">Não foi possível carregar os dados do condomínio.</Alert>;
  const row = (k: string, v: React.ReactNode) => <><dt className="text-muted">{k}</dt><dd className="font-medium break-words">{v || '—'}</dd></>;
  return (
    <Card className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {row('Razão/nome cadastrado', d.name)}
        {row('Nome exibido', t.branding?.display_name || d.name)}
        {row('CNPJ/CPF', fmtDoc(d.document))}
        {row('E-mail de contato', d.contact_email)}
        {row('Telefone de contato', d.contact_phone)}
        {row('Fuso horário', d.timezone)}
        {row('Endereço do portal', `/c/${d.slug}`)}
        {row('Cadastrado em', new Date(d.created_at).toLocaleDateString('pt-BR'))}
      </dl>
      <p className="text-xs text-muted">O nome exibido muda em Identidade visual. Para alterar dados cadastrais (CNPJ/CPF, contato, fuso ou endereço do portal), fale com o suporte.</p>
    </Card>
  );
}
