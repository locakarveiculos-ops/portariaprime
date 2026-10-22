import { supabase } from './supabase';

/**
 * Ícones do PWA do condomínio, gerados no navegador a partir do logo (ou das
 * iniciais, sem logo). PNG desenhado no canvas: nada do arquivo original passa.
 * Gravados versionados em tenant-public/{tenant}/app-v{versão}/ (ícones antigos ficam).
 */
const SIZES = [
  { name: 'icon-192.png', size: 192, pad: 0.12 },
  { name: 'icon-512.png', size: 512, pad: 0.12 },
  { name: 'maskable-512.png', size: 512, pad: 0.24 }, // zona segura do maskable (80% central)
  { name: 'apple-180.png', size: 180, pad: 0.12 },
];

const initials = (name: string) =>
  name.normalize('NFD').replace(/[^A-Za-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 || /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'PP';

async function loadImage(url: string) {
  return new Promise<HTMLImageElement>((ok, bad) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => ok(i);
    i.onerror = () => bad(new Error('Não foi possível ler o logo para gerar os ícones.'));
    i.src = url;
  });
}

export async function renderIcons(opts: { name: string; color: string; logoUrl?: string | null }) {
  const logo = opts.logoUrl ? await loadImage(opts.logoUrl) : null;
  const out: { name: string; blob: Blob }[] = [];
  for (const s of SIZES) {
    const c = document.createElement('canvas');
    c.width = c.height = s.size;
    const g = c.getContext('2d')!;
    // Logo: fundo branco (logos costumam ser escuros/transparentes). Iniciais: fundo na cor do condomínio.
    g.fillStyle = logo ? '#FFFFFF' : opts.color;
    g.fillRect(0, 0, s.size, s.size);
    const box = s.size * (1 - 2 * s.pad);
    if (logo) {
      const k = Math.min(box / logo.naturalWidth, box / logo.naturalHeight);
      const w = logo.naturalWidth * k, h = logo.naturalHeight * k;
      g.drawImage(logo, (s.size - w) / 2, (s.size - h) / 2, w, h);
    } else {
      g.fillStyle = '#FFFFFF';
      g.font = `600 ${Math.round(box * 0.5)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(initials(opts.name), s.size / 2, s.size / 2 + box * 0.02);
    }
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('Não foi possível gerar os ícones.');
    out.push({ name: s.name, blob });
  }
  return out;
}

/** Gera e publica os ícones; devolve a versão gravada (para o manifest). */
export async function publishIcons(tenantId: string, opts: { name: string; color: string; logoUrl?: string | null }) {
  const version = Date.now();
  const icons = await renderIcons(opts);
  for (const i of icons) {
    const { error } = await supabase.storage.from('tenant-public')
      .upload(`${tenantId}/app-v${version}/${i.name}`, i.blob, { contentType: 'image/png', upsert: false });
    if (error) throw new Error('Não foi possível publicar os ícones do aplicativo.');
  }
  const { error } = await supabase.rpc('set_app_icons_version', { p_tenant: tenantId, p_version: version });
  if (error) throw new Error('Ícones enviados, mas não foi possível ativá-los.');
  return version;
}
