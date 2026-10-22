import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { contrast, publicLogoUrl } from '../../lib/theme';
import { uploadLogo } from '../../lib/files';
import { Alert, Button, Card, Field, Input, Select, useAction } from '../../components/ui';

type Layout = {
  template: 'classico' | 'moderno' | 'compacto'; color_primary: string; color_accent: string;
  logo_position: 'left' | 'center' | 'right'; logo_size: 'small' | 'medium' | 'large';
  title: string; message: string; footer: string; address: string; contact: string;
  show_address: boolean; show_contact: boolean; show_document: boolean; version?: number; document?: string | null;
};
const DEFAULT: Layout = { template: 'classico', color_primary: '#101F30', color_accent: '#C8AB78', logo_position: 'left', logo_size: 'medium',
  title: 'Comprovante de entrega de encomenda', message: '', footer: '', address: '', contact: '', show_address: false, show_contact: false, show_document: false };

/** Identidade e comprovantes: logo, modelo e textos do PDF (vale para novas emissões). */
export function ReceiptLayoutCard() {
  const t = useTenant();
  const [f, setF] = useState<Layout | null>(null);
  const [saved, setSaved] = useState<Layout | null>(null);
  const [logo, setLogo] = useState<string | null>(t.branding?.logo_path || null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    rpc<Layout>('receipt_layout', { p_tenant: t.tenant.id }).then((l) => { const v = { ...DEFAULT, ...l, message: l.message || '', footer: l.footer || '', address: l.address || '', contact: l.contact || '' }; setF(v); setSaved(v); })
      .catch((e) => setError(e.message));
  }, [t.tenant.id]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  if (!t.can('settings')) return null;
  if (!f) return error ? <Alert tone="danger">{error}</Alert> : null;
  const set = (k: keyof Layout, v: any) => setF({ ...f, [k]: v });
  const legible = contrast(f.color_primary, '#FFFFFF') >= 4.5 || contrast(f.color_primary, '#18283A') >= 4.5;

  const onLogo = (file: File) => run(async () => {
    setError(null);
    if (file.size > 5 * 1024 * 1024) throw new Error('Logo muito grande (máx. 5 MB).');
    const path = await uploadLogo(t.tenant.id, file); // valida conteúdo real ao redesenhar no canvas
    const { error } = await supabase.from('tenant_branding').update({ logo_path: path }).eq('tenant_id', t.tenant.id);
    if (error) throw new Error('Logo enviado, mas não foi salvo. O logo anterior continua valendo.');
    setLogo(path); await t.reload();
  }, 'Logo atualizado. Vale para os próximos comprovantes.');
  const removeLogo = () => run(async () => {
    const { error } = await supabase.from('tenant_branding').update({ logo_path: null }).eq('tenant_id', t.tenant.id);
    if (error) throw new Error('Não foi possível remover o logo.');
    setLogo(null); await t.reload();
  }, 'Logo removido dos próximos comprovantes (os já emitidos não mudam).');

  const body = () => ({ template: f.template, color_primary: f.color_primary, color_accent: f.color_accent, logo_position: f.logo_position,
    logo_size: f.logo_size, title: f.title, message: f.message, footer: f.footer, address: f.address, contact: f.contact,
    show_address: f.show_address, show_contact: f.show_contact, show_document: f.show_document });
  const save = () => run(async () => {
    if (!legible) throw new Error('A cor primária tem pouco contraste para impressão. Escolha um tom mais escuro ou mais claro.');
    const r = await rpc<Layout>('save_receipt_layout', { p_tenant: t.tenant.id, p: body() });
    setSaved({ ...f, version: r.version });
  }, 'Layout salvo. Vale para os próximos comprovantes.');
  const showPreview = () => run(async () => {
    const { data } = await supabase.auth.getSession();
    const res = await fetch('/api/receipts/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
      body: JSON.stringify({ tenantId: t.tenant.id, layout: body(), logoPath: logo }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Não foi possível gerar a prévia.');
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(await res.blob()));
  });
  const dirty = JSON.stringify(f) !== JSON.stringify(saved);

  return (
    <Card className="space-y-4" data-tour="config-comprovante">
      <div><p className="font-semibold">Identidade e comprovantes</p>
        <p className="text-sm text-muted">Logo e layout do PDF de entrega enviado aos moradores. Alterações valem para <strong>novos comprovantes</strong>; os já emitidos não mudam.</p></div>
      <div className="flex flex-wrap items-center gap-4">
        {logo ? <img src={publicLogoUrl(logo)!} alt="Logo atual" className="h-16 max-w-40 object-contain rounded-lg bg-surface-2 p-1" /> : <span className="text-sm text-muted">Sem logo: o nome do condomínio aparece no lugar.</span>}
        <label className="inline-flex items-center gap-2 text-sm min-h-11 cursor-pointer underline">
          {logo ? 'Substituir logo' : 'Anexar logo'} (PNG, JPEG ou WebP, até 5 MB)
          <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const x = e.target.files?.[0]; if (x) onLogo(x); e.target.value = ''; }} />
        </label>
        {logo && <Button variant="ghost" onClick={removeLogo}>Remover logo</Button>}
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Modelo"><Select value={f.template} onChange={(e) => set('template', e.target.value)}><option value="classico">Clássico</option><option value="moderno">Moderno</option><option value="compacto">Compacto</option></Select></Field>
        <Field label="Posição do logo"><Select value={f.logo_position} onChange={(e) => set('logo_position', e.target.value)}><option value="left">Esquerda</option><option value="center">Centro</option><option value="right">Direita</option></Select></Field>
        <Field label="Tamanho do logo"><Select value={f.logo_size} onChange={(e) => set('logo_size', e.target.value)}><option value="small">Pequeno</option><option value="medium">Médio</option><option value="large">Grande</option></Select></Field>
        <Field label="Cor primária"><input type="color" value={f.color_primary} onChange={(e) => set('color_primary', e.target.value)} className="h-11 w-full rounded-xl border border-line bg-surface p-1" /></Field>
        <Field label="Cor de destaque"><input type="color" value={f.color_accent} onChange={(e) => set('color_accent', e.target.value)} className="h-11 w-full rounded-xl border border-line bg-surface p-1" /></Field>
      </div>
      {!legible && <Alert tone="warning">Contraste baixo para impressão.</Alert>}
      <Field label="Título do comprovante"><Input value={f.title} maxLength={80} onChange={(e) => set('title', e.target.value)} /></Field>
      <Field label="Mensagem complementar (opcional)" hint={`${f.message.length}/300`}><Input value={f.message} maxLength={300} onChange={(e) => set('message', e.target.value)} /></Field>
      <Field label="Rodapé (opcional)" hint={`${f.footer.length}/200`}><Input value={f.footer} maxLength={200} onChange={(e) => set('footer', e.target.value)} /></Field>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Endereço"><Input value={f.address} maxLength={160} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="Contato da portaria"><Input value={f.contact} maxLength={100} onChange={(e) => set('contact', e.target.value)} /></Field>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={f.show_address} onChange={(e) => set('show_address', e.target.checked)} /> Mostrar endereço</label>
        <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={f.show_contact} onChange={(e) => set('show_contact', e.target.checked)} /> Mostrar contato</label>
        <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={f.show_document} disabled={!f.document} onChange={(e) => set('show_document', e.target.checked)} /> Mostrar CNPJ/CPF {f.document ? '' : '(não cadastrado)'}</label>
      </div>
      <p className="text-xs text-muted">Protocolo, encomenda, unidade, datas, quem retirou, assinatura e foto do item aparecem sempre.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} loading={busy} disabled={!dirty}>Salvar</Button>
        <Button variant="secondary" onClick={showPreview} loading={busy}>Prévia em PDF (dados fictícios)</Button>
        {dirty && <Button variant="ghost" onClick={() => setF(saved)}>Cancelar alterações</Button>}
        <Button variant="ghost" onClick={() => setF({ ...DEFAULT, document: f.document, version: f.version })}>Restaurar padrão</Button>
      </div>
      {preview && <div className="space-y-2">
        <iframe title="Prévia do comprovante" src={preview} className="w-full h-[520px] rounded-xl border border-line bg-white" />
        <a href={preview} download="comprovante-teste.pdf" className="text-sm underline">Baixar PDF de teste</a>
      </div>}
    </Card>
  );
}
