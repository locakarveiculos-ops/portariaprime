import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { rpc } from '../lib/api';
import { reencode, signedUrl, uploadPackageFile } from '../lib/files';
import { CameraCapture } from './CameraCapture';
import { Alert, Button } from './ui';

export const MAX_PHOTOS = 8;
const MAX_INPUT = 20 * 1024 * 1024;   // arquivo bruto aceito antes de reduzir
const MAX_UPLOAD = 5 * 1024 * 1024;   // limite do bucket privado
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface GalleryPhoto {
  /** sha256 do arquivo original (identifica a mesma foto da etiqueta no servidor). */
  id: string; blob: Blob; sha: string; url: string;
  state: 'ready' | 'uploading' | 'done' | 'error'; error?: string; path?: string;
}

/** Normaliza a foto no aparelho: valida tipo/tamanho, reduz e reencoda em JPEG (sem EXIF).
 *  A orientação EXIF é aplicada pelo navegador ao desenhar no canvas (image-orientation: from-image). */
export async function preparePhoto(b: Blob): Promise<GalleryPhoto> {
  if (b.type && !TYPES.includes(b.type)) throw new Error('Use foto JPG, PNG ou WebP.');
  if (b.size > MAX_INPUT) throw new Error('Foto muito grande (máx. 20 MB).');
  const jpg = await reencode(b, { max: 1600 });
  if (jpg.size > MAX_UPLOAD) throw new Error('Foto muito detalhada mesmo após reduzir. Tente de novo.');
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await b.arrayBuffer())), (x) => x.toString(16).padStart(2, '0')).join('');
  return { id: crypto.randomUUID(), blob: jpg, sha, url: URL.createObjectURL(jpg), state: 'ready' };
}

/**
 * Envia as fotos ainda não enviadas, na ordem da galeria (posição = índice + 1).
 * Cada foto falha/repete sozinha; vínculo idempotente no servidor (attach_label_photo).
 */
export async function uploadGallery(tenantId: string, packageId: string, photos: GalleryPhoto[], update: (id: string, p: Partial<GalleryPhoto>) => void) {
  let ok = true;
  for (const [i, p] of photos.entries()) {
    if (p.state === 'done') continue;
    update(p.id, { state: 'uploading', error: undefined });
    try {
      const path = p.path || await uploadPackageFile(tenantId, packageId, `label-${i + 1}`, p.blob);
      update(p.id, { path });
      await rpc('attach_label_photo', { p_tenant: tenantId, p_package: packageId, p_path: path });
      update(p.id, { state: 'done' });
    } catch (e: any) {
      ok = false;
      update(p.id, { state: 'error', error: e.message });
    }
  }
  return ok;
}

/** Galeria editável do recebimento (até 8 fotos, ordenável). A primeira é a etiqueta. */
export function PhotoGallery({ photos, onChange, locked, onRetry, label = 'Fotografar' }: {
  photos: GalleryPhoto[]; onChange: (p: GalleryPhoto[]) => void; locked?: boolean; onRetry?: () => void; label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const add = async (b: Blob) => {
    setError(null);
    if (photos.length >= MAX_PHOTOS) return setError(`Limite de ${MAX_PHOTOS} fotos por encomenda.`);
    try { onChange([...photos, await preparePhoto(b)]); } catch (e: any) { setError(e.message); }
  };
  const move = (i: number, d: -1 | 1) => { const n = [...photos]; [n[i], n[i + d]] = [n[i + d], n[i]]; onChange(n); };
  const remove = (i: number) => { URL.revokeObjectURL(photos[i].url); onChange(photos.filter((_, k) => k !== i)); };
  const failed = photos.some((p) => p.state === 'error');
  return (
    <div className="space-y-2">
      {photos.length > 0 && (
        <ol className="grid grid-cols-2 sm:grid-cols-3 gap-2" aria-label="Fotos do recebimento">
          {photos.map((p, i) => (
            <li key={p.id} className="relative rounded-xl overflow-hidden bg-surface-2">
              <img src={p.url} alt={i === 0 ? 'Foto da etiqueta' : `Foto ${i + 1} do volume`} className={`w-full ${i === 0 ? 'max-h-72' : 'h-28'} object-contain`} />
              <span className="absolute top-1 left-1 text-[11px] px-1.5 rounded bg-surface">{i === 0 ? 'Etiqueta' : i + 1}</span>
              {p.state === 'uploading' && <span className="absolute bottom-1 left-1 text-[11px] px-1.5 rounded bg-surface">Enviando…</span>}
              {p.state === 'done' && <span className="absolute bottom-1 left-1 text-[11px] px-1.5 rounded bg-surface text-success">Enviada</span>}
              {p.state === 'error' && <span className="absolute bottom-1 left-1 right-1 text-[11px] px-1.5 rounded bg-surface text-danger" title={p.error}>Falhou</span>}
              {!locked && (
                <div className="absolute top-1 right-1 flex gap-1">
                  {i > 0 && <button type="button" onClick={() => move(i, -1)} className="p-1.5 rounded-full bg-surface" aria-label={`Mover foto ${i + 1} para antes`}><ChevronLeft className="w-4 h-4" /></button>}
                  {i < photos.length - 1 && <button type="button" onClick={() => move(i, 1)} className="p-1.5 rounded-full bg-surface" aria-label={`Mover foto ${i + 1} para depois`}><ChevronRight className="w-4 h-4" /></button>}
                  <button type="button" onClick={() => remove(i)} className="p-1.5 rounded-full bg-surface" aria-label={i === 0 ? 'Remover foto' : `Remover foto ${i + 1}`}><X className="w-4 h-4" /></button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {!locked && photos.length < MAX_PHOTOS && <CameraCapture onCapture={add} label={photos.length ? `Adicionar foto (${photos.length}/${MAX_PHOTOS})` : label} />}
      {error && <Alert tone="warning">{error}</Alert>}
      {failed && onRetry && <Button type="button" variant="secondary" onClick={onRetry}><RotateCcw className="w-4 h-4" /> Reenviar fotos com falha</Button>}
    </div>
  );
}

/** Fotos do recebimento já registradas (somente leitura). A RLS decide quem vê: equipe ou morador da unidade. */
export function PackagePhotos({ packageId, title = 'Fotos do recebimento' }: { packageId: string; title?: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase.from('package_attachments').select('object_path, position, created_at')
        .eq('package_id', packageId).eq('kind', 'label_photo').order('position', { ascending: true, nullsFirst: false }).order('created_at');
      const out = await Promise.all((data || []).map((a) => signedUrl(a.object_path).catch(() => null)));
      if (live) setUrls(out.filter(Boolean) as string[]);
    })().catch(() => { /* sem fotos ou sem acesso */ });
    return () => { live = false; };
  }, [packageId]);
  if (!urls.length) return null;
  return (
    <figure className="space-y-1">
      <figcaption className="text-[11px] text-muted">{title} ({urls.length})</figcaption>
      <div className="grid grid-cols-4 gap-2">
        {urls.map((u, i) => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt={`Foto ${i + 1} do recebimento`} className="h-20 w-full object-cover rounded" /></a>)}
      </div>
    </figure>
  );
}
