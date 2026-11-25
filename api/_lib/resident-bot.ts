/** Conversa determinística do morador. Sem IA; todas as operações usam as mesmas RPCs do app. */
import { randomBytes } from 'node:crypto';
import { numberedCard, type Card, type Incoming } from './whatsapp-card.js';

interface Svc { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message?: string } | null }> }
export interface BotSession {
  authenticated?: boolean; user?: string; unit?: string; step?: string; until?: number; options?: string[];
  draft?: Record<string, string>; nonce?: string;
}
interface Context { tenantId: string; who: string; appUrl: string; slug: string; tenantName: string }
interface Reply { card: Card; options: string[]; session: BotSession; submitSignup?: boolean }
const START = /^(\/?menu|oi|ol[aá]|encomendas?|portaria|in[ií]cio)$/i;
const MENU = { id: 'rb:m', title: 'Menu principal' };
const EXIT = { id: 'rb:exit', title: 'Encerrar atendimento' };
const EMAIL = { id: 'rb:email', title: 'Informar e-mail' };
const clean = (value: unknown) => String(value ?? '').replace(/[*_~`]/g, '').slice(0, 200);
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
const nonce = () => randomBytes(8).toString('hex');
export function residentActive(ev: Incoming, s: BotSession, now = Date.now()): boolean {
  return ev.kind !== 'ignored' && ((ev.kind === 'text' && START.test(ev.text.trim()))
    || (ev.kind === 'action' && ev.id.startsWith('rb:')) || (s.until || 0) > now);
}

export async function residentReply(svc: Svc, ctx: Context, ev: Incoming, saved: BotSession): Promise<Reply> {
  let s: BotSession = (saved.until || 0) > Date.now() ? { ...saved, draft: saved.draft && { ...saved.draft } } : {};
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    const { data, error } = await svc.rpc(name, { p_tenant: ctx.tenantId, ...args });
    if (error) throw new Error(error.message || 'Operação indisponível.');
    return data;
  };
  const output = (text: string, opts = [MENU, EXIT], patch: Partial<BotSession> = {}): Reply => {
    const { card, ids } = numberedCard(text, opts, opts.length > 3);
    s = { ...s, ...patch, options: ids, until: Date.now() + 30 * 60_000 };
    return { card, options: ids, session: s };
  };
  const emailPrompt = () => {
    s = {};
    return output(`${clean(ctx.tenantName)}\nInforme seu e-mail para localizar seu cadastro ou iniciar uma solicitação. Enviaremos um código para confirmar que o e-mail é seu. Nunca envie sua senha.`, [EXIT], { step: 'email' });
  };
  // Só aceita botões efetivamente oferecidos no último passo. Botões antigos não confirmam uma nova proposta.
  let id = ev.kind === 'action' && s.options?.includes(ev.id) ? ev.id : '';
  if (id === 'rb:exit') return { card: { text: 'Atendimento encerrado. Para começar novamente, envie menu.' }, options: [], session: {} };
  if (id === 'rb:email' || (!s.authenticated && !s.step)) return emailPrompt();
  if (ev.kind === 'text' && START.test(ev.text.trim()) && !s.authenticated) return emailPrompt();
  const text = ev.kind === 'text' ? ev.text.trim() : '';

  if (!s.authenticated) {
    if (s.step === 'email') {
      if (!text || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || text.length > 254)
        return output('Digite um e-mail válido, por exemplo: nome@exemplo.com.br.', [EXIT]);
      const r = await rpc('resident_bot_email_start', { p_who: ctx.who, p_email: text });
      if (!r?.sent) return output(r?.reason === 'limit' ? 'Limite de códigos atingido. Aguarde para tentar novamente.' : 'Não foi possível enviar. Confira seu e-mail.', [EMAIL, EXIT]);
      return output('Código enviado por e-mail. Digite os 6 dígitos aqui. Validade: 10 minutos. Confira também a pasta de spam.', [EMAIL, EXIT], { step: 'code' });
    }
    if (s.step === 'code') {
      if (!/^\d{6}$/.test(text)) return output('Digite o código de 6 dígitos recebido por e-mail.', [EMAIL, EXIT]);
      const r = await rpc('resident_bot_email_verify', { p_who: ctx.who, p_code: text });
      if (!r?.ok) return output('Código inválido, expirado ou com tentativas esgotadas. Confira o e-mail ou solicite outro código.', [EMAIL, EXIT]);
      if (r.status === 'pending') return output(`Sua solicitação aguarda aprovação da administração do ${clean(ctx.tenantName)}. Você receberá o resultado por e-mail e WhatsApp.`, [EMAIL, EXIT], { step: 'pending' });
      if (r.status !== 'linked') return output('E-mail confirmado. Vamos solicitar seu cadastro neste condomínio. Digite seu nome completo.', [EMAIL, EXIT], { step: 'signup_name', draft: {} });
      s = { ...s, authenticated: true, step: undefined, draft: undefined };
      id = 'rb:m';
    }
    if (!s.authenticated) {
      const draft = s.draft || {};
      if (s.step === 'signup_name') {
        if (!/^\S+\s+\S+/.test(text) || text.length > 120) return output('Informe nome e sobrenome (até 120 caracteres).', [EMAIL, EXIT]);
        s.draft = { name: text };
        if (/^55\d{10,11}$/.test(ctx.who)) s.draft.phone = ctx.who;
        else return output('O WhatsApp ocultou seu número. Digite seu celular com DDD para o cadastro. O link de acesso será enviado nesta conversa e ao e-mail confirmado.', [EMAIL, EXIT], { step: 'signup_phone' });
      } else if (s.step === 'signup_phone') {
        let digits = text.replace(/\D/g, '');
        if (digits.length === 13 && digits.startsWith('55')) digits = digits.slice(2);
        if (!/^[1-9]\d9\d{8}$/.test(digits)) return output('Informe DDD + celular, por exemplo: 11 99999-0000.', [EMAIL, EXIT]);
        s.draft = { ...draft, phone: `55${digits}` };
      } else if (s.step === 'pending') return output('Cadastro aguardando aprovação. Para consultar novamente, informe seu e-mail.', [EMAIL, EXIT]);
      const info = await rpc('resident_bot_signup_info');
      if (!info?.term?.hash) return output(`Cadastro indisponível agora. Use o portal: ${ctx.appUrl}/c/${ctx.slug}`, [EMAIL, EXIT]);
      const units: { block: string | null; label: string }[] = (info.units?.units || []).filter((u: any) => u.label);
      const blocks = [...new Set(units.map((u) => u.block || ''))];
      const blockPage = (page = 0) => {
        const opts = blocks.slice(page * 7, page * 7 + 7).map((b, i) => ({ id: `rb:sb:${page * 7 + i}`, title: b || 'Sem bloco' }));
        if (page > 0) opts.push({ id: `rb:bp:${page - 1}`, title: 'Anterior' });
        if ((page + 1) * 7 < blocks.length) opts.push({ id: `rb:bp:${page + 1}`, title: 'Próximos' });
        return output('Selecione seu bloco, torre, quadra ou rua.', [...opts, EXIT], { step: 'signup_block' });
      };
      const unitPage = (page = 0) => {
        const choices = units.filter((u) => (u.block || '') === (s.draft?.block || ''));
        const opts = choices.slice(page * 7, page * 7 + 7).map((u, i) => ({ id: `rb:su:${page * 7 + i}`, title: u.label }));
        if (page > 0) opts.push({ id: `rb:up:${page - 1}`, title: 'Anterior' });
        if ((page + 1) * 7 < choices.length) opts.push({ id: `rb:up:${page + 1}`, title: 'Próximas' });
        return output('Selecione seu apartamento, casa ou lote.', [...opts, EXIT], { step: 'signup_unit' });
      };
      if (id.startsWith('rb:accept:') && s.step === 'signup_term' && id === `rb:accept:${s.nonce}`) {
        if (draft.privacy_hash !== info.term.hash) return output('O termo foi atualizado. Reinicie o cadastro para ler e aceitar a versão vigente.', [EMAIL, EXIT]);
        return { ...output('Solicitação em processamento.', [EXIT]), submitSignup: true };
      }
      if (id.startsWith('rb:sb:') && s.step === 'signup_block') {
        const selected = blocks[Number(id.slice(6))];
        if (selected !== undefined) { s.draft = { ...draft, block: selected }; return unitPage(); }
      }
      if (id.startsWith('rb:su:') && s.step === 'signup_unit') {
        const unit = units.filter((u) => (u.block || '') === (draft.block || ''))[Number(id.slice(6))];
        if (unit) {
          const n = nonce();
          return output(`Confira seu cadastro:\nNome: ${clean(draft.name)}\nCelular: ${clean(draft.phone)}\nUnidade: ${clean(unit.block)} ${clean(unit.label)}\n\nLeia o termo de dados (versão ${clean(info.term.version)}):\n${ctx.appUrl}/c/${ctx.slug}/termo-dados\n\nAo tocar em Aceitar e solicitar, você confirma os dados e o aceite do termo. O síndico precisa aprovar seu acesso.`,
            [{ id: `rb:accept:${n}`, title: 'Aceitar e solicitar' }, EMAIL, EXIT],
            { step: 'signup_term', nonce: n, draft: { ...draft, unit: unit.label, privacy_hash: info.term.hash } });
        }
      }
      if (id.startsWith('rb:bp:') && s.step === 'signup_block') return blockPage(Number(id.slice(6)));
      if (id.startsWith('rb:up:') && s.step === 'signup_unit') return unitPage(Number(id.slice(6)));
      if (s.step === 'signup_term') return output('Leia o termo e use o botão de aceite apresentado. Para corrigir seus dados, reinicie pelo e-mail.', [{ id: `rb:accept:${s.nonce}`, title: 'Aceitar e solicitar' }, EMAIL, EXIT]);
      if (!units.length) return output(`Nenhuma unidade disponível para seleção. Solicite pelo portal: ${ctx.appUrl}/c/${ctx.slug}`, [EMAIL, EXIT]);
      return s.step === 'signup_unit' ? unitPage() : blockPage();
    }
  }

  // Não confia no user_id guardado pela conversa: o banco revalida e-mail, vínculo e unidades a cada mensagem.
  const resolved = await rpc('resident_bot_resolve', { p_who: ctx.who });
  const links = resolved?.links || [];
  // Só a conta confirmada por e-mail + código nesta conversa; nunca outra pessoa que use o mesmo celular.
  const link = resolved?.verified_user_id ? links.find((l: any) => l.user_id === resolved.verified_user_id) : null;
  if (!link) return emailPrompt();
  s.user = link.user_id;
  const units: { id: string; label: string }[] = link.units || [];
  if (!units.some((u) => u.id === s.unit)) s.unit = units.length === 1 ? units[0].id : undefined;
  const call = (action: string, args: Record<string, unknown> = {}) => rpc('resident_bot_call', { p_who: ctx.who, p_user: s.user, p_action: action, p_args: { unit: s.unit, ...args } });
  const menu = (prefix = '') => output(`${prefix ? `${prefix}\n\n` : ''}${clean(ctx.tenantName)}\nOlá, ${clean(link.name)}.\n${clean(units.find((u) => u.id === s.unit)?.label || 'Todas as suas unidades')}\nEscolha uma opção:`, [
    { id: 'rb:w:0', title: 'Encomendas aguardando' }, { id: 'rb:h:0', title: 'Histórico e comprovantes' },
    { id: 'rb:k:0', title: 'Palavras-chave' }, { id: 'rb:kn', title: 'Nova palavra-chave' },
    { id: 'rb:u:0', title: 'Selecionar unidade' }, { id: 'rb:a', title: 'Meu cadastro e app' }, EXIT,
  ], { step: undefined, draft: undefined, nonce: undefined });
  if (id === 'rb:m' || (ev.kind === 'text' && START.test(text))) return menu();
  if (id.startsWith('rb:confirm:') && s.draft && id === `rb:confirm:${s.nonce}`) {
    const d = s.draft;
    if (d.action === 'keyword_save') await call('keyword_save', { unit: d.unit, keyword: d.keyword });
    else if (d.action === 'reject') await call('reject', { id: d.id, reason: d.reason, note: d.note });
    else if (d.action === 'keyword_cancel') await call('keyword_cancel', { id: d.id });
    else return menu();
    return menu(d.action === 'keyword_save' ? 'Palavra-chave registrada. Disponível para a portaria e o totem.' : d.action === 'reject' ? 'Recusa registrada. A portaria foi avisada.' : 'Palavra-chave cancelada.');
  }
  const confirm = (summary: string, draft: Record<string, string>) => {
    const n = nonce();
    return output(`${summary}\n\nConfirma esta ação?`, [{ id: `rb:confirm:${n}`, title: 'Confirmar' }, MENU, EXIT], { step: 'confirm', draft, nonce: n });
  };
  if (s.step === 'kw_word' && text) {
    if (text.length < 2 || text.length > 60) return output('Informe uma palavra-chave de 2 a 60 caracteres.', [MENU, EXIT]);
    return confirm(`Cadastrar palavra-chave: ${clean(text)}\nUnidade: ${clean(units.find((u) => u.id === s.unit)?.label)}`, { action: 'keyword_save', keyword: text, unit: s.unit! });
  }
  if (s.step === 'reject_note' && text && s.draft?.id) {
    if (text.length < 3 || text.length > 300) return output('Descreva o motivo em 3 a 300 caracteres.', [MENU, EXIT]);
    return confirm(`Recusar encomenda: ${clean(s.draft.ref)}\nMotivo: ${clean(text)}`, { ...s.draft, action: 'reject', reason: 'other', note: text });
  }
  const page = (rows: any[], current: number, route: string, rowId: (r: any) => string, label: (r: any) => string, title: string) => {
    const opts = rows.slice(current * 7, current * 7 + 7).map((r) => ({ id: rowId(r), title: label(r).slice(0, 24) }));
    if (current > 0) opts.push({ id: `${route}:${current - 1}`, title: 'Anterior' });
    if ((current + 1) * 7 < rows.length) opts.push({ id: `${route}:${current + 1}`, title: 'Próximos' });
    return output(title, [...opts, MENU], { step: undefined, draft: undefined });
  };
  if (id.startsWith('rb:u:')) return page(units, Number(id.slice(5)), 'rb:u', (u) => `rb:us:${u.id}`, (u) => u.label, 'Selecione sua unidade.');
  if (id.startsWith('rb:us:')) { if (units.some((u) => u.id === id.slice(6))) s.unit = id.slice(6); return menu(); }
  if (id === 'rb:kn') {
    if (!s.unit) return output('Selecione primeiro a unidade da entrega.', [{ id: 'rb:u:0', title: 'Selecionar unidade' }, MENU]);
    return output('Digite a palavra-chave de entrega (2 a 60 caracteres). Ela ficará disponível para a portaria e o totem após sua confirmação.', [MENU, EXIT], { step: 'kw_word', draft: undefined });
  }
  if (id.startsWith('rb:w:')) {
    const home = await call('home');
    const rows = (home.waiting || []).filter((p: any) => !p.rejected_at);
    return page(rows, Number(id.slice(5)), 'rb:w', (p) => `rb:p:${p.id}`, (p) => `${p.carrier} · ${p.ref}`, rows.length ? 'Encomendas aguardando retirada:' : 'Nenhuma encomenda aguardando retirada.');
  }
  if (id.startsWith('rb:h:')) {
    const rows = await call('history');
    return page(rows || [], Number(id.slice(5)), 'rb:h', (p) => `rb:p:${p.id}`, (p) => `${p.carrier} · ${p.ref}`, `Últimas 10 encomendas finalizadas. Histórico completo: ${ctx.appUrl}/c/${ctx.slug}/historico`);
  }
  if (id.startsWith('rb:p:')) {
    const p = await call('package', { id: id.slice(5) });
    const waiting = ['RECEBIDA', 'ARMAZENADA'].includes(p.status) && !p.rejected_at;
    return output(`Encomenda ${clean(p.ref)}\nTransportadora: ${clean(p.carrier)}\nRastreio: ${clean(p.tracking_code || 'Não informado')}\nSituação: ${clean(p.rejected_at ? 'Recusada' : p.status)}\nRecebida: ${date(p.received_at)}\n\n${ctx.appUrl}/c/${ctx.slug}/${p.receipt ? 'comprovante' : 'encomenda'}?p=${encodeURIComponent(p.id)} (requer login)`,
      waiting ? [{ id: `rb:q:${p.id}`, title: 'QR de retirada' }, { id: `rb:r:${p.id}`, title: 'Recusar encomenda' }, MENU] : [MENU, EXIT]);
  }
  if (id.startsWith('rb:q:')) {
    const r = await call('qr', { id: id.slice(5) });
    return output(`Abra o link pessoal para exibir seu QR de retirada:\n${ctx.appUrl}/qr?c=${encodeURIComponent(r.link)}\n\nO link abre uma única vez. Não compartilhe. Se precisar, gere outro pelo menu.`, [MENU, EXIT]);
  }
  if (id.startsWith('rb:r:')) {
    const p = await call('package', { id: id.slice(5) });
    return output(`Qual o motivo da recusa da encomenda ${clean(p.ref)}?`, [
      { id: `rb:rr:${p.id}:wrong_unit`, title: 'Não é da minha unidade' },
      { id: `rb:rr:${p.id}:cancelled`, title: 'Compra cancelada' },
      { id: `rb:rr:${p.id}:other`, title: 'Outro motivo' }, MENU]);
  }
  if (id.startsWith('rb:rr:')) {
    const [, , packageId, reason] = id.split(':');
    const p = await call('package', { id: packageId });
    const draft = { action: 'reject', id: packageId, ref: String(p.ref), reason };
    if (reason === 'other') return output('Descreva o motivo da recusa (3 a 300 caracteres).', [MENU, EXIT], { step: 'reject_note', draft });
    return confirm(`Recusar encomenda ${clean(p.ref)}\nMotivo: ${reason === 'wrong_unit' ? 'Não é da minha unidade' : 'Compra cancelada'}`, draft);
  }
  if (id.startsWith('rb:k:')) {
    const rows = (await call('keywords') || []).filter((k: any) => !s.unit || k.unit_id === s.unit);
    return page(rows, Number(id.slice(5)), 'rb:k', (k) => `rb:kd:${k.id}`, (k) => `${k.keyword} · ${k.status}`, rows.length ? 'Suas palavras-chave:' : 'Nenhuma palavra-chave. Use Nova palavra-chave no menu.');
  }
  if (id.startsWith('rb:kd:') || id.startsWith('rb:kc:')) {
    const k = (await call('keywords') || []).find((k: any) => k.id === id.slice(6));
    if (!k) return menu('Palavra-chave indisponível.');
    if (id.startsWith('rb:kc:')) return confirm(`Cancelar palavra-chave: ${clean(k.keyword)}`, { action: 'keyword_cancel', id: k.id });
    return output(`Palavra-chave: ${clean(k.keyword)}\nSituação: ${clean(k.status)}`, k.status === 'active' ? [{ id: `rb:kc:${k.id}`, title: 'Cancelar palavra-chave' }, MENU] : [MENU, EXIT]);
  }
  if (id === 'rb:a') return output(`Seu condomínio: ${clean(ctx.tenantName)}\nUnidades: ${units.map((u) => clean(u.label)).join(', ')}\n\nCadastro, notificações, visitantes e demais opções do aplicativo:\n${ctx.appUrl}/c/${ctx.slug}/conta\n\nEntre com seu e-mail e senha. Nunca envie sua senha pelo WhatsApp.`, [MENU, EXIT]);
  return menu();
}
