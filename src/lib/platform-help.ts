export const PLATFORM_SECTIONS = [
  ['overview', 'Visão geral'], ['tenants', 'Condomínios'], ['trials', 'Testes grátis'],
  ['plans', 'Planos'], ['orders', 'Pedidos e incidentes'], ['users', 'Usuários'],
  ['team', 'Equipe global'], ['notifications', 'Notificações'], ['contacts', 'Contatos e suporte'],
  ['support', 'Suporte'], ['organizations', 'Administradoras'], ['devices', 'Dispositivos'], ['quotes', 'Orçamentos e propostas'],
  ['costs', 'Custos e viabilidade'], ['legal', 'Jurídico e contratos'],
  ['reports', 'Relatórios'], ['audit', 'Auditoria'], ['settings', 'Configurações'], ['help', 'Ajuda'],
] as const;
export type PlatformSection = typeof PLATFORM_SECTIONS[number][0];
export const PLATFORM_HELP: { section: PlatformSection; title: string; text: string }[] = [
  { section: 'devices', title: 'Dispositivos gerenciados (quiosque Android)', text: 'Leitura de suporte: estado, versão do agente e restrições não aplicadas por condomínio. Abrir um condomínio é auditado. Comandos ficam com o síndico. Publicar versão do agente exige APK HTTPS assinado com a chave definitiva e o checksum do script android/scripts/signature-checksum.sh.' },
  { section: 'overview', title: 'Visão geral e funil', text: 'Indicadores vêm do servidor. O período filtra eventos datados; totais de situação atual não são histórico. O funil conta visitantes anônimos únicos, não vendas.' },
  { section: 'tenants', title: 'Suspender ou reativar condomínio', text: 'Confira ID, nome e situação. Alterar acesso não confirma pagamento nem estende assinatura. Justifique a mudança; o servidor valida a permissão.' },
  { section: 'trials', title: 'Estender teste e reativar expirado', text: 'Informe data e hora final absoluta no horário local do navegador. Reativar teste expirado exige escolha explícita e não equivale a assinatura paga.' },
  { section: 'plans', title: 'Publicação, preços e limites', text: 'Revise preços e franquias antes de publicar. Versionar preço não modifica pedidos pagos retroativamente. Limites representam franquias, não consumo.' },
  { section: 'orders', title: 'Resolver incidente financeiro', text: 'Resolver incidente registra tratamento administrativo. Não ativa condomínio, não quita pedido e não confirma Pix. Aguarde o fluxo financeiro oficial.' },
  { section: 'users', title: 'Usuários, vínculos e senha', text: 'Papel no condomínio difere de papel global. Revogar vínculo afeta somente o condomínio identificado. Redefinição de senha usa e-mail oficial, sem mostrar senhas.' },
  { section: 'team', title: 'Equipe global', text: 'owner administra; support atende; finance acompanha financeiro; auditor consulta. O servidor determina permissões efetivas e protege o último proprietário. Nunca compartilhe contas.' },
  { section: 'notifications', title: 'Repetir aviso terminal', text: 'Somente falhas terminais elegíveis podem voltar à fila. Solicitação aceita não significa entrega. Não repita avisos em processamento.' },
  { section: 'contacts', title: 'Atender contatos e suporte', text: 'Acompanhe solicitações pelas situações de atendimento. O acesso global não concede acesso a fotos, assinaturas ou conteúdo de encomendas dos clientes.' },
  { section: 'support', title: 'Chamados com protocolo', text: 'Assuma, responda e mude o status. Nota interna não aparece ao cliente. Nunca peça senha. Prazo de primeira resposta só aparece ao cliente depois de aprovado em Configurações do suporte.' },
  { section: 'organizations', title: 'Administradoras e carteiras', text: 'Uma administradora só vê um condomínio depois que o síndico aprova o vínculo; a plataforma pode criar vínculo com justificativa auditada. A carteira mostra apenas agregados.' },
  { section: 'quotes', title: 'Orçamentos e propostas', text: 'A sugestão de preço respeita o piso de custo e a margem; sem custos completos, pede revisão humana. Proposta enviada não muda; envio só por ação sua. Proposta em análise não é desconto aprovado.' },
  { section: 'costs', title: 'Custos e viabilidade', text: 'Preencha cada custo com fonte. Custo ausente não é zero: a viabilidade fica como não validada e preços em rascunho não podem ser ativados.' },
  { section: 'legal', title: 'Dados da contratada e documentos', text: 'Preencha os dados legais reais; documento só é publicado depois de aprovado, sem campos pendentes. Publicado é imutável; nova versão exige novo aceite quando houver mudança material.' },
  { section: 'reports', title: 'Filtrar e exportar', text: 'Aplique busca, situação, ID do condomínio e período UTC inclusivo. Cada página tem até 25 registros. CSV exporta somente a página carregada e autorizada. Proteja o arquivo.' },
  { section: 'audit', title: 'Auditoria de alterações', text: 'Consulte ator, ação, alvo e horário. Erros de permissão não são listas vazias. Não insira segredos nem dados de encomendas nas justificativas.' },
  { section: 'settings', title: 'Autenticação em dois fatores', text: 'Use o QR privado no aplicativo autenticador; confirme o código para ativar. Cancelar remove somente o cadastro pendente. Valide um fator existente para elevar a sessão.' },
  { section: 'help', title: 'Tour opcional do proprietário', text: 'O tour navega e destaca controles reais, sem executar alterações. Escape fecha; setas avançam ou voltam. Progresso individual salvo apenas neste navegador; nenhum segredo é armazenado.' },
];
export const OWNER_TOUR: { section: PlatformSection; target: string; title: string; text: string }[] = [
  { section: 'overview', target: 'platform-navigation', title: 'Painel global', text: 'Estas áreas respeitam suas permissões. O tour não abre operações de clientes.' },
  { section: 'tenants', target: 'platform-filters', title: 'Localize o alvo', text: 'Filtre antes de agir. Confira o ID: nomes podem se repetir.' },
  { section: 'trials', target: 'platform-results', title: 'Prazo explícito', text: 'Extensão exige data absoluta. Reativar teste expirado é uma escolha separada.' },
  { section: 'plans', target: 'platform-results', title: 'Revise o catálogo', text: 'Publicação, versões de preço e franquias têm efeitos comerciais. O tour não executa essas ações.' },
  { section: 'orders', target: 'platform-results', title: 'Financeiro', text: 'Resolver ocorrência não confirma pagamento nem ativa assinatura.' },
  { section: 'audit', target: 'platform-results', title: 'Rastreabilidade', text: 'Consulte alterações autorizadas. Exporte somente a página necessária.' },
  { section: 'settings', target: 'platform-mfa', title: 'Proteja sua conta', text: 'Configure ou valide o autenticador por iniciativa própria. O tour não lê QR nem códigos.' },
];
export function searchPlatformHelp(query: string) {
  const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR');
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return PLATFORM_HELP.filter(item => terms.every(term => normalize(`${item.title} ${item.text}`).includes(term)));
}
