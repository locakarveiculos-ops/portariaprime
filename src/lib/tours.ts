/**
 * Tours guiados por papel/módulo. Cada passo aponta para um elemento real `[data-tour="..."]`
 * da tela indicada. Passos cujo alvo não existe (plano/permissão) são pulados, nunca travam.
 * Tours não executam ações: só destacam e explicam. Ações com efeito ficam com o usuário.
 */
export type Role = 'admin' | 'porteiro' | 'morador';
export interface TourStep { area: string; target: string; title: string; body: string }
export interface Tour { id: string; title: string; goal: string; roles: Role[]; requires?: string; article: string; steps: TourStep[] }

export const TOUR_VERSION = 1;

export const TOURS: Tour[] = [
  {
    id: 'inicio-sindico', title: 'Primeiros passos do síndico', roles: ['admin'], article: 'primeiros-passos',
    goal: 'Deixar o condomínio pronto para receber a primeira encomenda.',
    steps: [
      { area: 'configuracoes', target: 'config-marca', title: 'Marca do condomínio', body: 'Coloque nome, logo e cores. Só o seu condomínio vê esta identidade.' },
      { area: 'configuracoes', target: 'config-locais', title: 'Locais de guarda', body: 'Cadastre prateleiras ou salas com a capacidade de cada uma. O sistema sugere o local com mais espaço.' },
      { area: 'pessoas', target: 'unidades-form', title: 'Unidades', body: 'Cadastre bloco e unidade um a um, ou importe uma planilha CSV.' },
      { area: 'configuracoes', target: 'config-equipe', title: 'Equipe', body: 'Em Configurações › Equipe, convide porteiros pelo e-mail. Cada pessoa só recebe o acesso que você conceder.' },
      { area: 'portaria', target: 'portaria-abas', title: 'Teste na portaria', body: 'Registre uma encomenda de teste em Receber e entregue em Entregar.' },
    ],
  },
  {
    id: 'unidades', title: 'Unidades e importação', roles: ['admin'], requires: 'approve', article: 'unidades-e-importacao',
    goal: 'Cadastrar as unidades do condomínio.',
    steps: [
      { area: 'pessoas', target: 'unidades-form', title: 'Nova unidade', body: 'Toque em “Nova unidade”. Bloco/Torre é opcional; Unidade é obrigatória, por exemplo 101 ou Casa 12.' },
      { area: 'pessoas', target: 'unidades-importar', title: 'Planilha CSV', body: 'Importe várias de uma vez. Você vê uma prévia antes de confirmar.' },
      { area: 'pessoas', target: 'unidades-lista', title: 'Lista', body: 'No menu (⋮) da unidade, desative as que não existem mais. O histórico é preservado.' },
    ],
  },
  {
    id: 'moradores', title: 'Moradores, convites e aprovação', roles: ['admin'], requires: 'approve', article: 'moradores-e-convites',
    goal: 'Dar acesso aos moradores certos.',
    steps: [
      { area: 'pessoas', target: 'unidades-lista', title: 'Convidar morador', body: 'Convite é opcional: no menu (⋮) da unidade, toque em “Convidar morador”. Vale para um e-mail e expira em 7 dias.' },
      { area: 'pessoas?aba=solicitacoes', target: 'solicitacoes', title: 'Solicitações', body: 'Moradores pedem acesso pelo link do portal. Confira a unidade e aprove; saber o apartamento não dá acesso a ninguém.' },
      { area: 'pessoas?aba=moradores', target: 'moradores-lista', title: 'Mudança de morador', body: 'Quando alguém se mudar, revogue o acesso no menu (⋮). Vale na hora, mesmo com o app aberto.' },
    ],
  },
  {
    id: 'equipe', title: 'Equipe e permissões', roles: ['admin'], requires: 'team', article: 'equipe-e-permissoes',
    goal: 'Convidar porteiros e outros administradores com o mínimo de acesso.',
    steps: [
      { area: 'configuracoes', target: 'config-equipe', title: 'Convidar', body: 'Em Configurações › Equipe, escolha porteiro ou administrador. Administradores recebem só as permissões marcadas.' },
      { area: 'configuracoes', target: 'config-equipe', title: 'Desligar', body: 'Na mesma tela, revogue o acesso de quem saiu da equipe. Convites que essa pessoa emitiu também perdem validade.' },
    ],
  },
  {
    id: 'receber', title: 'Receber uma encomenda', roles: ['admin', 'porteiro'], article: 'receber-encomenda',
    goal: 'Registrar a chegada de uma encomenda com segurança.',
    steps: [
      { area: 'portaria', target: 'portaria-abas', title: 'Receber', body: 'Toque em Receber. Entregar e Buscar ficam ao lado.' },
      { area: 'portaria', target: 'receber-foto', title: 'Foto da etiqueta', body: 'Opcional. Se o plano tiver leitura automática, o sistema sugere os dados, e você confere.' },
      { area: 'portaria', target: 'receber-unidade', title: 'Unidade', body: 'Digite bloco e número, por exemplo “A 101”, e escolha na lista.' },
      { area: 'portaria', target: 'receber-local', title: 'Local de guarda', body: 'O sistema sugere a estante com mais espaço. Guarde a encomenda e marque “Guardei fisicamente”. Lotado = aviso, nunca local inventado.' },
      { area: 'portaria', target: 'receber-salvar', title: 'Salvar', body: 'Só considere registrado depois da mensagem de confirmação. O morador é avisado em seguida.' },
    ],
  },
  {
    id: 'entregar', title: 'Entregar com QR, assinatura e comprovante', roles: ['admin', 'porteiro'], article: 'entregar-encomenda',
    goal: 'Entregar ao morador e guardar a prova da retirada.',
    steps: [
      { area: 'portaria', target: 'portaria-abas', title: 'Entregar', body: 'Toque em Entregar e leia o QR do morador com a câmera.' },
      { area: 'portaria', target: 'entregar-qr', title: 'Leitura do QR', body: 'Ler o QR só consulta e mostra onde está a encomenda. Ao confirmar, colete assinatura e foto do item; o QR é usado nessa hora.' },
      { area: 'portaria', target: 'aguardando-lista', title: 'Sem QR', body: 'Ache a encomenda na lista e use “Entregar sem QR”. Exige justificativa, que fica no histórico.' },
    ],
  },
  {
    id: 'excecoes', title: 'Mover, devolver e exceções', roles: ['admin', 'porteiro'], article: 'excecoes',
    goal: 'Registrar o que aconteceu fora do fluxo normal.',
    steps: [
      { area: 'portaria', target: 'aguardando-lista', title: 'Ações da encomenda', body: 'Mover troca o local de guarda. Exceção registra devolução, extravio ou cancelamento, sempre com motivo.' },
      { area: 'portaria', target: 'historico-busca', title: 'Histórico', body: 'Busque qualquer encomenda antiga e abra o comprovante das retiradas.' },
    ],
  },
  {
    id: 'relatorios', title: 'Visão geral e relatórios', roles: ['admin'], article: 'relatorios',
    goal: 'Acompanhar a operação, analisar tendências e exportar dados.',
    steps: [
      { area: 'painel', target: 'painel-kpis', title: 'Indicadores de agora', body: 'Aguardando retirada, acima do prazo, ocupação e pendências. Toque para ver a lista.' },
      { area: 'painel', target: 'painel-atencao', title: 'Precisa de atenção', body: 'O que exige ação, em ordem de prioridade, com o atalho para resolver.' },
      { area: 'painel', target: 'painel-ocupacao', title: 'Ocupação', body: 'Quanto de cada local está ocupado. Laranja a partir de 85%, vermelho lotado.' },
      { area: 'painel', target: 'painel-abas', title: 'Análise', body: 'Na aba Análise: período, comparação com o anterior, tempo até a retirada e horários de pico.' },
      { area: 'relatorios', target: 'painel-exportar', title: 'Relatórios', body: 'Lista completa com filtros e planilha CSV do período.' },
    ],
  },
  {
    id: 'identidade', title: 'Identidade e configurações', roles: ['admin'], requires: 'settings', article: 'personalizar',
    goal: 'Personalizar o condomínio e ajustar a operação.',
    steps: [
      { area: 'configuracoes', target: 'config-marca', title: 'Marca', body: 'Logo PNG, JPEG ou WebP, cores e tema. A prévia mostra o contraste antes de salvar.' },
      { area: 'configuracoes', target: 'config-locais', title: 'Portarias e locais', body: 'Uma portaria pode ter vários locais. Marque um local como contingência para quando o resto lotar.' },
      { area: 'configuracoes', target: 'config-canais', title: 'Avisos', body: 'Escolha quais avisos o morador recebe. Canais não configurados aparecem como indisponíveis.' },
    ],
  },
  {
    id: 'totem', title: 'Totem para entregadores', roles: ['admin'], requires: 'settings', article: 'totem',
    goal: 'Parear um tablet para o entregador deixar a encomenda.',
    steps: [
      { area: 'configuracoes', target: 'config-totem', title: 'Parear', body: 'Gere o código de pareamento e abra o endereço no tablet. Revogue a qualquer momento.' },
    ],
  },
  {
    id: 'assinatura', title: 'Plano, mês grátis e pagamento', roles: ['admin'], requires: 'billing', article: 'plano-e-pagamento',
    goal: 'Entender o teste, o preço e como pagar ou cancelar.',
    steps: [
      { area: 'assinatura', target: 'assinatura-resumo', title: 'Resumo', body: 'Início e fim do mês grátis, plano escolhido e valor depois do teste.' },
      { area: 'assinatura', target: 'assinatura-uso', title: 'Uso do plano', body: 'Unidades, portarias e franquias usadas no mês.' },
      { area: 'assinatura', target: 'assinatura-troca', title: 'Trocar de plano', body: 'Durante o teste a troca vale na hora. Depois, vale no próximo ciclo.' },
      { area: 'assinatura', target: 'assinatura-cancelar', title: 'Cancelar', body: 'O acesso continua até o fim do período liberado. Nada é apagado.' },
    ],
  },
  {
    id: 'morador', title: 'Minhas encomendas e QR', roles: ['morador'], article: 'morador-retirar',
    goal: 'Saber o que chegou e retirar na portaria.',
    steps: [
      { area: 'morador', target: 'morador-aguardando', title: 'Para retirar', body: 'Aqui aparecem as encomendas que chegaram para a sua unidade.' },
      { area: 'morador', target: 'morador-qr', title: 'QR de retirada', body: 'Mostre este QR na portaria. Vale uma vez e expira; não envie em grupos.' },
      { area: 'morador', target: 'morador-historico', title: 'Histórico e comprovante', body: 'Depois da retirada, o comprovante fica aqui.' },
      { area: 'morador', target: 'push-toggle', title: 'Avisos no celular', body: 'Ative as notificações neste aparelho. Depende do navegador e da permissão.' },
    ],
  },
];

export function toursFor(role: Role, can: (p: string) => boolean): Tour[] {
  return TOURS.filter((t) => t.roles.includes(role) && (!t.requires || can(t.requires)));
}

const key = (user: string, tenant: string) => `pp_tours:v${TOUR_VERSION}:${user}:${tenant}`;
/** ponytail: progresso por usuário/tenant/versão no navegador; mover para tabela se precisar valer entre aparelhos. */
export function loadProgress(user: string, tenant: string): Record<string, 'done' | 'skipped' | number> {
  try { return JSON.parse(localStorage.getItem(key(user, tenant)) || '{}'); } catch { return {}; }
}
export function saveProgress(user: string, tenant: string, id: string, v: 'done' | 'skipped' | number | null) {
  try {
    const p = loadProgress(user, tenant);
    if (v === null) delete p[id]; else p[id] = v;
    localStorage.setItem(key(user, tenant), JSON.stringify(p));
  } catch { /* armazenamento indisponível: tour continua funcionando sem lembrar */ }
}
export function resetProgress(user: string, tenant: string) {
  try { localStorage.removeItem(key(user, tenant)); } catch { /* ok */ }
}
