/**
 * Morador no WhatsApp do condomínio (instância ppia-*): quem não é equipe autorizada cai aqui.
 * Só abre atendimento com palavra de início ou botão do bot; fora dele, silêncio (o chip pode ser o mesmo dos avisos).
 * Identidade: celular, ou "lid:<n>" quando o WhatsApp esconde o número. Toda escrita passa pelas RPCs do app.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { appUrl } from './env.js';
import { parseIncoming, whaileysSend, type Channel, type IncomingKey } from './whaileys.js';
import { residentActive, residentReply, type BotSession } from './resident-bot.js';

export interface ResidentInbox { ch: Channel; tenantId: string }

/** Identidade do remetente para o bot: número real ou LID. Grupos/status/fromMe = null. */
export function residentWho(key: IncomingKey): { who: string; replyTo: string } | null {
  const remote = key.remoteJid ?? '';
  if (!remote || key.fromMe || /@(g\.us|broadcast|newsletter)$/.test(remote)) return null;
  const pn = [remote, key.senderPn, key.remoteJidAlt].find((j) => /@s\.whatsapp\.net$/.test(j ?? ''));
  const phone = (pn ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
  if (/^55\d{10,11}$/.test(phone)) return { who: phone, replyTo: remote };
  const lid = /^(\d{5,30})(?::\d+)?@lid$/.exec(remote)?.[1];
  return lid ? { who: `lid:${lid}`, replyTo: remote } : null;
}

export async function residentWebhook(svc: SupabaseClient, box: ResidentInbox, key: IncomingKey, message: unknown, msgId: string): Promise<{ ok: boolean; ignored?: string; duplicate?: boolean }> {
  const id = residentWho(key);
  if (!id) return { ok: true, ignored: 'sender' };
  const { data: resolved, error } = await svc.rpc('resident_bot_resolve', { p_tenant: box.tenantId, p_who: id.who });
  if (error || !resolved?.active) return { ok: true, ignored: 'tenant' };
  const saved: BotSession = resolved.state && typeof resolved.state === 'object' ? resolved.state : {};
  const ev = parseIncoming(message, saved.options || []);
  if (!residentActive(ev, saved)) return { ok: true, ignored: 'silent' };
  // Dedupe por id do provedor antes de agir (entrega "pelo menos uma vez").
  const { error: dup } = await svc.from('assistant_messages').insert({ provider_id: msgId, phone: id.who });
  if (dup) return { ok: true, duplicate: true };

  const ctx = { tenantId: box.tenantId, who: id.who, appUrl: appUrl(), slug: String(resolved.slug), tenantName: String(resolved.tenant_name || '') };
  const send = (text: string) => whaileysSend(id.replyTo, { text }, box.ch).catch((e) => console.error('[resident-bot] envio', (e as Error).message));
  try {
    const reply = await residentReply(svc, ctx, ev, saved);
    let session = reply.session;
    let card = reply.card;
    if (reply.submitSignup) {
      const out = await submitSignup(svc, ctx, session.draft || {});
      card = { text: out.text };
      session = out.ok ? {} : { ...session, step: 'email', draft: undefined, options: [] };
    }
    const delivered = await whaileysSend(id.replyTo, card, box.ch).then(() => true, (e) => { console.error('[resident-bot] envio', (e as Error).message); return false; });
    // Envia antes de gravar: se o card não chegou, a resposta seguinte não pode valer para ele.
    await svc.rpc('resident_bot_save', { p_tenant: box.tenantId, p_who: id.who, p_state: delivered ? session : { ...saved, options: [] } });
  } catch (e) {
    console.error('[resident-bot]', (e as Error).message);
    await send('Não consegui concluir agora. Tente de novo em instantes ou use o aplicativo. Nada foi alterado.');
  }
  return { ok: true };
}

/** Pré-cadastro: conta nova sem senha (marcada como criada pelo bot) ou conta existente confirmada; mesmo request_access do portal. */
export async function submitSignup(svc: SupabaseClient, ctx: { tenantId: string; who: string; appUrl: string; slug: string }, d: Record<string, string>): Promise<{ ok: boolean; text: string }> {
  const portal = `${ctx.appUrl}/c/${ctx.slug}`;
  const { data: acc, error: ae } = await svc.rpc('resident_bot_account', { p_tenant: ctx.tenantId, p_who: ctx.who });
  if (ae || !acc?.email) return { ok: false, text: 'Confirme seu e-mail novamente para enviar o cadastro.' };
  // Conta nova, ou conta criada pelo bot numa tentativa anterior e nunca usada: vincula a esta conversa (e-mail já confirmado).
  let userId: string | null = acc.user_id || null;
  if (!userId) {
    const { data: created, error: ce } = await svc.auth.admin.createUser({
      email: acc.email, email_confirm: true, app_metadata: { resident_bot_provisioned: true }, user_metadata: { full_name: d.name },
    });
    if (ce || !created?.user) {
      console.error('[resident-bot] criar conta', ce?.message || 'sem usuário');
      return { ok: false, text: `Não foi possível criar sua conta agora. Tente de novo mais tarde ou cadastre-se pelo portal: ${portal}` };
    }
    userId = created.user.id;
  }
  if (!acc.user_id || acc.bot_provisioned) {
    const { error: be } = await svc.rpc('resident_bot_account_bind', { p_tenant: ctx.tenantId, p_who: ctx.who, p_user: userId });
    if (be) {
      console.error('[resident-bot] vincular conta', be.message);
      return { ok: false, text: `Não foi possível concluir. Cadastre-se pelo portal: ${portal}` };
    }
  } else if (!acc.confirmed) {
    return { ok: false, text: `Já existe uma conta com este e-mail aguardando confirmação. Conclua o cadastro pelo portal: ${portal}` };
  }
  const { error } = await svc.rpc('resident_bot_signup', { p_tenant: ctx.tenantId, p_who: ctx.who, p_full_name: d.name, p_phone: d.phone,
    p_block: d.block || null, p_unit: d.unit, p_privacy_hash: d.privacy_hash });
  if (error) {
    console.error('[resident-bot] cadastro', error.message);
    return { ok: false, text: `${error.message || 'Não foi possível enviar o cadastro.'}\n\nSe preferir, use o portal: ${portal}` };
  }
  return { ok: true, text: 'Solicitação enviada. A administração vai analisar seu cadastro. Quando aprovado, você recebe aqui e por e-mail um link pessoal para criar sua senha (válido por 7 dias) e acessar o aplicativo do condomínio.' };
}
