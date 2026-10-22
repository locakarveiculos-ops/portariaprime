/**
 * Central de ajuda: artigos em linguagem simples. Cada artigo é ligado a uma área (“Ajuda desta tela”)
 * e, quando existe, a um tour. Recursos de superadmin não aparecem aqui.
 * Revisão: v1, 21/10/2026.
 */
import type { Role } from './tours';
import type { ScreenKey } from './screens';

export interface Article {
  slug: string; title: string; category: string; roles: Role[]; areas: string[]; tour?: string; screen?: ScreenKey;
  forWho: string; when: string; before: string[]; steps: string[]; result: string; confirm: string;
  problems: [string, string][]; next: string[]; keywords?: string;
}

export const CATEGORIES = ['Primeiros passos', 'Síndico', 'Equipe e portaria', 'Morador', 'Totem', 'Encomendas e retiradas',
  'Notificações e aplicativo', 'Personalização', 'Plano, teste e cobrança', 'Segurança e permissões', 'Solução de problemas', 'Suporte'];

const ALL: Role[] = ['admin', 'porteiro', 'morador'];
const STAFF: Role[] = ['admin', 'porteiro'];

export const ARTICLES: Article[] = [
  {
    slug: 'primeiros-passos', title: 'Deixar o condomínio pronto para usar', category: 'Primeiros passos', roles: ['admin'], areas: ['configuracoes', 'painel'], tour: 'inicio-sindico', screen: 'painel',
    forWho: 'Síndico ou administrador que acabou de cadastrar o condomínio.', when: 'Logo depois de ativar o mês grátis.',
    before: ['Conta com e-mail confirmado.', 'Condomínio cadastrado em “Cadastre seu condomínio”.'],
    steps: ['Abra Configurações e salve nome, logo e cores.', 'Em “Portarias e locais de guarda”, cadastre as prateleiras ou salas com a capacidade de cada uma.', 'Abra Unidades e pessoas e cadastre as unidades (uma a uma ou por planilha).', 'Convide os porteiros em “Convidar equipe”.', 'Convide os moradores na linha de cada unidade.', 'Na Portaria, registre uma encomenda de teste e entregue.'],
    result: 'Porteiros conseguem receber e entregar; moradores recebem avisos.', confirm: 'O Painel mostra a encomenda de teste em “Entradas no período”.',
    problems: [['Não aparece “Configurações”', 'Seu acesso não tem a permissão de configurações. Peça ao administrador principal.'], ['Nenhum plano para escolher', 'O catálogo ainda não foi publicado pela Portaria Prime. Fale com o suporte.']],
    next: ['receber-encomenda', 'moradores-e-convites'],
  },
  {
    slug: 'unidades-e-importacao', title: 'Cadastrar unidades e importar planilha', category: 'Síndico', roles: ['admin'], areas: ['pessoas'], tour: 'unidades', keywords: 'apartamento casa bloco torre csv excel',
    forWho: 'Administrador com permissão de aprovar moradores.', when: 'Na implantação ou quando surgir uma nova unidade.',
    before: ['Lista das unidades (bloco e número).'],
    steps: ['Abra Unidades e pessoas.', 'Para uma unidade: preencha Bloco/Torre (opcional) e Unidade e toque em Adicionar.', 'Para várias: toque em Importar CSV e escolha o arquivo com as colunas bloco e unidade.', 'Confira a prévia e confirme.'],
    result: 'As unidades aparecem na lista e podem receber encomendas.', confirm: 'O contador “ativas de N no plano” aumenta.',
    problems: [['Erro ao importar CSV', 'Salve a planilha como CSV (separado por vírgula ou ponto e vírgula), com cabeçalho na primeira linha. Linhas repetidas são ignoradas.'], ['Limite do plano atingido', 'O plano tem um número máximo de unidades. Troque de plano em Assinatura ou desative unidades que não existem.']],
    next: ['moradores-e-convites'],
  },
  {
    slug: 'moradores-e-convites', title: 'Convidar, aprovar e remover moradores', category: 'Síndico', roles: ['admin'], areas: ['pessoas'], tour: 'moradores', keywords: 'morador convite aprovar vínculo mudança',
    forWho: 'Administrador com permissão de aprovar moradores.', when: 'Quando um morador chega ou sai.',
    before: ['Unidade cadastrada.', 'E-mail do morador.'],
    steps: ['Em Unidades e pessoas, toque em “Convidar morador” na linha da unidade.', 'Digite o e-mail e envie.', 'Se o e-mail automático não estiver configurado, copie o link exibido e envie por um canal seguro.', 'O morador cria a conta com o mesmo e-mail e aceita o convite.', 'Quando alguém se mudar, revogue o acesso na lista de pessoas.'],
    result: 'O morador vê só as encomendas da unidade dele.', confirm: 'O nome aparece em Pessoas com a unidade ativa.',
    problems: [['Morador diz que o convite é inválido', 'Convites expiram em 7 dias e valem uma vez. Gere um novo.'], ['“Enviado para outro e-mail”', 'O morador entrou com outra conta. Ele precisa usar o e-mail do convite.'], ['Morador sem vínculo', 'Saber bloco e número não dá acesso. O vínculo só existe depois que o convite é aceito.']],
    next: ['seguranca-acessos'],
  },
  {
    slug: 'equipe-e-permissoes', title: 'Equipe: porteiros e administradores', category: 'Equipe e portaria', roles: ['admin'], areas: ['pessoas'], tour: 'equipe', keywords: 'porteiro zelador funcionário permissão',
    forWho: 'Administrador com permissão de equipe.', when: 'Ao contratar ou desligar alguém.',
    before: ['E-mail da pessoa.'],
    steps: ['Em Unidades e pessoas, toque em “Convidar equipe”.', 'Escolha Porteiro ou Administrador.', 'Para administrador, marque só as permissões necessárias: equipe, aprovar moradores, configurações, faturamento.', 'Envie e acompanhe em Convites pendentes.', 'Para desligar, revogue o acesso na lista.'],
    result: 'A pessoa entra com o acesso escolhido.', confirm: 'Ela aparece na lista com o papel correto.',
    problems: [['Não consigo dar uma permissão', 'Você só pode conceder permissões que você mesmo tem.'], ['Convite antigo parou de funcionar', 'Se quem convidou perdeu a permissão, os convites pendentes dele são revogados.']],
    next: ['receber-encomenda'],
  },
  {
    slug: 'receber-encomenda', title: 'Receber uma encomenda', category: 'Encomendas e retiradas', roles: STAFF, areas: ['portaria', 'totem-equipe'], tour: 'receber', screen: 'recebimento', keywords: 'pacote encomenda chegada registrar etiqueta ocr foto totem estante prateleira',
    forWho: 'Porteiro e administrador.', when: 'Sempre que uma encomenda chegar.',
    before: ['Unidades cadastradas.', 'Assinatura ativa ou mês grátis.'],
    steps: ['Abra Totem da portaria (ou Portaria) e toque em Registrar encomenda.', 'Fotografe a etiqueta. Se o plano tiver leitura automática, toque em “Ler etiqueta automaticamente”: o sistema separa destinatário, remetente, complemento, rastreio, pedido e nota, e confere com os moradores ativos.', 'Leia o aviso de conferência. Só “confere” pré-seleciona a unidade; conflito, homônimo ou nome que não confere exigem escolher a unidade.', 'Escolha a transportadora e confira o rastreio (o leitor USB funciona no campo).', 'Confira o local sugerido (portaria › estante › prateleira), guarde a encomenda e marque “Guardei fisicamente em…”.', 'Toque em Registrar encomenda.'],
    result: 'A encomenda fica “aguardando retirada” e todos os moradores ativos da unidade são avisados (app, push, e-mail e WhatsApp, conforme configurado).', confirm: 'Aparece a mensagem “Encomenda registrada para…” e a encomenda está em Buscar.',
    problems: [['Leitura automática errou', 'A leitura é só sugestão. Corrija os campos antes de salvar.'], ['Local lotado', 'Escolha outro local ou um local de contingência. O sistema não inventa prateleira.'], ['Toquei duas vezes em Registrar', 'O sistema não duplica: a segunda tentativa devolve a mesma encomenda.'], ['“Esta mesma foto já registrou uma encomenda”', 'A foto é idêntica a uma encomenda que ainda aguarda retirada. Confira se não é duplicidade.'], ['Código como “RJ2-2” ou “LSP-105” virou unidade', 'São códigos de triagem da transportadora. O sistema descarta e avisa; escolha a unidade pelo complemento do destinatário.'], ['Recebimentos bloqueados', 'A assinatura está restrita. O síndico regulariza em Assinatura; retiradas continuam liberadas.']],
    next: ['entregar-encomenda'],
  },
  {
    slug: 'entregar-encomenda', title: 'Entregar com QR, assinatura e comprovante', category: 'Encomendas e retiradas', roles: STAFF, areas: ['portaria', 'totem-equipe'], tour: 'entregar', screen: 'comprovante', keywords: 'retirada entrega retirar qr assinatura comprovante foto item totem',
    forWho: 'Porteiro e administrador.', when: 'Quando o morador vier buscar.',
    before: ['Encomenda aguardando retirada.'],
    steps: ['Abra Totem da portaria e toque em Entregar ao morador.', 'Toque em “Ler QR Code do morador”. A leitura só consulta: o QR é usado apenas ao confirmar.', 'Confira a foto da etiqueta e busque a encomenda no local mostrado (“Buscar em: portaria › estante › prateleira”).', 'Digite quem está retirando e se é morador ou recebedor autorizado.', 'Peça a assinatura na tela e fotografe o item entregue (obrigatório).', 'Toque em Confirmar entrega.', 'Sem QR: use “Entregar sem QR” na lista e escreva a justificativa.'],
    result: 'A encomenda vira “Retirada”, o comprovante abre e todos os moradores da unidade recebem aviso com link do comprovante.', confirm: 'O comprovante mostra protocolo, local de retirada, operador, quem retirou, assinatura e foto do item.',
    problems: [['QR expirado ou já usado', 'Peça ao morador para tocar em “Gerar novo QR”.'], ['QR de outro condomínio', 'O sistema recusa. Confira se o morador está no condomínio certo.'], ['Assinatura ou foto ausente', 'A entrega não é concluída sem assinatura e foto do item.'], ['A internet caiu na hora de confirmar', 'Nada é confirmado offline. Toque em Confirmar de novo quando voltar: se a primeira chegou ao servidor, o mesmo protocolo é devolvido, sem duplicar.'], ['Duas pessoas entregaram ao mesmo tempo', 'Só uma entrega é aceita; a outra recebe aviso de que já foi retirada.']],
    next: ['comprovantes'],
  },
  {
    slug: 'comprovantes', title: 'Abrir e imprimir comprovantes', category: 'Encomendas e retiradas', roles: ALL, areas: ['portaria', 'morador'], keywords: 'recibo protocolo pdf imprimir',
    forWho: 'Todos.', when: 'Para conferir uma retirada.',
    before: ['Encomenda retirada.'],
    steps: ['Equipe: em Portaria › Buscar, procure a encomenda e toque em Comprovante.', 'Morador: em Minhas encomendas › Histórico, toque em Comprovante, ou abra o link recebido por e-mail/WhatsApp/push (exige login).', 'Toque em “Baixar PDF / imprimir” e escolha “Salvar como PDF”.'],
    result: 'Comprovante com protocolo e dados da retirada.', confirm: 'O protocolo começa com PP-.',
    problems: [['A imagem da assinatura não carrega', 'Os links das imagens são temporários. Feche e abra o comprovante de novo.']],
    next: [],
  },
  {
    slug: 'excecoes', title: 'Mover, devolver, extravio e cancelamento', category: 'Encomendas e retiradas', roles: STAFF, areas: ['portaria'], tour: 'excecoes', keywords: 'devolução extraviada cancelar mover prateleira',
    forWho: 'Porteiro (devolver) e administrador (todas).', when: 'Quando a encomenda sai do fluxo normal.',
    before: ['Encomenda aguardando retirada.'],
    steps: ['Em Portaria › Buscar, ache a encomenda.', 'Para trocar de local, toque no ícone de mover e escolha o novo local.', 'Para outras situações, toque em Exceção, escolha a situação e escreva o motivo (mínimo de 10 caracteres).'],
    result: 'A mudança fica no histórico com data e responsável.', confirm: 'A situação aparece no Painel em exceções.',
    problems: [['Não aparece Cancelada ou Extraviada', 'Só administradores registram essas situações.']],
    next: ['relatorios'],
  },
  {
    slug: 'armazenamento', title: 'Locais de guarda e ocupação', category: 'Síndico', roles: ['admin'], areas: ['configuracoes', 'painel'], screen: 'armazenamento', keywords: 'prateleira estante armário sala capacidade lotação',
    forWho: 'Administrador com permissão de configurações.', when: 'Na implantação ou ao mudar o espaço físico.',
    before: ['Pelo menos uma portaria.'],
    steps: ['Abra Configurações › Portarias e locais de guarda.', 'Preencha código, capacidade e, se for o caso, marque contingência.', 'Toque em Adicionar.', 'Acompanhe a ocupação no Painel.'],
    result: 'O recebimento sugere o local com mais espaço.', confirm: 'O local aparece no Painel com uso e capacidade.',
    problems: [['Tudo lotado', 'Aumente a capacidade, crie outro local ou use um local de contingência.']],
    next: ['receber-encomenda'],
  },
  {
    slug: 'relatorios', title: 'Painel, relatórios e exportação', category: 'Síndico', roles: ['admin'], areas: ['painel'], tour: 'relatorios', screen: 'painel', keywords: 'relatório csv planilha exportar indicadores',
    forWho: 'Administrador.', when: 'Para acompanhar a portaria.',
    before: [],
    steps: ['Abra Painel.', 'Escolha o período (De/Até) e a situação.', 'Veja indicadores, ocupação e a lista de encomendas.', 'Toque em Exportar CSV para baixar a planilha.'],
    result: 'Números do período no fuso do condomínio.', confirm: 'A planilha abre no Excel ou Google Planilhas.',
    problems: [['Lista incompleta', 'Toque em “Carregar mais” no fim da lista.']],
    next: [],
  },
  {
    slug: 'personalizar', title: 'Personalizar marca e cores', category: 'Personalização', roles: ['admin'], areas: ['configuracoes'], tour: 'identidade', screen: 'marcaA', keywords: 'logo cor tema escuro claro identidade',
    forWho: 'Administrador com permissão de configurações.', when: 'Na implantação.',
    before: ['Logo em PNG, JPEG ou WebP (até 1 MB).'],
    steps: ['Abra Configurações › Marca.', 'Mude o nome exibido, envie o logo e escolha as cores.', 'Confira o aviso de contraste.', 'Toque em Salvar.'],
    result: 'Todos do condomínio veem a nova identidade.', confirm: 'O logo aparece no menu.',
    problems: [['Cor com pouco contraste', 'Escolha uma cor mais escura para textos e botões.'], ['SVG não aceito', 'Por segurança, use PNG, JPEG ou WebP.']],
    next: [],
  },
  {
    slug: 'totem', title: 'Totem para entregadores', category: 'Totem', roles: ['admin'], areas: ['configuracoes'], tour: 'totem', keywords: 'tablet quiosque entregador autoatendimento',
    forWho: 'Administrador, nos planos com totem.', when: 'Para o entregador deixar encomendas sem esperar o porteiro.',
    before: ['Plano com totem.', 'Tablet com navegador.'],
    steps: ['Em Configurações › Totem, crie um dispositivo e copie o código.', 'No tablet, abra o endereço do totem e digite o código.', 'O entregador informa transportadora, rastreio e unidade.', 'O porteiro confere em Portaria (“Deixadas no totem”) antes do aviso ao morador.', 'Revogue o dispositivo se o tablet sumir.'],
    result: 'Pré-registros aparecem para conferência.', confirm: 'O pré-registro some da lista depois de conferido.',
    problems: [['Totem pede código de novo', 'O dispositivo foi revogado ou o condomínio está suspenso.']],
    next: ['receber-encomenda'],
  },
  {
    slug: 'morador-retirar', title: 'Morador: ver encomendas e retirar', category: 'Morador', roles: ['morador'], areas: ['morador', 'avisos'], tour: 'morador', screen: 'morador', keywords: 'qr retirar minhas encomendas',
    forWho: 'Morador com convite aceito.', when: 'Quando chegar um aviso.',
    before: ['Convite aceito.'],
    steps: ['Abra Minhas encomendas.', 'Em “Para retirar”, toque em “Mostrar QR de retirada”.', 'Mostre o QR na portaria.', 'Depois, o comprovante fica no Histórico.'],
    result: 'A encomenda sai de “Para retirar” e vai para o Histórico.', confirm: 'Aparece “Retirada” com o botão Comprovante.',
    problems: [['QR expirou', 'Toque em “Gerar novo QR”.'], ['Não vejo encomendas', 'Confirme com o síndico se você está vinculado à unidade certa.']],
    next: ['notificacoes'],
  },
  {
    slug: 'notificacoes', title: 'Avisos no celular e instalar o aplicativo', category: 'Notificações e aplicativo', roles: ALL, areas: ['morador', 'avisos', 'ajuda'], keywords: 'push notificação aviso instalar app pwa iphone android',
    forWho: 'Todos.', when: 'Para receber avisos no aparelho.',
    before: ['Navegador compatível com notificações.'],
    steps: ['Em Minhas encomendas, ative “Avisos neste aparelho” e permita as notificações.', 'Para instalar: no Android/Chrome use “Instalar aplicativo”; no iPhone use Compartilhar › Adicionar à Tela de Início.'],
    result: 'Avisos chegam mesmo com o app fechado, quando o aparelho permite.', confirm: 'O botão mostra que os avisos estão ativos.',
    problems: [['Permissão negada', 'Libere as notificações do site nas configurações do navegador e tente de novo.'], ['App não instala', 'É preciso HTTPS e um navegador compatível. No iPhone, só pelo Safari.'], ['Aviso não chegou', 'Avisos dependem do aparelho e do provedor. O aviso dentro do sistema continua em Avisos.']],
    next: [],
  },
  {
    slug: 'plano-e-pagamento', title: 'Mês grátis, plano, pagamento e cancelamento', category: 'Plano, teste e cobrança', roles: ['admin'], areas: ['assinatura'], tour: 'assinatura', screen: 'assinatura', keywords: 'teste gratis trial pagar boleto pix cartão cancelar plano preço',
    forWho: 'Administrador com permissão de faturamento.', when: 'Durante e depois do mês grátis.',
    before: [],
    steps: ['Abra Assinatura para ver início e fim do mês grátis e o valor depois do teste.', 'Para trocar de plano, escolha plano e ciclo e confirme.', 'Ao fim do teste, toque em “Pagar assinatura” para ir ao link seguro da InfinitePay (Pix ou cartão).', 'Para cancelar, toque em “Cancelar assinatura”.'],
    result: 'O período pago começa depois da confirmação do pagamento pela InfinitePay.', confirm: 'Assinatura mostra “Período pago até…”.',
    problems: [['Paguei e ainda aparece pendente', 'A confirmação é verificada com a InfinitePay e pode levar alguns minutos. Voltar do checkout não confirma o pagamento sozinho.'], ['Teste terminou', 'Há 7 dias de carência. Depois, novos recebimentos ficam bloqueados até o pagamento; consultas e retiradas continuam.'], ['Débito automático', 'Não existe. Cada renovação é paga por link.']],
    next: [],
  },
  {
    slug: 'seguranca-acessos', title: 'Quem vê o quê: segurança e permissões', category: 'Segurança e permissões', roles: ALL, areas: ['ajuda'], keywords: 'privacidade lgpd acesso dados segurança',
    forWho: 'Todos.', when: 'Para entender os acessos.',
    before: [],
    steps: ['Cada condomínio só vê os próprios dados.', 'Morador vê só a própria unidade; porteiro opera a portaria; administrador vê só o que as permissões dele permitem.', 'Fotos e assinaturas abrem por links temporários, só para quem tem acesso.', 'Acesso revogado vale na próxima ação, mesmo com o app aberto.'],
    result: 'Dados separados por condomínio e por pessoa.', confirm: 'Ao trocar de condomínio, o sistema troca marca e dados.',
    problems: [['Vejo um condomínio que não é meu', 'Avise o suporte imediatamente.']],
    next: [],
  },
  {
    slug: 'camera', title: 'Câmera negada ou indisponível', category: 'Solução de problemas', roles: STAFF, areas: ['portaria'], keywords: 'câmera permissão foto qr leitor',
    forWho: 'Equipe.', when: 'Quando a câmera não abre.',
    before: [],
    steps: ['Libere a câmera para o site nas configurações do navegador.', 'Sem câmera: envie uma imagem salva ou digite os dados da etiqueta.', 'Para entregar sem leitor de QR, use “Entregar sem QR” com justificativa.'],
    result: 'O trabalho continua sem câmera.', confirm: 'A encomenda é registrada normalmente.', problems: [], next: ['receber-encomenda'],
  },
  {
    slug: 'sem-internet', title: 'A internet caiu', category: 'Solução de problemas', roles: ALL, areas: ['portaria', 'morador'], keywords: 'offline internet conexão caiu',
    forWho: 'Todos.', when: 'Sem conexão.',
    before: [],
    steps: ['Não considere recebimentos, retiradas ou pagamentos feitos sem a confirmação do servidor.', 'Anote em papel o que for urgente.', 'Quando a conexão voltar, registre e confira as mensagens de confirmação.'],
    result: 'Nada é dado como feito sem o servidor confirmar.', confirm: 'A encomenda aparece em Buscar depois de registrada.', problems: [], next: [],
  },
  {
    slug: 'aviso-nao-enviado', title: 'Aviso ao morador não foi enviado', category: 'Solução de problemas', roles: ['admin'], areas: ['painel', 'configuracoes'], keywords: 'whatsapp email aviso falha notificação',
    forWho: 'Administrador.', when: 'O Painel mostra “Avisos com falha”.',
    before: [],
    steps: ['Confira em Configurações se o canal (e-mail/WhatsApp) está configurado e ativo.', 'Confira se o morador tem contato cadastrado.', 'O sistema tenta de novo automaticamente algumas vezes.'],
    result: 'A encomenda continua registrada mesmo se o aviso falhar.', confirm: 'O contador de falhas diminui.', problems: [], next: [],
  },
  {
    slug: 'suporte', title: 'Falar com o suporte', category: 'Suporte', roles: ALL, areas: ['ajuda'], keywords: 'contato ajuda atendimento suporte',
    forWho: 'Todos.', when: 'Quando a ajuda não resolver.',
    before: [],
    steps: ['Use o formulário “Falar com a Portaria Prime” no fim desta página.', 'Descreva a tela, o que tentou fazer e a mensagem de erro. Não envie senhas.'],
    result: 'Sua mensagem fica registrada para a equipe da Portaria Prime.', confirm: 'Aparece a confirmação de recebimento.', problems: [], next: [],
  },
];

const SYNONYMS: string[][] = [
  ['pacote', 'encomenda', 'caixa', 'correspondencia', 'entrega'],
  ['apartamento', 'unidade', 'apto', 'ap', 'casa'],
  ['entrega', 'retirada', 'retirar', 'buscar', 'entregar'],
  ['sindico', 'administrador', 'admin', 'gestor'],
  ['porteiro', 'portaria', 'zelador', 'equipe'],
  ['aviso', 'notificacao', 'push', 'alerta'],
  ['pagamento', 'pagar', 'cobranca', 'assinatura', 'plano', 'preco'],
  ['teste', 'gratis', 'trial'],
  ['qr', 'qrcode', 'codigo'],
];

export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const haystack = (a: Article) => normalize([a.title, a.category, a.forWho, a.when, a.keywords || '', ...a.steps, ...a.problems.flat()].join(' '));

/** Busca tolerante a acentos e sinônimos; cada termo (ou um sinônimo dele) precisa aparecer. */
export function searchArticles(list: Article[], q: string): Article[] {
  const terms = normalize(q).split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return list;
  const expand = (t: string) => SYNONYMS.find((g) => g.some((w) => w.startsWith(t) || t.startsWith(w))) || [t];
  return list.filter((a) => { const h = haystack(a); return terms.every((t) => expand(t).concat(t).some((w) => h.includes(w))); });
}

export const articlesFor = (role: Role) => ARTICLES.filter((a) => a.roles.includes(role));
export const articleFor = (area: string, role: Role) => articlesFor(role).find((a) => a.areas.includes(area));
