import React, { useCallback, useEffect, useState } from 'react';
import { friendly, rpc } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { STATE_LABEL } from '../../lib/mdm';
import { Alert, Badge, Button, Card, Field, Input, Spinner, useAction } from '../../components/ui';
import type { PlatformContext } from './platform-model';

/**
 * Admin Master › Dispositivos: leitura de suporte (abrir um condomínio fica auditado) e publicação da
 * versão do agente. Nenhum comando remoto: quem manda nos aparelhos é o síndico do condomínio.
 */
export default function DevicesPanel({ context }: { context: PlatformContext }) {
  const canRelease = context.capabilities.includes('devices_release');
  const [data, setData] = useState<any>(null);
  const [tenant, setTenant] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [rel, setRel] = useState({ code: '', name: '', url: '', checksum: '' });
  const { busy, run } = useAction();
  const load = useCallback(() => { setError(''); rpc('platform_devices', { p_tenant: tenant }).then(setData).catch((e) => setError(friendly(e))); }, [tenant]);
  useEffect(() => { load(); }, [load]);
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <Alert>Somente leitura. Manutenção, Wi-Fi, reinício e desativação são decisões do síndico no painel do condomínio. Abrir os aparelhos de um condomínio fica registrado na auditoria.</Alert>
      <Card className="space-y-2">
        <h3 className="font-semibold">Versão publicada do agente Android</h3>
        {data.release ? <p className="text-sm">{data.release.version_name} (código {data.release.version_code}) · <span className="font-mono break-all">{data.release.apk_url}</span><br />
          Checksum da assinatura: <span className="font-mono break-all">{data.release.signature_checksum}</span></p> : <p className="text-sm text-muted">Nenhuma. O QR de provisionamento fica indisponível para os condomínios até publicar.</p>}
        {canRelease && <form className="grid sm:grid-cols-2 gap-2 items-end" onSubmit={(e) => { e.preventDefault(); run(async () => {
          await rpc('platform_agent_release', { p_version_code: Number(rel.code), p_version_name: rel.name, p_apk_url: rel.url, p_signature_checksum: rel.checksum }); load();
        }, 'Versão publicada.'); }}>
          <Field label="versionCode"><Input inputMode="numeric" value={rel.code} onChange={(e) => setRel({ ...rel, code: e.target.value })} required /></Field>
          <Field label="versionName"><Input value={rel.name} onChange={(e) => setRel({ ...rel, name: e.target.value })} required /></Field>
          <Field label="URL HTTPS do APK assinado"><Input type="url" value={rel.url} onChange={(e) => setRel({ ...rel, url: e.target.value })} required /></Field>
          <Field label="Checksum da assinatura" hint="Saída de android/scripts/signature-checksum.sh"><Input value={rel.checksum} onChange={(e) => setRel({ ...rel, checksum: e.target.value })} required /></Field>
          <Button type="submit" loading={busy}>Publicar versão</Button>
        </form>}
      </Card>
      {data.tenants.length === 0 ? <Card>Nenhum condomínio com aparelhos gerenciados.</Card> : data.tenants.map((t: any) => (
        <Card key={t.tenant_id} className="space-y-2">
          <div className="flex flex-wrap justify-between gap-2">
            <p className="font-semibold">{t.tenant_name} <span className="text-sm text-muted">· {t.total} aparelho(s){t.unmanaged ? ` · ${t.unmanaged} não gerenciado(s)` : ''}</span></p>
            <Button variant="ghost" onClick={() => setTenant(tenant === t.tenant_id ? null : t.tenant_id)}>{tenant === t.tenant_id ? 'Fechar' : 'Diagnóstico'}</Button>
          </div>
          <div className="flex flex-wrap gap-1">{Object.entries(t.by_state || {}).map(([s, n]) => <Badge key={s} tone={STATE_LABEL[s]?.[1] || 'neutral'}>{STATE_LABEL[s]?.[0] || s}: {String(n)}</Badge>)}</div>
          {t.devices && <ul className="text-sm divide-y divide-line">{t.devices.map((d: any) => <li key={d.id} className="py-1.5">
            <span className="font-medium">{d.name}</span> · {STATE_LABEL[d.state]?.[0] || d.state} · {d.model || '—'} · Android {d.android_release || '—'} · agente {d.agent_version || '—'} · {d.last_seen_at ? dateTime(d.last_seen_at) : 'sem contato'}
            {d.last_error && <span className="block text-danger">{d.last_error}</span>}
            {(d.failed_restrictions || []).length > 0 && <span className="block text-muted">Não aplicadas: {d.failed_restrictions.join(', ')}</span>}
          </li>)}</ul>}
        </Card>
      ))}
    </div>
  );
}
