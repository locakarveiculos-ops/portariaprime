/**
 * Capturas reais do sistema (tenant fictício, stack local isolada), geradas por
 * `scripts/capture-screens.mjs` em public/screens. Usadas pela landing e pela ajuda.
 * Detalhes de rota/viewport/commit em docs/SCREENSHOTS_MANIFEST.md.
 */
export interface Screen { file: string; title: string; caption: string; width: number; height: number }

export const SCREENS = {
  painel: { file: '/screens/painel-desktop.webp', title: 'Painel do síndico', caption: 'Pendências, ocupação dos locais e retiradas do período.', width: 1440, height: 900 },
  recebimento: { file: '/screens/recebimento-desktop.webp', title: 'Recebimento na portaria', caption: 'Unidade, destinatário, rastreio e foto da etiqueta antes de salvar.', width: 1440, height: 900 },
  armazenamento: { file: '/screens/armazenamento-desktop.webp', title: 'Locais de guarda', caption: 'Capacidade e ocupação de cada prateleira ou sala.', width: 1440, height: 900 },
  portariaMobile: { file: '/screens/portaria-mobile.webp', title: 'Portaria no celular', caption: 'Receber, Entregar e Buscar em destaque.', width: 390, height: 844 },
  morador: { file: '/screens/morador-mobile.webp', title: 'Área do morador', caption: 'Encomendas disponíveis e QR de retirada de uso único.', width: 390, height: 844 },
  comprovante: { file: '/screens/comprovante-desktop.webp', title: 'Comprovante de retirada', caption: 'Protocolo, datas do servidor, operador e quem retirou.', width: 1440, height: 900 },
  marcaA: { file: '/screens/marca-a-desktop.webp', title: 'Condomínio A', caption: 'Logo e cores próprias do condomínio.', width: 1440, height: 900 },
  marcaB: { file: '/screens/marca-b-desktop.webp', title: 'Condomínio B', caption: 'Outro condomínio, outra identidade, dados separados.', width: 1440, height: 900 },
  assinatura: { file: '/screens/assinatura-desktop.webp', title: 'Mês grátis e plano', caption: 'Início e fim do teste, plano escolhido e valor depois do teste.', width: 1440, height: 900 },
} satisfies Record<string, Screen>;

export type ScreenKey = keyof typeof SCREENS;

/** Variante de 720 px gerada junto (só para capturas desktop). */
export const srcSet = (s: Screen) => (s.width > 720 ? `${s.file.replace('.webp', '-720.webp')} 720w, ${s.file} ${s.width}w` : undefined);
