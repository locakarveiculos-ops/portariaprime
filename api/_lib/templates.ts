/**
 * Templates de mensagens. Todo texto variável é escapado; nada de HTML vindo do
 * navegador. Marca do condomínio no conteúdo, assinatura Portaria Prime discreta.
 */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// WhatsApp usa *negrito*; remove marcadores para o dado não alterar a formatação.
const wa = (s: unknown) => String(s ?? '').replace(/[*_~`]/g, '').slice(0, 120);

export interface MessageCtx {
  trial_ends_at?: string | null;
  admin_name?: string | null;
  tenant_name: string;
  tenant_slug: string;
  timezone: string;
  color_primary?: string | null;
  package?: {
    carrier?: string; tracking_code?: string | null; received_at?: string; picked_up_at?: string | null;
    picked_up_by?: string | null; storage_code?: string | null; unit?: string; protocol?: string | null; id?: string; pdf_path?: string | null;
  } | null;
  support?: { ticket_id?: string; protocol?: string } | null;
  contract?: {
    id?: string; document_version?: string; document_sha256?: string; accepted_at?: string; plan_name?: string; cycle?: string;
    amount_cents?: number; representative_name?: string; pdf_path?: string | null; pdf_sha256?: string | null;
  } | null;
}

const fmt = (iso: string | null | undefined, tz: string) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }) : '';
const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const CYCLE: Record<string, string> = { monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };

export function render(event: string, ctx: MessageCtx, payload: any, appUrl: string) {
  const p = ctx.package || {};
  const home = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/inicio`;
  // Chegada abre o detalhe atual da encomenda (se já foi retirada, mostra o comprovante, nunca QR inválido).
  const link = p.id ? `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/encomenda?p=${encodeURIComponent(p.id)}` : home;
  // Link estável: abre após login, só para quem tem vínculo com a unidade (nada público).
  const receiptLink = p.id ? `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/comprovante?p=${encodeURIComponent(p.id)}` : home;
  const billingLink = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/assinatura`;
  switch (event) {
    case 'package_received':
      return {
        subject: `Encomenda na portaria — ${ctx.tenant_name}`,
        push: { title: 'Nova encomenda na portaria', body: `${p.carrier || 'Encomenda'} aguardando retirada.`, url: link },
        whatsapp:
          `*${wa(ctx.tenant_name)}*\nChegou uma encomenda para a sua unidade.\n\n` +
          `Transportadora: ${wa(p.carrier)}\n` + (p.tracking_code ? `Rastreio: ${wa(p.tracking_code)}\n` : '') +
          `Recebida em: ${fmt(p.received_at, ctx.timezone)}\n\nAbra o app para ver o QR Code de retirada:\n${link}`,
        lines: [
          ['Unidade', p.unit], ['Transportadora', p.carrier], ['Rastreio', p.tracking_code],
          ['Recebida em', fmt(p.received_at, ctx.timezone)],
        ],
        cta: ['Ver QR Code de retirada', link],
        intro: 'Uma encomenda chegou para a sua unidade e está guardada na portaria.',
      };
    case 'package_picked_up':
      return {
        subject: `${ctx.tenant_name} — Comprovante de entrega — Unidade ${p.unit || ''}`,
        push: { title: 'Encomenda retirada', body: 'O comprovante está disponível no app.', url: receiptLink },
        whatsapp:
          `*${wa(ctx.tenant_name)}*\nEncomenda retirada por ${wa(p.picked_up_by)} em ${fmt(p.picked_up_at, ctx.timezone)}.\n` +
          (p.protocol ? `Protocolo: ${wa(p.protocol)}\n` : '') + `Comprovante (requer login): ${receiptLink}`,
        lines: [['Unidade', p.unit], ['Retirada por', p.picked_up_by], ['Data', fmt(p.picked_up_at, ctx.timezone)], ['Protocolo', p.protocol]],
        cta: ['Ver comprovante', receiptLink],
        intro: 'Uma encomenda da sua unidade foi retirada na portaria. O comprovante em PDF segue anexo.',
      };
    case 'portal_welcome': {
      const portal = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}`;
      const until = ctx.trial_ends_at ? ` Seu período de teste termina em ${fmt(ctx.trial_ends_at, ctx.timezone).split(',')[0]}.` : '';
      const intro = `Olá, ${ctx.admin_name || 'administrador(a)'}. O portal do ${ctx.tenant_name} está disponível: ${portal}. Acesse Administração para concluir as configurações. Você também pode compartilhar esse endereço com os moradores para que solicitem cadastro.${until}`;
      return {
        subject: `Portal do ${ctx.tenant_name} está no ar`,
        whatsapp: `*${wa(ctx.tenant_name)}*
${wa(intro).slice(0, 600)}

Equipe Portaria Prime`,
        intro, lines: [], cta: ['Abrir o portal', portal],
      };
    }
    case 'access_request':
      return {
        subject: `Nova solicitação de cadastro — ${ctx.tenant_name}`,
        push: { title: 'Nova solicitação de cadastro', body: 'Um morador pediu acesso. Toque para revisar.', url: `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/pessoas` },
        intro: 'Um morador pediu acesso ao condomínio.', lines: [], cta: ['Revisar solicitações', `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/pessoas`],
      };
    case 'access_decision': {
      const ok = !!payload?.approved;
      return {
        subject: ok ? `Cadastro aprovado — ${ctx.tenant_name}` : `Cadastro não aprovado — ${ctx.tenant_name}`,
        intro: ok ? 'Seu cadastro foi aprovado. Você já pode acompanhar as encomendas da sua unidade.'
          : 'Sua solicitação de cadastro não foi aprovada. Procure a administração do condomínio para mais informações.',
        lines: [], cta: ['Abrir o portal', `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}`],
      };
    }
    case 'ops_alert':
      return {
        subject: `Alerta — ${ctx.tenant_name}`,
        push: { title: 'Alerta da portaria', body: 'Há um alerta operacional. Toque para ver.', url: `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/configuracoes` },
        intro: 'Há um alerta operacional no condomínio.', lines: [], cta: ['Abrir configurações', `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/configuracoes`],
      };
    case 'trial_reminder': {
      const when = fmt(payload.trial_ends_at, ctx.timezone);
      const after = `${brl(payload.amount_cents)} (${CYCLE[payload.cycle] || payload.cycle})`;
      const intro = payload.kind === 'trial_end'
        ? `O mês grátis do ${ctx.tenant_name} terminou em ${when}. Para continuar, pague a assinatura: ${after}.`
        : `O mês grátis do ${ctx.tenant_name} termina em ${when}. Depois disso, o valor será ${after}, pago por link — sem débito automático.`;
      return { subject: 'Seu mês grátis da Portaria Prime', intro, lines: [], cta: ['Gerenciar assinatura', billingLink] };
    }
    case 'billing_order':
      return {
        subject: 'Pagamento da assinatura disponível',
        intro: `A cobrança de ${brl(payload.amount_cents)} (plano ${payload.plan_name}, ${CYCLE[payload.cycle] || payload.cycle}) está disponível.`,
        lines: [], cta: ['Pagar assinatura', billingLink],
      };
    case 'billing_paid':
      return {
        subject: 'Pagamento confirmado — Portaria Prime',
        intro: `Recebemos o pagamento de ${brl(payload.amount_cents)}. Assinatura válida até ${fmt(payload.period_end, ctx.timezone)}.`,
        lines: [], cta: ['Ver assinatura', billingLink],
      };
    case 'support_reply': {
      // Sem conteúdo da conversa: só protocolo e link autenticado para o chamado.
      const protocol = /^SUP-\d{4}-\d{6,}$/.test(ctx.support?.protocol || '') ? ctx.support!.protocol! : '';
      const ticket = /^[0-9a-f-]{36}$/i.test(ctx.support?.ticket_id || '') ? `?chamado=${ctx.support!.ticket_id}` : '';
      const url = `${appUrl}/c/${encodeURIComponent(ctx.tenant_slug)}/suporte${ticket}`;
      return {
        subject: `Resposta do suporte${protocol ? ` — ${protocol}` : ''}`,
        push: { title: 'Resposta do suporte', body: `Seu chamado ${protocol} tem uma nova resposta.`.replace('  ', ' '), url },
        intro: `A equipe da Portaria Prime respondeu ao seu chamado${protocol ? ` ${protocol}` : ''}. Abra o app para ler a resposta. Nunca pedimos sua senha.`,
        lines: [['Protocolo', protocol]], cta: ['Ver chamado', url],
      };
    }
    case 'quote_sent': {
      // Token no fragmento (#): não vai para logs de servidor nem para o Referer.
      const q = (ctx as any).quote || {};
      const url = `${appUrl}/proposta#${encodeURIComponent(String(payload.token || ''))}`;
      return {
        subject: `Sua proposta Portaria Prime — ${payload.protocol}`,
        intro: `Olá, ${q.contact_name || ''}. Preparamos a proposta para ${q.org_name || 'o seu condomínio'}: plano ${payload.plan_name}, `
          + `${brl(payload.amount_cents)} por ciclo ${CYCLE[payload.cycle] || payload.cycle}, válida até ${fmt(payload.valid_until, ctx.timezone).split(',')[0]}. `
          + 'Proposta sujeita às condições descritas no link.',
        lines: [['Protocolo', payload.protocol], ['Solicitação', q.protocol]],
        cta: ['Ver proposta', url],
      };
    }
    case 'contract_copy': {
      const c = ctx.contract || {};
      const when = fmt(c.accepted_at, ctx.timezone);
      return {
        subject: `Cópia do contrato aceito — Portaria Prime — ${ctx.tenant_name}`,
        whatsapp: `*Portaria Prime*\nCópia do contrato aceito por ${wa(ctx.tenant_name)} em ${when} (versão ${wa(c.document_version)}).\nO PDF está disponível em Configurações › Plano e assinatura: ${billingLink}`,
        intro: `Segue em anexo a cópia do contrato aceito eletronicamente para ${ctx.tenant_name}. O aceite não é pagamento: a cobrança segue por link a cada ciclo.`,
        lines: [['Versão do contrato', c.document_version], ['Aceito em', when],
          ['Plano', c.plan_name ? `${c.plan_name} · ${CYCLE[c.cycle || ''] || c.cycle || ''}` : null],
          ['Valor por ciclo', c.amount_cents ? brl(c.amount_cents) : null], ['SHA-256 do documento', c.document_sha256]],
        cta: ['Ver plano e assinatura', billingLink],
      };
    }
    default:
      throw new Error(`Evento sem template: ${event}`);
  }
}

export function emailHtml(ctx: MessageCtx, m: { intro: string; lines: any[][]; cta: string[] }) {
  const color = /^#[0-9A-Fa-f]{6}$/.test(ctx.color_primary || '') ? ctx.color_primary : '#101F30';
  const rows = m.lines.filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#526174;font-size:13px">${esc(k)}</td><td style="padding:6px 0;color:#18283A;font-size:14px;font-weight:600;text-align:right">${esc(v)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F7F5F0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${color};padding:20px 24px;color:#fff;font-size:18px;font-weight:700">${esc(ctx.tenant_name)}</td></tr>
<tr><td style="padding:24px"><p style="margin:0 0 16px;color:#18283A;font-size:15px;line-height:1.5">${esc(m.intro)}</p>
${rows ? `<table role="presentation" width="100%">${rows}</table>` : ''}
<p style="margin:24px 0 0"><a href="${esc(m.cta[1])}" style="display:inline-block;background:#101F30;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(m.cta[0])}</a></p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;color:#526174;font-size:11px">Tecnologia Portaria Prime · Cada encomenda. Tudo sob controle.</td></tr>
</table></td></tr></table></body></html>`;
}
