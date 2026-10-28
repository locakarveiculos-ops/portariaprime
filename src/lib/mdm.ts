/**
 * Dispositivos gerenciados: rótulos, matriz de capacidades, payload de provisionamento (QR do
 * Android) e códigos de recuperação offline. Sem dependência de React (testado em node).
 */

export const KIOSK_PACKAGE = 'br.com.portariaprime.kiosk';
export const KIOSK_ADMIN_COMPONENT = `${KIOSK_PACKAGE}/.admin.KioskAdminReceiver`;

export const STATE_LABEL: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger' | 'accent']> = {
  pendente_provisionamento: ['Pendente de provisionamento', 'neutral'],
  provisionado: ['Provisionado', 'accent'],
  ativo: ['Ativo', 'success'],
  offline: ['Offline (sem contato recente)', 'warning'],
  em_manutencao: ['Em manutenção', 'warning'],
  politica_pendente: ['Política pendente', 'warning'],
  falha: ['Falha', 'danger'],
  desativacao_pendente: ['Desativação pendente', 'warning'],
  desativado: ['Desativado', 'neutral'],
};

export const COMMAND_LABEL: Record<string, string> = {
  sync_policy: 'Sincronizar política', start_maintenance: 'Abrir manutenção', end_maintenance: 'Encerrar manutenção',
  reboot: 'Reiniciar aparelho', wifi_apply: 'Trocar Wi-Fi (duas etapas)', deactivate: 'Desativar gerenciamento',
};
export const COMMAND_STATUS: Record<string, string> = {
  pending: 'Aguardando o aparelho', received: 'Recebido', applying: 'Aplicando', applied: 'Aplicado (confirmado pelo aparelho)',
  failed: 'Falhou', expired: 'Expirou sem confirmação', cancelled: 'Substituído/cancelado',
};

/** Matriz de capacidades: o que a política pode pedir. O agente exige Android 8.0 (API 26)+; o aparelho relata o que falhou. */
export const RESTRICTIONS: { key: string; label: string; minSdk: number; note?: string }[] = [
  { key: 'no_install_apps', label: 'Bloquear instalação de apps', minSdk: 26 },
  { key: 'no_uninstall_apps', label: 'Bloquear desinstalação de apps', minSdk: 26 },
  { key: 'no_unknown_sources', label: 'Bloquear fontes desconhecidas', minSdk: 26 },
  { key: 'no_add_user', label: 'Bloquear usuários adicionais', minSdk: 26 },
  { key: 'no_modify_accounts', label: 'Bloquear contas adicionais', minSdk: 26 },
  { key: 'no_debugging', label: 'Bloquear depuração (ADB)', minSdk: 26, note: 'Desligue em aparelhos de laboratório.' },
  { key: 'no_safe_boot', label: 'Bloquear modo de segurança', minSdk: 26 },
  { key: 'no_screen_capture', label: 'Bloquear captura de tela', minSdk: 26, note: 'Impede prints de suporte.' },
  { key: 'no_factory_reset', label: 'Bloquear restauração pelas Configurações', minSdk: 26, note: 'Não impede recovery por botões físicos.' },
  { key: 'no_config_wifi', label: 'Bloquear alteração de Wi-Fi', minSdk: 26, note: 'Troca supervisionada continua pelo painel.' },
  { key: 'no_usb_file_transfer', label: 'Bloquear transferência de arquivos por USB', minSdk: 26, note: 'Leitores USB (teclado/HID) continuam funcionando.' },
  { key: 'no_config_bluetooth', label: 'Bloquear configuração de Bluetooth', minSdk: 26, note: 'Pareie leitores Bluetooth ANTES de ativar.' },
];

export const LOCK_FEATURES: { key: string; label: string; singleApp: boolean }[] = [
  { key: 'system_info', label: 'Mostrar hora/bateria na barra', singleApp: true },
  { key: 'global_actions', label: 'Menu do botão liga/desliga', singleApp: true },
  { key: 'keyguard', label: 'Tela de bloqueio do sistema', singleApp: true },
  { key: 'home', label: 'Botão Início (Multi-App)', singleApp: false },
  { key: 'overview', label: 'Recentes (exige Início)', singleApp: false },
  { key: 'notifications', label: 'Notificações do sistema (exige Início)', singleApp: false },
];

export const START_PATHS: Record<string, string> = { portaria: 'Portaria (recebimento e entrega)', 'totem-equipe': 'Totem da equipe', painel: 'Painel do síndico' };

/**
 * QR de provisionamento (setup inicial, toque 6 vezes na tela de boas-vindas no Android 7+, nativo no 9+).
 * Somente chaves documentadas em DevicePolicyManager. O token é de uso único e curto; não há senha
 * permanente, sessão do síndico nem service role. Wi-Fi é opcional e fica só no QR exibido.
 */
export function provisioningPayload(o: { apkUrl: string; signatureChecksum: string; token: string; apiBase: string; wifi?: { ssid: string; password?: string; security: 'NONE' | 'WPA' } | null }) {
  if (!/^https:\/\//.test(o.apkUrl)) throw new Error('O APK precisa ser servido por HTTPS.');
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(o.signatureChecksum)) throw new Error('Checksum da assinatura inválido.');
  const p: Record<string, unknown> = {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': KIOSK_ADMIN_COMPONENT,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': o.apkUrl,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': o.signatureChecksum,
    // Mantém teclado, WebView e apps de sistema do fabricante; o Lock Task é quem restringe.
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { pp_enroll_token: o.token, pp_api_base: o.apiBase },
  };
  if (o.wifi?.ssid) {
    p['android.app.extra.PROVISIONING_WIFI_SSID'] = o.wifi.ssid;
    p['android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE'] = o.wifi.security;
    if (o.wifi.security !== 'NONE') p['android.app.extra.PROVISIONING_WIFI_PASSWORD'] = o.wifi.password || '';
  }
  return JSON.stringify(p);
}

// Crockford base32 sem caracteres ambíguos (0/O, 1/I/L, U).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '');
export const RECOVERY_ITERATIONS = 120_000;
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function pbkdf2Hex(code: string, saltHex: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeCode(code)), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** Gera códigos de uso único (12 caracteres, ~59 bits). O texto só existe na tela do síndico. */
export async function generateRecoveryCodes(n = 10, iterations = RECOVERY_ITERATIONS) {
  const codes: string[] = [];
  const stored: { salt: string; hash: string; iterations: number }[] = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.getRandomValues(new Uint8Array(12));
    const c = [...raw].map((b) => ALPHABET[b % ALPHABET.length]).join('');  // viés de módulo desprezível p/ 30 símbolos
    codes.push(`${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    stored.push({ salt, hash: await pbkdf2Hex(c, salt, iterations), iterations });
  }
  return { codes, stored };
}
