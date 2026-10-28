/**
 * Canal do agente Android "Portaria Prime Kiosk" (dentro da função do totem; sem novo slot Vercel).
 *
 *   POST /api/totem/kiosk-enroll  { token, agentId, publicKey, proof, info } -> { deviceId, tenantSlug }
 *   POST /api/totem/kiosk-sync    assinado -> política desejada, comandos pendentes, códigos de recuperação
 *   POST /api/totem/kiosk-ack     assinado { commandId, status, detail }
 *   POST /api/totem/kiosk-event   assinado { event, data }
 *
 * Requisição assinada: cabeçalhos X-PP-Device, X-PP-Counter e X-PP-Signature (ECDSA P-256/SHA-256, DER,
 * base64) sobre "POST\n{path}\n{device}\n{counter}\n{sha256(body)}". A chave privada nasce e fica no
 * Android Keystore; o banco guarda só a pública. O contador estritamente crescente (validado no banco,
 * com trava de linha) impede replay e reordenação. Nenhuma credencial de usuário trafega aqui.
 */
import { createPublicKey, verify, KeyObject } from 'node:crypto';
import { json, readJson, HttpError, sha256Hex, isUuid } from '../_lib/http.js';
import { serviceClient, rpcError } from '../_lib/supabase.js';

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function p256Key(spkiB64: string): KeyObject {
  if (typeof spkiB64 !== 'string' || !B64.test(spkiB64) || spkiB64.length < 80 || spkiB64.length > 400) throw new HttpError(400, 'Chave pública inválida.');
  let key: KeyObject;
  try { key = createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' }); }
  catch { throw new HttpError(400, 'Chave pública inválida.'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new HttpError(400, 'A chave do aparelho deve ser EC P-256.');
  return key;
}

export function verifySig(key: KeyObject, message: string, sigB64: string): boolean {
  if (typeof sigB64 !== 'string' || !B64.test(sigB64) || sigB64.length > 200) return false;
  try { return verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, Buffer.from(sigB64, 'base64')); }
  catch { return false; }
}

export const signedMessage = (path: string, device: string, counter: string, bodySha: string) =>
  `POST\n${path}\n${device}\n${counter}\n${bodySha}`;

const attempts = new Map<string, { n: number; at: number }>();
function limit(key: string, max: number) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.at > 60_000) { attempts.set(key, { n: 1, at: now }); return; }
  if (++a.n > max) throw new HttpError(429, 'Muitas tentativas. Aguarde um minuto.');
}

/** Lê corpo bruto (limite real), verifica assinatura e devolve { device, counter, body }. */
async function authenticated(request: Request, svc: ReturnType<typeof serviceClient>, maxBytes: number) {
  const device = request.headers.get('x-pp-device') || '';
  const counter = request.headers.get('x-pp-counter') || '';
  const sig = request.headers.get('x-pp-signature') || '';
  if (!isUuid(device) || !/^[1-9][0-9]{0,15}$/.test(counter)) throw new HttpError(401, 'Aparelho não identificado.');
  const text = await rawBody(request, maxBytes);
  const { data, error } = await svc.rpc('mdm_agent_key', { p_device: device });
  if (error) rpcError(error);
  if (!data) throw new HttpError(401, 'Credencial do aparelho revogada ou inexistente.');
  const path = new URL(request.url).pathname;
  if (!verifySig(p256Key(data.public_key), signedMessage(path, device, counter, await sha256Hex(text)), sig)) {
    throw new HttpError(401, 'Assinatura do aparelho inválida.');
  }
  let body: any = {};
  try { body = JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'JSON inválido.'); }
  return { device, counter: Number(counter), body };
}

async function rawBody(request: Request, maxBytes: number) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'Requisição grande demais.');
  return new TextDecoder().decode(buf);
}

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);

export async function kiosk(action: string, request: Request, ip: string): Promise<Response> {
  const svc = serviceClient();

  if (action === 'kiosk-enroll') {
    limit(`kenroll:${ip}`, 10);
    const b = await readJson(request, 8 * 1024);
    if (typeof b.token !== 'string' || !/^[A-Z0-9]{24}$/.test(b.token)) throw new HttpError(400, 'Código de inscrição inválido.');
    if (typeof b.agentId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(b.agentId)) throw new HttpError(400, 'Identificador do agente inválido.');
    const key = p256Key(b.publicKey);
    // Prova de posse: o aparelho assina o próprio token com a chave nova.
    if (!verifySig(key, `enroll\n${b.token}\n${b.agentId}`, b.proof)) throw new HttpError(401, 'Prova de posse da chave inválida.');
    const i = b.info && typeof b.info === 'object' ? b.info : {};
    const info = { managed: i.managed === true, manufacturer: str(i.manufacturer, 60), model: str(i.model, 60),
      release: str(i.release, 20), sdk: str(String(i.sdk ?? ''), 2), agent_version: str(i.agentVersion, 40) };
    const { data, error } = await svc.rpc('mdm_agent_enroll', { p_token_hash: await sha256Hex(b.token), p_agent_id: b.agentId,
      p_public_key: b.publicKey, p_info: info });
    if (error) rpcError(error);
    if (data.error) throw new HttpError(409, data.error);
    return json({ deviceId: data.device_id, deviceName: data.device_name, tenantSlug: data.tenant_slug });
  }

  if (action === 'kiosk-sync') {
    const { device, counter, body } = await authenticated(request, svc, 32 * 1024);
    limit(`ksync:${device}`, 30);
    const { data, error } = await svc.rpc('mdm_agent_sync', { p_device: device, p_counter: counter, p_report: body.report ?? {} });
    if (error) rpcError(error);
    // Nonce de turno (só após sync assinado aceito): a página registra início/fim de turno com ele.
    const nonce = await svc.rpc('mdm_shift_nonce', { p_device: device });
    return json({ ...data, shift_nonce: nonce.error ? null : nonce.data });
  }

  if (action === 'kiosk-ack') {
    const { device, counter, body } = await authenticated(request, svc, 4 * 1024);
    if (!isUuid(body.commandId)) throw new HttpError(400, 'Comando inválido.');
    const { data, error } = await svc.rpc('mdm_agent_ack', { p_device: device, p_counter: counter, p_command: body.commandId,
      p_status: str(body.status, 20), p_detail: str(body.detail, 300) });
    if (error) rpcError(error);
    return json(data);
  }

  if (action === 'kiosk-event') {
    const { device, counter, body } = await authenticated(request, svc, 4 * 1024);
    limit(`kevent:${device}`, 30);
    const { data, error } = await svc.rpc('mdm_agent_event', { p_device: device, p_counter: counter, p_event: str(body.event, 40),
      p_data: body.data && typeof body.data === 'object' ? body.data : {} });
    if (error) rpcError(error);
    return json(data);
  }

  throw new HttpError(404, 'Ação desconhecida.');
}
