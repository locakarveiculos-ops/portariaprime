/**
 * Conversas do WhatsApp dos avisos (Evolution) no painel do síndico.
 *   POST /api/whatsapp/chat-list     { tenantId }                          -> conversas (mais recentes primeiro)
 *   POST /api/whatsapp/chat-messages { tenantId, jid, page? }              -> mensagens da conversa (mais recentes primeiro)
 *   POST /api/whatsapp/chat-send     { tenantId, jid, text?, file? }       -> texto ou anexo (file = caminho em tenant-chat/<tenant>/out/)
 *   POST /api/whatsapp/chat-media    { tenantId, id }                      -> URL assinada curta da mídia recebida/enviada
 * Permissão conferida no banco como o usuário (whatsapp_chat_gate). Só responde conversas que já existem na instância
 * do condomínio: o painel não vira disparador para números quaisquer. Os avisos automáticos seguem como estão.
 *
 * Histórico: a Evolution compartilhada não grava mensagens novas (DATABASE_SAVE_DATA_NEW_MESSAGE=false). O Portaria Prime
 * guarda as do condomínio em whatsapp_chat_messages, recebidas pelo webhook da instância (/api/webhooks/evolution-chat)
 * e pelos envios do painel. As antigas (até a Evolution parar de gravar) continuam vindo dela e são mescladas por id.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { appUrl, env } from './env.js';
import { HttpError, json, safeEqual } from './http.js';
import { rpcError, serviceClient } from './supabase.js';
import { whatsAppState } from './channels.js';

const OPS = ['list', 'messages', 'send', 'media'];
const JID = /^[\w.-]{5,40}@(s\.whatsapp\.net|lid)$/;
const BUCKET = 'tenant-chat';
const PAGE = 50;
const MEDIA: Record<string, 'image' | 'video' | 'document'> = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/3gpp': 'video', 'application/pdf': 'document' };
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/3gpp': '3gp',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'application/pdf': 'pdf' };
/** Eventos que o webhook da conversa recebe: mensagem que chega e mensagem que sai (avisos, painel ou celular). */
export const CHAT_EVENTS = ['MESSAGES_UPSERT', 'SEND_MESSAGE'];

export const instanceOf = (tenantId: string) => `pp-${tenantId.slice(0, 8)}-${tenantId.slice(-4)}`;
const INSTANCE = /^pp-[0-9a-f]{8}-[0-9a-f]{4}$/;

async function evo(path: string, body: unknown, timeout = 20000, method = 'POST'): Promise<any> {
  const r = await fetch(`${env('EVOLUTION_API_URL').replace(/\/$/, '')}${path}`, {
    method, headers: { 'Content-Type': 'application/json', apikey: env('EVOLUTION_API_KEY') },
    body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  // Mídia recebida pode ser enorme (qualquer pessoa manda até 2 GB): recusa antes de ler o corpo.
  // 20 MB em base64 viram ~27 MB de JSON.
  if (Number(r.headers.get('content-length')) > 28 * 1024 * 1024) { await r.body?.cancel(); throw new HttpError(413, 'Arquivo grande demais para abrir no painel (máximo 20 MB). Abra no celular do condomínio.'); }
  const d: any = await r.json().catch(() => ({}));
  if (r.status === 404) throw new HttpError(409, 'WhatsApp do condomínio não encontrado. Conecte em Configurações › Integrações.');
  if (!r.ok) throw new HttpError(502, r.status === 400 ? 'O WhatsApp recusou a mensagem (conversa ou arquivo inválido).' : 'WhatsApp indisponível agora. Tente de novo.');
  return d;
}

/** Texto curto e tipo de qualquer mensagem da Evolution (o painel não interpreta o objeto cru). */
export function summarize(r: any) {
  const m = r?.message || {};
  const t = r?.messageType || Object.keys(m)[0] || '';
  const inter = m.interactiveMessage;
  const media = t === 'imageMessage' ? 'image' : t === 'videoMessage' ? 'video' : t === 'audioMessage' ? 'audio'
    : t === 'documentMessage' || t === 'documentWithCaptionMessage' ? 'document' : t === 'stickerMessage' ? 'image' : null;
  const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || doc?.caption
    || inter?.body?.text || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title
    || m.templateButtonReplyMessage?.selectedDisplayText || m.buttonsMessage?.contentText || m.listMessage?.description || '';
  return {
    id: String(r?.key?.id || ''), fromMe: !!r?.key?.fromMe, at: Number(r?.messageTimestamp || 0) * 1000,
    text: String(text).slice(0, 4000), media, fileName: doc?.fileName ? String(doc.fileName).slice(0, 120) : null,
    status: r?.status || null,
  };
}

/** Mensagem da Evolution -> linha de whatsapp_chat_messages (ou null se não for de conversa individual). */
export function chatRow(tenantId: string, r: any) {
  const key = r?.key || {};
  const jid = String(key.remoteJid || '');
  const id = String(key.id || '');
  if (!JID.test(jid) || !/^[A-Za-z0-9]{8,64}$/.test(id)) return null;
  const t = r?.messageType || Object.keys(r?.message || {})[0] || '';
  // Protocolo (apagar, editar, reação) não é mensagem da conversa.
  if (/^(protocolMessage|reactionMessage|senderKeyDistributionMessage|messageContextInfo|pollUpdateMessage)$/.test(t)) return null;
  const s = summarize(r);
  if (!s.text && !s.media) return null;
  const alt = [key.remoteJidAlt, key.senderPn].map((v) => String(v || '')).find((v) => JID.test(v) && v !== jid) || null;
  const at = s.at > 0 ? new Date(s.at) : new Date();
  return { tenant_id: tenantId, id, jid, alt_jid: alt, from_me: s.fromMe, at: at.toISOString(), text: s.text, media: s.media,
    file_name: s.fileName, push_name: !s.fromMe && r?.pushName ? String(r.pushName).slice(0, 120) : null };
}

/**
 * Liga o webhook das conversas na instância do condomínio (só esta instância; nada no servidor Evolution é reiniciado).
 * Só configura se a instância ainda não tiver webhook próprio, para não sobrescrever outra integração.
 */
export async function ensureChatHook(tenantId: string): Promise<'ok' | 'other' | 'skip'> {
  const inst = instanceOf(tenantId);
  const svc = serviceClient();
  const { data: row } = await svc.from('whatsapp_chat_hooks').select('secret').eq('tenant_id', tenantId).maybeSingle();
  const url = `${appUrl()}/api/webhooks/evolution-chat`;
  const cur = await evo(`/webhook/find/${encodeURIComponent(inst)}`, null, 10000, 'GET');
  const own = cur?.url === url && row && cur?.headers?.['x-pp-secret'] === row.secret && cur?.enabled
    && CHAT_EVENTS.every((e) => (cur.events || []).includes(e));
  if (own) return 'ok';
  if (cur?.url && cur.url !== url) return 'other';
  const secret = row?.secret || randomBytes(32).toString('hex');
  if (!row) {
    const { error } = await svc.from('whatsapp_chat_hooks').upsert({ tenant_id: tenantId, instance: inst, secret, updated_at: new Date().toISOString() });
    if (error) throw new Error(`whatsapp_chat_hooks: ${error.message}`);
  }
  await evo(`/webhook/set/${encodeURIComponent(inst)}`, { webhook: { enabled: true, url, headers: { 'x-pp-secret': secret },
    byEvents: false, base64: false, events: CHAT_EVENTS } }, 15000);
  return 'ok';
}

/** POST /api/webhooks/evolution-chat: grava mensagens da conversa. Segredo por instância, conferido antes de tudo. */
export async function evolutionChatWebhook(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > 2_000_000) return json({ ok: true, ignored: 'size' });
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: 'payload' }, 400); }
  const inst = String(body?.instance || '');
  if (!INSTANCE.test(inst)) return json({ ok: true, ignored: 'instance' });
  const svc = serviceClient();
  const { data: hook } = await svc.from('whatsapp_chat_hooks').select('tenant_id, secret').eq('instance', inst).maybeSingle();
  // Segredo errado/ausente: 401 (a Evolution não repete 401).
  if (!hook || !safeEqual(request.headers.get('x-pp-secret') || '', hook.secret)) return json({ error: 'unauthorized' }, 401);
  const ev = String(body?.event || '').replace(/[.-]/g, '_').toUpperCase();
  if (!CHAT_EVENTS.includes(ev)) return json({ ok: true, ignored: 'event' });
  const list = Array.isArray(body?.data) ? body.data : [body?.data];
  const rows = list.map((r: any) => chatRow(hook.tenant_id, r)).filter(Boolean);
  if (rows.length) {
    const { error } = await svc.from('whatsapp_chat_messages').upsert(rows, { onConflict: 'tenant_id,id', ignoreDuplicates: true });
    // Falha de gravação: 500 faz a Evolution tentar de novo.
    if (error) { console.error('[evolution-chat] gravar', error.code || 'db'); return json({ error: 'store' }, 500); }
  }
  return json({ ok: true, stored: rows.length });
}

export async function whatsappChat(client: SupabaseClient, tenantId: string, op: string, body: any): Promise<Response> {
  if (!OPS.includes(op)) throw new HttpError(404, 'Ação desconhecida.');
  const kind = op !== 'send' ? 'read' : body.file ? MEDIA[String(body.mime || '')] : 'text';
  if (!kind) throw new HttpError(400, 'Envie foto (JPG, PNG, WebP), vídeo (MP4) ou PDF.');
  if (op === 'send' && !body.file && !String(body.text || '').trim()) throw new HttpError(400, 'Escreva a mensagem.');
  const jid = String(body.jid || '');
  if ((op === 'messages' || op === 'send') && !JID.test(jid)) throw new HttpError(400, 'Conversa inválida.');
  const inst = encodeURIComponent(instanceOf(tenantId));

  const gate = async (action: string) => { const { error } = await client.rpc('whatsapp_chat_gate', { p_tenant: tenantId, p_action: action }); if (error) rpcError(error); };
  await gate('read');
  // Envio: só para conversa que já existe neste WhatsApp; confere antes de gastar franquia (o gate consome e audita).
  if (op === 'send') {
    // Desconectado: a Evolution só responde erro genérico; avisa o motivo antes de subir o anexo para ela.
    if (await whatsAppState(instanceOf(tenantId)) === 'closed') throw new HttpError(409, 'WhatsApp do condomínio desconectado. Reconecte lendo o QR em Configurações › Integrações e envie de novo.');
    const chats: any[] = await evo(`/chat/findChats/${inst}`, { where: { remoteJid: jid } }, 10000);
    if (!Array.isArray(chats) || !chats.some((c) => c?.remoteJid === jid)) {
      const { data: known, error } = await serviceClient().from('whatsapp_chat_messages').select('id')
        .eq('tenant_id', tenantId).eq('jid', jid).limit(1);
      if (error || !known?.length) throw new HttpError(404, 'Conversa não encontrada neste WhatsApp.');
    }
    await gate(kind);
  }
  const svc = serviceClient();

  if (op === 'list') {
    // Liga o histórico (uma vez por condomínio); falha não impede a lista.
    await ensureChatHook(tenantId).catch((e) => console.error('[chat] webhook', (e as Error).message));
    const [chats, sent, stored] = await Promise.all([
      evo(`/chat/findChats/${inst}`, {}),
      evo(`/chat/findMessages/${inst}`, { where: { key: { fromMe: true } }, offset: 1000, page: 1 }),
      // Última mensagem guardada por conversa (a mais recente de cada jid).
      svc.from('whatsapp_chat_messages').select('id, jid, alt_jid, from_me, at, text, media, push_name')
        .eq('tenant_id', tenantId).order('at', { ascending: false }).limit(3000).then((r) => r.data || []),
    ]);
    // Conversa -> quem é: pelos avisos que saíram para ela (o WhatsApp esconde o número em conversas @lid).
    const byJid = new Map<string, string[]>();
    for (const r of sent?.messages?.records || []) {
      const j = r?.key?.remoteJid, id = r?.key?.id;
      if (j && id) byJid.set(j, [...(byJid.get(j) || []), id]);
    }
    // Avisos novos (guardados aqui) também identificam a conversa.
    const lastStored = new Map<string, any>();
    for (const m of stored as any[]) {
      if (!lastStored.has(m.jid)) lastStored.set(m.jid, m);
      if (m.from_me) byJid.set(m.jid, [...(byJid.get(m.jid) || []), m.id]);
    }
    const refs = [...new Set([...byJid.values()].flat())].slice(0, 2000);
    const { data: who, error: we } = refs.length ? await client.rpc('whatsapp_chat_who', { p_tenant: tenantId, p_refs: refs }) : { data: [], error: null };
    if (we) rpcError(we);
    const byRef = new Map<string, any>((who || []).map((w: any) => [w.ref, w]));
    const conversations = new Map<string, any>((Array.isArray(chats) ? chats : [])
      .filter((c) => JID.test(String(c?.remoteJid || ''))).map((c) => [c.remoteJid, c]));
    for (const [jid, m] of lastStored) {
      if (!conversations.has(jid)) conversations.set(jid, { remoteJid: jid, pushName: m.push_name, updatedAt: m.at });
    }
    const rows = [...conversations.values()].map((c) => {
      const w = (byJid.get(c.remoteJid) || []).map((id) => byRef.get(id)).find(Boolean);
      const evoLast = c.lastMessage ? summarize(c.lastMessage) : null;
      const st = lastStored.get(c.remoteJid);
      const stAt = st ? Date.parse(st.at) : 0;
      // Mais recente entre: o que guardamos, a última que a Evolution conhece e a atualização da conversa.
      const last = st && stAt >= (evoLast?.at || 0)
        ? { text: st.text, media: st.media, fromMe: st.from_me }
        : evoLast && { text: evoLast.text, media: evoLast.media, fromMe: evoLast.fromMe };
      const at = Math.max(stAt, evoLast?.at || 0, Date.parse(c.updatedAt) || 0);
      const phone = w?.phone || (c.remoteJid.endsWith('@s.whatsapp.net') ? `+${c.remoteJid.split('@')[0]}`
        : st?.alt_jid?.endsWith('@s.whatsapp.net') ? `+${st.alt_jid.split('@')[0]}` : null);
      return { jid: c.remoteJid, name: w?.full_name || c.pushName || st?.push_name || null, unit: w?.unit || null, phone, unread: Number(c.unreadCount) || 0,
        at, last };
    }).sort((a, b) => b.at - a.at);
    return json({ chats: rows });
  }

  if (op === 'messages') {
    const page = Math.min(Math.max(Number(body.page) || 1, 1), 50);
    // Guardadas no Portaria Prime + as antigas da Evolution (até ela parar de gravar), mescladas por id, mais recentes primeiro.
    const [{ data: own, count: ownCount, error: ownError }, d] = await Promise.all([
      svc.from('whatsapp_chat_messages').select('id, from_me, at, text, media, file_name', { count: 'exact' }).eq('tenant_id', tenantId).eq('jid', jid)
        .order('at', { ascending: false }).range(0, page * PAGE - 1),
      evo(`/chat/findMessages/${inst}`, { where: { key: { remoteJid: jid } }, offset: page * PAGE, page: 1 }).catch(() => null),
    ]);
    if (ownError) throw new HttpError(503, 'Não foi possível carregar o histórico. Tente novamente.');
    const merged = new Map<string, any>();
    for (const r of (d?.messages?.records || []).map(summarize)) if (r.id) merged.set(r.id, r);
    for (const r of own || []) merged.set(r.id, { id: r.id, fromMe: r.from_me, at: Date.parse(r.at), text: r.text, media: r.media, fileName: r.file_name, status: null });
    const all = [...merged.values()].sort((a, b) => b.at - a.at);
    const overlap = (own || []).filter((r) => (d?.messages?.records || []).some((old: any) => old?.key?.id === r.id)).length;
    const total = Math.max(all.length, (ownCount ?? own?.length ?? 0) + (Number(d?.messages?.total) || 0) - overlap);
    return json({ messages: all.slice((page - 1) * PAGE, page * PAGE), pages: Math.max(1, Math.ceil(total / PAGE)), page });
  }

  if (op === 'media') {
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw new HttpError(400, 'Mídia inválida.');
    const base = `${tenantId}/in/${id}`;
    // search é prefixo sem distinguir maiúsculas: confere o id exato antes de reaproveitar.
    const { data: cached } = await svc.storage.from(BUCKET).list(`${tenantId}/in`, { search: `${id}.`, limit: 5 });
    const hit = cached?.find((f) => f.name.slice(0, f.name.lastIndexOf('.')) === id);
    let path = hit ? `${tenantId}/in/${hit.name}` : null;
    if (!path) {
      const d = await evo(`/chat/getBase64FromMediaMessage/${inst}`, { message: { key: { id } }, convertToMp4: true }, 45000);
      const mime = String(d?.mimetype || '').split(';')[0];
      if (!d?.base64 || !EXT[mime]) throw new HttpError(415, 'Tipo de arquivo não exibido no painel.');
      path = `${base}.${EXT[mime]}`;
      const up = await svc.storage.from(BUCKET).upload(path, Buffer.from(d.base64, 'base64'), { contentType: mime, upsert: true });
      if (up.error) throw new Error(`storage: ${up.error.message}`);
    }
    const { data: s, error: se } = await svc.storage.from(BUCKET).createSignedUrl(path, 300);
    if (se || !s) throw new Error('storage: url');
    return json({ url: s.signedUrl });
  }

  // send
  const number = jid;
  const text = String(body.text || '').trim().slice(0, 4000);
  // Guarda o que o painel enviou na hora (não espera o webhook): aparece na conversa imediatamente.
  const keep = async (d: any, media: string | null, fileName: string | null) => {
    const row = chatRow(tenantId, { key: { remoteJid: jid, fromMe: true, id: d?.key?.id }, messageTimestamp: d?.messageTimestamp || Math.floor(Date.now() / 1000),
      message: media ? { [`${media}Message`]: { caption: text, fileName } } : { conversation: text }, messageType: media ? `${media}Message` : 'conversation' });
    if (row) await svc.from('whatsapp_chat_messages').upsert(row, { onConflict: 'tenant_id,id', ignoreDuplicates: true }).then(({ error }) => {
      if (error) console.error('[chat] guardar envio', error.code || 'db');
    });
  };
  if (!body.file) {
    const d = await evo(`/message/sendText/${inst}`, { number, text, options: { linkPreview: false } }, 25000);
    await keep(d, null, null);
    return json({ sent: true, id: d?.key?.id || null });
  }
  const file = String(body.file);
  if (!file.startsWith(`${tenantId}/out/`) || file.includes('..') || !/^[\w./-]{1,200}$/.test(file)) throw new HttpError(400, 'Anexo inválido.');
  const dl = await svc.storage.from(BUCKET).download(file);
  if (dl.error || !dl.data) throw new HttpError(404, 'Anexo não encontrado. Envie de novo.');
  const mime = String(body.mime);
  if (dl.data.type && dl.data.type.split(';')[0] !== mime) throw new HttpError(400, 'Tipo do anexo não confere.');
  const media = Buffer.from(await dl.data.arrayBuffer()).toString('base64');
  const fileName = kind === 'document' ? String(body.fileName || 'documento.pdf').replace(/[^\w .()-]/g, '').slice(0, 80) || 'documento.pdf' : undefined;
  try {
    const d = await evo(`/message/sendMedia/${inst}`, { number, mediatype: kind, mimetype: mime, caption: text || undefined, fileName, media }, 45000);
    await keep(d, kind, fileName || null);
    return json({ sent: true, id: d?.key?.id || null });
  } finally {
    // O anexo já está na Evolution (ou falhou): não fica guardado no bucket.
    await svc.storage.from(BUCKET).remove([file]).catch(() => {});
  }
}
