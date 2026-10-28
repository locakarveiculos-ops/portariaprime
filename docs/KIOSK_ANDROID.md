# Portaria Prime Kiosk — build, assinatura, publicação e instalação

Decisão de arquitetura: `ADR_KIOSK_ANDROID.md`. Resultados de QA e pendências: `KIOSK_QA.md`.

## Peças

| Onde | O quê |
|---|---|
| `android/` | App Kotlin (DPC + launcher + WebView). Sem AndroidX e sem dependências de runtime. APK release com cerca de 57 KB. |
| `supabase/migrations/20261028000100…0400` | Tabelas `mdm_*`, validação de política, RPCs do painel, do agente e do Admin Master. |
| `api/totem/_kiosk.ts` | `/api/totem/kiosk-enroll`, `kiosk-sync`, `kiosk-ack` e `kiosk-event`, dentro da função existente do totem (não usa slot Vercel novo). |
| `src/pages/tenant/config/DevicesCard.tsx` | Configurações → **Dispositivos e quiosque**. |
| `src/pages/admin/DevicesPanel.tsx` | Admin Master → **Dispositivos** (leitura e publicação da versão do agente). |

## Build (reproduzível)

Requisitos:
- JDK 17.
- Android SDK com `platforms;android-35` e `build-tools;35.0.0`.
- Gradle via wrapper (`android/gradlew`, versão 8.11.1).

```bash
cd android
echo "sdk.dir=/caminho/para/Android/Sdk" > local.properties    # não versionado
./gradlew testDebugUnitTest lintDebug assembleDebug              # = npm run test:android
```

O APK de teste sai em `android/app/build/outputs/apk/debug/app-debug.apk`.

Origens fixas no APK, em `app/build.gradle.kts`: `APP_ORIGIN` e `SUPABASE_ORIGIN`. Para trocá-las, passe `-PppAppOrigin=https://… -PppSupabaseOrigin=https://…`. O painel do síndico **não** consegue apontar o quiosque para outro site.

## Assinatura release (chave definitiva)

1. Gere a chave **uma vez**, em máquina confiável. Guarde o arquivo e a senha em cofre, com backup. **Perder a chave impede atualizar os aparelhos já provisionados** (o Device Owner só aceita atualização com a mesma assinatura).
   ```bash
   keytool -genkeypair -keystore pp-kiosk-release.jks -alias pp-kiosk -keyalg EC -groupname secp256r1 -validity 10000
   ```
2. Crie `android/keystore.properties` (ignorado pelo Git):
   ```
   STORE_FILE=/caminho/seguro/pp-kiosk-release.jks
   STORE_PASSWORD=…
   KEY_ALIAS=pp-kiosk
   KEY_PASSWORD=…
   ```
   Em CI, use as variáveis de ambiente `PP_KIOSK_STORE_FILE`, `PP_KIOSK_STORE_PASSWORD`, `PP_KIOSK_KEY_ALIAS` e `PP_KIOSK_KEY_PASSWORD`, com o conteúdo vindo de segredo do CI.
3. Gere o APK e o checksum:
   ```bash
   ./gradlew assembleRelease
   ANDROID_HOME=… bash scripts/signature-checksum.sh app/build/outputs/apk/release/app-release.apk
   ```
   A última linha impressa é o valor de `PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM` (SHA-256 do certificado em base64url).
4. Hospede o APK em **HTTPS** com URL estável e versionada (ex.: `…/kiosk/pp-kiosk-1.0.0.apk`).
5. Admin Master → Dispositivos → **Publicar versão** (exige papel owner e MFA).

**Situação nesta entrega:**
- Foi gerado um APK release assinado com uma **chave de laboratório**. Ela fica em `J:\android-toolchain\lab\`, fora do repositório, e **não serve para produção**.
- A chave definitiva, a hospedagem do APK e a publicação da versão **não foram feitas**: dependem de decisão do responsável e de segredo de produção.
- Sem versão publicada, o painel mostra o aviso e não exibe o QR.

## Atualização do agente

- Aumente `versionCode` e assine com a **mesma** chave.
- Teste em um aparelho piloto (instalação por `adb install -r` em laboratório) e depois publique a versão.
- Rollout em produção: na v1, a atualização dos aparelhos já provisionados é **manual**:
  - em manutenção, instalar o APK novo; ou
  - pelo instalador do sistema com a política `no_install_apps` suspensa durante a manutenção.
- Instalação silenciosa pelo agente (`PackageInstaller`) **não foi implementada** na v1. Fica como próximo passo.
- Downgrade não é suportado pelo Android sem desinstalar, e desinstalar o DPC remove o gerenciamento.

## Provisionamento (cliente)

1. O aparelho deve ser **do condomínio** e estar restaurado de fábrica. O processo apaga tudo: confira backup, contas e senhas antes.
2. No painel, siga Configurações → Dispositivos e quiosque → **Adicionar dispositivo** → **Gerar QR de provisionamento** (pede a senha de novo se o login for antigo).
3. Na tela de boas-vindas do Android, toque 6 vezes e leia o QR.
4. O Android baixa o app, confere a assinatura e conclui. O app abre a portaria do condomínio. O token do QR é de uso único.

Aparelho já gerenciado por outro MDM: **não** prossiga. Peça a liberação a quem gerencia; o app não tenta remover gerenciamento de terceiros.

## ADB — **somente laboratório**

Use apenas em aparelho de teste, sem contas Google e sem outros usuários. Nunca use em aparelho de cliente nem como onboarding padrão.

```bash
adb install app-debug.apk
adb shell dpm set-device-owner br.com.portariaprime.kiosk/.admin.KioskAdminReceiver
# abra o app e digite o código de inscrição gerado no painel
```

Para remover em laboratório, use "Desativar gerenciamento" no painel. A alternativa é restaurar de fábrica.

## Operação

- **Sincronização:** a cada `sync_interval_seconds` da política (padrão 120 s; mínimo 60 s; máximo 3600 s). Em falha, backoff exponencial de 30 s até 30 min. O job do Android respeita Doze e a bateria.
- **Offline:** a última política válida continua aplicada. O app mostra o aviso e a portaria **não** confirma entrega sem servidor.
- **Retenção:** `mdm_retention()` roda no job diário (`/api/jobs/tick`):
  - eventos com mais de 180 dias são apagados;
  - tokens vencidos há mais de 30 dias são apagados;
  - senhas de Wi-Fi não entregues são removidas após a expiração do comando.
- **Logs:** não guardam tokens, senha de Wi-Fi nem dados de moradores. O inventário de apps se limita aos pacotes do catálogo.
- **Cancelamento do SaaS:**
  - a credencial do aparelho deixa de receber política e comandos;
  - a última política permanece;
  - o síndico usa um código de recuperação offline para entrar em manutenção, que suspende todas as restrições, inclusive o bloqueio de restauração;
  - nessa janela, restaura o aparelho pelas Configurações do Android ou pelo procedimento do fabricante.

  O hardware nunca fica refém.
