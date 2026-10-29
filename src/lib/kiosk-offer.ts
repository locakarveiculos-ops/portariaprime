/**
 * Modo Portaria Exclusiva (quiosque Android gerenciado): textos comerciais únicos, usados na landing,
 * em /planos, no cadastro, na contratação, na ajuda e no backend. Sem React/Vite (testável no Node).
 * Estado real: validado em emulador Android 14 e testes automatizados; SEM homologação em aparelho físico.
 * Por isso é divulgado como acesso piloto, com liberação sujeita à validação de compatibilidade.
 */
export const KIOSK = {
  name: 'Modo Portaria Exclusiva',
  feature: 'Modo Portaria Exclusiva para Android*',
  description: 'Transforme um dispositivo Android compatível em um terminal dedicado ao Portaria Prime, com acesso controlado para a equipe da portaria.',
  planNote: 'Uso opcional em dispositivo compatível. Exige configuração inicial. Equipamento não incluso.',
  pilot: 'Disponível em acesso piloto, sujeito à validação de compatibilidade.',
  requirement: 'O modo quiosque exige dispositivo Android compatível, dedicado à portaria, e configuração inicial. Equipamento não incluso.',
  included: 'Incluído em todos os planos, de uso opcional e sem cobrança de ativação.',
  pwa: 'O app instalado pelo navegador (PWA) dá acesso ao sistema no celular, tablet ou computador, mas não bloqueia o aparelho. O bloqueio do equipamento é feito pelo app Android gerenciado do Modo Portaria Exclusiva.',
  cta: 'Solicitar ativação piloto',
  href: '/#ativacao-piloto',
} as const;

/** Versões do Android aceitas no formulário (o agente exige Android 8.0 ou superior). */
export const ANDROID_VERSIONS = ['8', '9', '10', '11', '12', '13', '14', '15', '16'] as const;
