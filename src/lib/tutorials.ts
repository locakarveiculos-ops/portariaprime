/**
 * Tutoriais públicos por perfil (/tutoriais/sindico|portaria|morador).
 * Texto completo independente de vídeo. Cada passo pode apontar uma captura real
 * (public/screens, gerada por scripts/capture-screens.mjs com dados fictícios).
 * Revisão: v1, 23/10/2026. Atualize junto com a interface.
 */
import type { ScreenKey } from './screens';

export type Profile = 'sindico' | 'portaria' | 'morador';
export interface TutorialStep { title: string; text: string; screen?: ScreenKey }
export interface Tutorial {
  slug: string; profile: Profile; title: string; goal: string; before: string[];
  steps: TutorialStep[]; result: string; errors: [string, string][]; undo?: string; next?: string; keywords?: string;
}

export const PROFILES: Record<Profile, { title: string; intro: string }> = {
  sindico: { title: 'Síndico e administração', intro: 'Configure o condomínio, aprove moradores, organize a equipe e acompanhe a operação.' },
  portaria: { title: 'Portaria', intro: 'Receba, guarde, avise e entregue com comprovante, inclusive quando algo falha.' },
  morador: { title: 'Morador', intro: 'Peça acesso, saiba o que chegou, retire com QR e consulte comprovantes.' },
};

export const TUTORIALS: Tutorial[] = [
  // ------------------------------------------------------------------ Síndico
  {
    slug: 'criar-condominio', profile: 'sindico', title: 'Criar o condomínio e ativar o mês grátis', keywords: 'cadastro conta teste gratis trial',
    goal: 'Ter o condomínio no ar com um mês de calendário de teste, sem cartão.',
    before: ['E-mail que você acessa (a conta é confirmada por e-mail).', 'CNPJ do condomínio.'],
    steps: [
      { title: 'Crie sua conta', text: 'Na página inicial, toque em “Testar por um mês” e informe nome, e-mail e senha. Confirme o e-mail recebido.' },
      { title: 'Cadastre o condomínio', text: 'Informe nome, CNPJ, fuso horário e o endereço do portal (ex.: /c/residencial-exemplo). Escolha o plano que pretende usar depois do teste.' },
      { title: 'Ative o teste', text: 'Toque em “Ativar mês grátis”. O sistema mostra a data de início e a data de fim do teste.', screen: 'assinatura' },
    ],
    result: 'Condomínio criado e teste ativo até o mesmo dia do mês seguinte.', next: 'marca-e-portal',
    errors: [['Endereço já em uso', 'Escolha outro endereço para o portal; ele precisa ser único.'], ['Teste não disponível para este CNPJ', 'O mês grátis vale uma vez por condomínio. Fale com o suporte se for um engano.']],
  },
  {
    slug: 'marca-e-portal', profile: 'sindico', title: 'Configurar marca e link do condomínio', keywords: 'logo cores identidade portal link',
    goal: 'Moradores e equipe veem o nome, o logo e as cores do condomínio no portal, no app e nos comprovantes.',
    before: ['Logo em PNG ou JPG.'],
    steps: [
      { title: 'Abra Identidade visual', text: 'Configurações › Identidade visual. Envie o logo e ajuste as cores; o sistema avisa se o contraste ficar baixo.', screen: 'marcaA' },
      { title: 'Confira o portal', text: 'Configurações › Portal e aplicativo mostra o link e o QR do portal para divulgar aos moradores.' },
    ],
    result: 'Portal, app instalado e PDFs com a identidade do condomínio.', undo: 'Volte as cores ao padrão no mesmo módulo; comprovantes já emitidos mantêm a marca da época.', next: 'unidades',
    errors: [['Logo não aparece', 'Use PNG ou JPG de até 2 MB e salve de novo.']],
  },
  {
    slug: 'unidades', profile: 'sindico', title: 'Cadastrar unidades e importar planilha', keywords: 'apartamento bloco torre csv importar',
    goal: 'Ter todas as unidades cadastradas para receber encomendas.',
    before: ['Lista de blocos e unidades (pode ser planilha CSV).'],
    steps: [
      { title: 'Abra Unidades e moradores', text: 'Na aba Unidades, toque em “Nova unidade” ou “Importar CSV”.' },
      { title: 'Importe', text: 'Na importação, confira a prévia antes de confirmar. Unidades repetidas são ignoradas.' },
    ],
    result: 'Unidades listadas e disponíveis no recebimento.', undo: 'Desative uma unidade pelo menu (⋮); o histórico é mantido.', next: 'aprovar-moradores',
    errors: [['Limite do plano', 'O plano define o número de unidades ativas; desative unidades sem uso ou mude de plano.']],
  },
  {
    slug: 'aprovar-moradores', profile: 'sindico', title: 'Aprovar moradores', keywords: 'morador cadastro solicitação aprovar recusar',
    goal: 'Liberar o acesso de quem realmente mora na unidade.',
    before: ['Moradores pedem acesso pelo link do portal.'],
    steps: [
      { title: 'Abra Solicitações', text: 'Unidades e moradores › Solicitações. O sino avisa quando chega um pedido.' },
      { title: 'Confira e decida', text: 'Confira nome e unidade informada, escolha a unidade correta e aprove. Para recusar, informe o motivo.' },
    ],
    result: 'O morador recebe e-mail com a decisão e passa a ver as encomendas da unidade.', undo: 'Revogue o acesso na aba Moradores; vale na próxima ação dele.', next: 'equipe',
    errors: [['Unidade cheia', 'Há um limite de moradores por unidade nas configurações de operação.']],
  },
  {
    slug: 'equipe', profile: 'sindico', title: 'Convidar a equipe da portaria', keywords: 'porteiro zelador convite permissão',
    goal: 'Cada porteiro com acesso próprio e rastreável.',
    before: ['E-mail de cada pessoa.'],
    steps: [{ title: 'Convide', text: 'Configurações › Equipe e permissões › “Convidar equipe”. O convite só funciona para o e-mail informado.' }],
    result: 'Porteiro entra com a própria conta; cada entrega fica registrada com quem fez.', undo: 'Revogue o acesso na mesma tela.', next: 'locais',
    errors: [['Convite não chegou', 'Sem e-mail transacional configurado, o sistema mostra o link para você enviar manualmente.']],
  },
  {
    slug: 'locais', profile: 'sindico', title: 'Locais de guarda e capacidade', keywords: 'estante prateleira capacidade contingência',
    goal: 'Saber onde cada encomenda está e evitar local lotado.',
    before: [],
    steps: [{ title: 'Cadastre os locais', text: 'Configurações › Operação e armazenamento: estante, prateleira, capacidade e um local de contingência.', screen: 'armazenamento' }],
    result: 'A portaria recebe sugestão do local com espaço; local lotado não é escolhido sozinho.', next: 'canais',
    errors: [],
  },
  {
    slug: 'canais', profile: 'sindico', title: 'Canais de aviso e teste', keywords: 'whatsapp email push aviso teste canal',
    goal: 'Moradores avisados automaticamente na chegada e na retirada.',
    before: ['WhatsApp conforme plano e conexão do condomínio.'],
    steps: [
      { title: 'Confira os canais', text: 'Configurações › Comunicações mostra quais canais estão ativos.' },
      { title: 'Teste com um contato autorizado', text: 'Integrações e diagnóstico permite um envio de teste somente para contato autorizado.' },
    ],
    result: 'Avisos saem de uma fila no servidor, com novas tentativas automáticas; a tela da portaria pode ser fechada.', next: 'primeira-encomenda',
    errors: [['WhatsApp desconectado', 'O sistema avisa a administração e tenta de novo depois; os outros canais continuam.']],
  },
  {
    slug: 'primeira-encomenda', profile: 'sindico', title: 'Testar a primeira encomenda', keywords: 'teste primeira encomenda',
    goal: 'Ver o ciclo completo antes de liberar para todos.',
    before: ['Uma unidade com você mesmo (ou um morador que concordou) como contato.'],
    steps: [
      { title: 'Receba', text: 'Em Encomendas › Receber, registre uma encomenda de teste para essa unidade.', screen: 'recebimento' },
      { title: 'Entregue', text: 'Em Encomendas › Entregar, use o QR do app do morador, colete assinatura e foto do item.' },
      { title: 'Confira o comprovante', text: 'O PDF de entrega é gerado e enviado pelos canais configurados.', screen: 'comprovante' },
    ],
    result: 'Ciclo completo validado com dados que você controla.', next: 'painel',
    errors: [],
  },
  {
    slug: 'painel', profile: 'sindico', title: 'Analisar a Visão geral e relatórios', keywords: 'painel indicadores relatorio csv',
    goal: 'Acompanhar pendências, ocupação, tempo até a retirada e falhas de aviso.',
    before: [],
    steps: [
      { title: 'Operação', text: 'Visão geral › Operação: aguardando agora, acima do prazo, ocupação e o que precisa de atenção.', screen: 'painel' },
      { title: 'Análise', text: 'Aba Análise: período, comparação com o anterior, mediana e P90 do tempo até a retirada e horários de pico.' },
      { title: 'Relatórios', text: 'Relatórios: lista completa com filtros e exportação CSV.' },
    ],
    result: 'Números calculados no servidor, no fuso do condomínio.', next: 'contratacao',
    errors: [],
  },
  {
    slug: 'contratacao', profile: 'sindico', title: 'Contratar, cancelar e exportar', keywords: 'contrato plano pagamento cancelar exportar',
    goal: 'Seguir depois do teste com contrato e pagamento transparentes.',
    before: ['Permissão de faturamento no condomínio.'],
    steps: [
      { title: 'Revise e aceite', text: 'Configurações › Plano e assinatura: escolha plano e ciclo, leia o contrato completo e confirme o aceite.' },
      { title: 'Pague pelo link', text: 'Ao fim do teste é gerado um link de pagamento por ciclo. Não há débito automático.' },
      { title: 'Cancele quando quiser', text: 'O cancelamento mostra as datas e os efeitos antes de confirmar; o acesso segue até o fim do período pago.' },
    ],
    result: 'Contrato aceito guardado com versão e PDF; pagamento confirmado só após retorno do provedor.',
    errors: [['Paguei e aparece pendente', 'A confirmação vem do provedor e pode levar alguns minutos.']],
  },
  // ------------------------------------------------------------------ Portaria
  {
    slug: 'portaria-entrar', profile: 'portaria', title: 'Entrar e escolher o modo', keywords: 'login entrar totem',
    goal: 'Trabalhar com a própria conta.',
    before: ['Convite aceito.'],
    steps: [
      { title: 'Entre', text: 'Use seu e-mail e senha. Você cai direto em Encomendas.', screen: 'portariaMobile' },
      { title: 'Totem da equipe', text: '“Abrir totem” mostra botões grandes para o balcão. O totem público pareado é outra coisa: serve só a entregadores e não dá acesso a dados de moradores.' },
    ],
    result: 'Cada ação fica registrada com seu nome.', next: 'receber',
    errors: [],
  },
  {
    slug: 'receber', profile: 'portaria', title: 'Receber com leitura de etiqueta', keywords: 'receber ocr etiqueta foto camera',
    goal: 'Registrar a encomenda certa para a unidade certa.',
    before: [],
    steps: [
      { title: 'Fotografe a etiqueta', text: 'A leitura automática sugere destinatário, unidade e rastreio.', screen: 'recebimento' },
      { title: 'Confira e corrija', text: 'Revise tudo. Código de triagem da transportadora não é unidade nem estante.' },
      { title: 'Guarde', text: 'Confirme o local sugerido e marque que guardou fisicamente.' },
    ],
    result: 'Moradores da unidade são avisados automaticamente.', undo: 'Erro de cadastro: use Exceções › Cancelar com motivo; o registro fica no histórico.', next: 'entregar',
    errors: [['Leitura errada', 'Corrija os campos antes de salvar; a leitura é só sugestão.'], ['Câmera negada', 'Envie uma foto salva ou digite os dados.']],
  },
  {
    slug: 'entregar', profile: 'portaria', title: 'Entregar com QR, assinatura e foto', keywords: 'entregar retirada qr assinatura foto',
    goal: 'Entrega documentada e sem duplicidade.',
    before: ['Morador com o QR no app, ou documento conferido.'],
    steps: [
      { title: 'Leia o QR', text: 'Em Entregar, leia o QR. Ler o QR só localiza a encomenda; não conclui a entrega.' },
      { title: 'Colete as provas', text: 'Nome de quem retira, assinatura na tela e foto do item.' },
      { title: 'Confirme', text: 'A confirmação é única: duas pessoas não conseguem entregar a mesma encomenda.', screen: 'comprovante' },
    ],
    result: 'Comprovante em PDF gerado e enviado à unidade.', next: 'excecoes',
    errors: [['QR já usado ou vencido', 'Peça ao morador para gerar um novo no app.'], ['Sem QR', 'Use “Entregar sem QR” com justificativa; fica auditado.']],
  },
  {
    slug: 'excecoes', profile: 'portaria', title: 'Buscar, mover e exceções', keywords: 'buscar mover devolver extravio cancelar',
    goal: 'Resolver o que foge do fluxo normal.',
    before: [],
    steps: [
      { title: 'Buscar', text: 'Aba Buscar: por unidade, rastreio ou destinatário.' },
      { title: 'Mover', text: 'Troque o local de guarda; a movimentação fica registrada.' },
      { title: 'Devolver ou cancelar', text: 'Informe o motivo. Extravio é decisão do administrador.' },
    ],
    result: 'Histórico completo de cada encomenda.',
    errors: [['Internet caiu', 'Nada é considerado feito sem confirmação do servidor. Anote e registre quando voltar.'], ['Canal de aviso falhou', 'A encomenda continua registrada; o sistema tenta de novo e avisa a administração.']],
  },
  // ------------------------------------------------------------------ Morador
  {
    slug: 'pedir-acesso', profile: 'morador', title: 'Pedir acesso pelo portal', keywords: 'cadastro portal aprovação acesso',
    goal: 'Ter acesso às encomendas da sua unidade.',
    before: ['Link do portal do condomínio (a administração divulga).'],
    steps: [
      { title: 'Crie a conta', text: 'No portal, toque em “Criar minha conta” e confirme o e-mail.' },
      { title: 'Informe a unidade', text: 'Envie nome, bloco e unidade. A administração confere antes de liberar.' },
    ],
    result: 'Você recebe e-mail com a decisão. Enquanto isso, nenhum dado do condomínio aparece.', next: 'instalar',
    errors: [['Demorou', 'Fale com a portaria ou a administração.']],
  },
  {
    slug: 'instalar', profile: 'morador', title: 'Instalar o app e ativar notificações', keywords: 'instalar app notificação push iphone android',
    goal: 'Receber aviso no celular quando chegar algo.',
    before: [],
    steps: [
      { title: 'Instale', text: 'Android/Chrome: “Instalar aplicativo”. iPhone: Safari › Compartilhar › Adicionar à Tela de Início.' },
      { title: 'Ative as notificações', text: 'Minha conta › Notificações › “Ativar notificações neste dispositivo” e permita.' },
    ],
    result: 'Avisos no aparelho; tudo também fica em Notificações, dentro do app.', next: 'retirar',
    errors: [['Bloqueadas', 'Libere nas configurações do site no navegador e volte ao app.'], ['iPhone', 'Push só funciona com o app instalado na Tela de Início (iOS 16.4+).']],
  },
  {
    slug: 'retirar', profile: 'morador', title: 'Ver o que chegou e retirar com QR', keywords: 'qr retirar encomenda chegou',
    goal: 'Retirar sem fila de conferência.',
    before: [],
    steps: [
      { title: 'Abra o Início', text: 'O topo mostra quantas encomendas aguardam retirada.', screen: 'morador' },
      { title: 'Mostre o QR', text: 'Toque em “Mostrar QR de retirada” e apresente à portaria. A entrega só termina com a confirmação da equipe.' },
    ],
    result: 'A encomenda vai para o Histórico com o comprovante.', next: 'comprovante',
    errors: [['QR venceu', 'Toque em “Gerar novo código”.'], ['Sem celular', 'A portaria pode localizar pela unidade e conferir sua identidade.']],
  },
  {
    slug: 'comprovante', profile: 'morador', title: 'Consultar retirada e comprovante', keywords: 'comprovante pdf quem retirou',
    goal: 'Saber quem retirou e quando.',
    before: [],
    steps: [{ title: 'Abra o Histórico', text: 'Toque na encomenda para ver quem retirou, a linha do tempo e o PDF do comprovante.' }],
    result: 'PDF com protocolo, assinatura e foto do item.',
    errors: [['Comprovante em processamento', 'Volte em instantes.'], ['Não aparece', 'Só vê quem já estava na unidade no dia da retirada.']],
  },
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function searchTutorials(q: string, list = TUTORIALS) {
  const terms = norm(q).split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return list;
  return list.filter((t) => { const h = norm([t.title, t.goal, t.keywords || '', ...t.steps.map((s) => s.title + ' ' + s.text)].join(' ')); return terms.every((x) => h.includes(x)); });
}
