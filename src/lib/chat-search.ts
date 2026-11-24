// Busca das Conversas do WhatsApp: puro (testável no Node), usado pela tela ConversasPage.

/** Ignora maiúsculas, acentos, espaços, traços e pontuação ("bl2ap11" acha "Bloco 2 - Apto 11"). */
export const searchKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Sem os termos de unidade ("bloco", "apto"...), também quando grudados no número: "bl02bap11" e "2 11" acham
 * "Bloco 02B - Apto 11". O rótulo só sai quando vem antes de um dígito, para não cortar nomes ("Ana" fica "ana").
 */
const LABEL = /(bloco|bl|torre|tr|quadra|qd|apartamento|apto|ap|unidade|un|casa|lote|lt)\.?\s*(?=\d)/g;
const unitKey = (s: string) => searchKey(s).replace(LABEL, '').replace(/(^|[a-z])0+(?=\d)/g, '$1');

export interface Searchable { name: string | null; unit: string | null; phone: string | null; last: { text: string } | null }

/** Procura em nome, unidade, telefone e texto da última mensagem. */
export function matches(c: Searchable, q: string) {
  const k = searchKey(q);
  if (!k) return true;
  if (searchKey(`${c.name || ''}|${c.unit || ''}|${c.phone || ''}|${c.last?.text || ''}`).includes(k)) return true;
  // Unidade com ou sem rótulo e zero à esquerda ("bl02bap11", "2b 11").
  const u = unitKey(q);
  if (u && unitKey(c.unit || '').includes(u)) return true;
  // Telefone com ou sem DDI/DDD.
  const digits = q.replace(/\D/g, '');
  return digits.length >= 4 && (c.phone || '').replace(/\D/g, '').includes(digits.replace(/^55(?=\d{10,11}$)/, ''));
}
