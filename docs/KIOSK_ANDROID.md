# Portaria Prime Kiosk — build, assinatura, publicação e instalação

Decisão de arquitetura: `ADR_KIOSK_ANDROID.md`. Resultados de QA e pendências: `KIOSK_QA.md`.

## Peças

| Onde | O quê |
|---|---|
| `android/` | App Kotlin (DPC + launcher + WebView). Sem AndroidX e sem dependências de runtime. APK release com cerca de 57 KB. |
| `supabase/migrations/20261028000100…0500`, `20261029000100` | Tabelas `mdm_*`, validação de política, RPCs do painel, do agente, do Admin Master, auditoria de turno e correção de manutenção expirada. |
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
   Preferido: deixe o `keystore.properties` junto da chave, fora do projeto, e aponte `PP_KIOSK_PROPERTIES=/caminho/keystore.properties` no build.
   Em CI, use as variáveis de ambiente `PP_KIOSK_STORE_FILE`, `PP_KIOSK_STORE_PASSWORD`, `PP_KIOSK_KEY_ALIAS` e `PP_KIOSK_KEY_PASSWORD`, com o conteúdo vindo de segredo do CI.
3. Gere o APK e o checksum:
   ```bash
   ./gradlew assembleRelease
   ANDROID_HOME=… bash scripts/signature-checksum.sh app/build/outputs/apk/release/app-release.apk
   ```
   A última linha impressa é o valor de `PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM` (SHA-256 do certificado em base64url).
4. Hospede o APK em **HTTPS** com URL estável e versionada: copie para `public/kiosk/portaria-prime-kiosk-<versão>.apk` e faça deploy; sai em `https://portariaprime.vercel.app/kiosk/…` (fora do rewrite da SPA e do precache do PWA). Nunca sobrescreva um arquivo já publicado: versão nova, nome novo.
5. Admin Master → Dispositivos → **Publicar versão** (exige papel owner e MFA).

### Builds: teste × laboratório × produção

| Build | Comando | Assinatura | Aponta para | Uso |
|---|---|---|---|---|
| **Teste (debug)** | `./gradlew assembleDebug` | chave de *debug* do Android SDK (`~/.android/debug.keystore`, gerada automaticamente) | produção (`portariaprime.vercel.app` + Supabase de produção) | só compilação e testes JVM; mesmas regras do release (ADB pode ser desligado pela política) |
| **Laboratório (lab)** | `./gradlew assembleLab` | debug | produção | aparelho **dedicado de teste**: `android:testOnly=true`, nome "PP Kiosk LAB (teste)", faixa vermelha "LABORATÓRIO" na tela, ADB nunca desligado, Device Owner removível por cabo (`dpm remove-active-admin`) |
| **Laboratório local** | `./gradlew -PppLab=true assembleLab` | debug | stack local por `adb reverse` (`http://127.0.0.1`) | emulador; além do acima, cleartext só para 127.0.0.1 e DevTools da WebView ligado |
| **Produção (release)** | `./gradlew assembleRelease` com `keystore.properties` | chave **definitiva** do projeto (você guarda) | produção | o único que vai para o QR de provisionamento |

O `testOnly` e o cleartext ficam em `app/src/lab/` e **não entram** no debug nem no release (conferido no manifesto final de cada APK com `aapt dump xmltree`). O Android só instala APK `testOnly` com `adb install -t`; por isso a variante lab não instala por link nem por QR, nem serve para cliente.

A chave de debug muda de máquina para máquina. Um aparelho com o APK de teste só aceita atualização assinada com a **mesma** chave de debug; para trocar para o APK de produção é preciso desinstalar, o que remove o Device Owner e exige restauração. Por isso o APK de teste é só de laboratório.

### Como manter a mesma assinatura em todas as atualizações

1. A chave release é criada **uma vez** (passo 1 acima) e nunca é recriada.
2. Guarde o `.jks` e as senhas em pelo menos dois lugares seguros, por exemplo cofre de senhas e mídia offline. Perder a chave impede atualizar os aparelhos já instalados: a única saída seria restaurá-los de fábrica.
3. Nunca coloque a chave nem as senhas no Git, em issues ou em chat. `android/.gitignore` já ignora `*.jks`, `*.keystore` e `keystore.properties`.
4. Cada versão nova: aumente `versionCode`, rode `assembleRelease` com o mesmo `keystore.properties` e confira que o checksum da assinatura (`scripts/signature-checksum.sh`) é **idêntico** ao da versão publicada antes. Se mudou, **não publique**.
5. Em CI: chave e senhas só como segredos do CI, nas variáveis `PP_KIOSK_*`. O arquivo `.jks` é materializado no build e apagado ao final.

**Situação nesta entrega:**
- Existe uma chave de **laboratório** em `J:\android-toolchain\lab\` (fora do repositório). Ela **não serve para produção**.
- 29/10/2026: chave definitiva criada fora do repositório (guarda do responsável, com backup). APK release 1.0.0 (versionCode 1) hospedado em `https://portariaprime.vercel.app/kiosk/portaria-prime-kiosk-1.0.0.apk`, SHA-256 do arquivo `1e721c3fdcdaa601d7f5c05f730f711ea9fb7e535ef0947cbc759f68ce45eff0`, checksum de assinatura `zcCCzPlA3Q01sNr6QM-RpxYfoRUWQpfZQ0aDh8BYBh0`. Toda versão futura deve ter esse mesmo checksum.
- 29/10/2026 (2ª rodada): release 1.0.1 (versionCode 2) em `https://portariaprime.vercel.app/kiosk/portaria-prime-kiosk-1.0.1.apk`, SHA-256 `41fe00b919b09963a524d50f33b80d254c5f013723aa979482b32839ae023c71`, **mesmo** certificado (`cdc082cc…058061d`, checksum `zcCCzPlA…`). Corrige a desativação (confirma só depois de o Android liberar). O arquivo 1.0.0 continua publicado.
- "Publicar versão" no Admin Master fica com o responsável (owner + MFA). Sem versão publicada, o painel mostra o aviso e não exibe o QR.
- Homologação física ainda não feita (`docs/KIOSK_HOMOLOGACAO_FISICA.md`).

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
adb install -t app-lab.apk
adb shell dpm set-device-owner br.com.portariaprime.kiosk/.admin.KioskAdminReceiver
# abra o app e digite o código de inscrição gerado no painel
```

Para remover em laboratório:
- pelo painel: "Desativar gerenciamento" (aparelho online); ou
- por cabo, sem internet e sem painel (só a variante lab, que é `testOnly`):
  ```bash
  adb shell dpm remove-active-admin br.com.portariaprime.kiosk/.admin.KioskAdminReceiver
  adb uninstall br.com.portariaprime.kiosk
  ```
  Depois, no painel: Desativar gerenciamento → "Registrar liberação local".

No APK de produção esse comando é **recusado** pelo Android (admin não-testOnly). Roteiro completo: `docs/KIOSK_LAB_APARELHO_DEDICADO.md`.

## Operação

- **Sincronização:** a cada `sync_interval_seconds` da política (padrão 120 s; mínimo 60 s; máximo 3600 s). Em falha, backoff exponencial de 30 s até 30 min. O job do Android respeita Doze e a bateria.
- **Offline:** a última política válida continua aplicada. O app mostra o aviso e a portaria **não** confirma entrega sem servidor.
- **Retenção:** `mdm_retention()` roda no job diário (`/api/jobs/tick`):
  - eventos com mais de 180 dias são apagados;
  - tokens vencidos há mais de 30 dias são apagados;
  - senhas de Wi-Fi não entregues são removidas após a expiração do comando.
- **Logs:** não guardam tokens, senha de Wi-Fi nem dados de moradores. O inventário de apps se limita aos pacotes do catálogo.
- **Manutenção × desprovisionamento (separados de propósito):**
  - *Manutenção temporária* (painel ou código offline): libera Configurações, Wi-Fi, instalação de apps e o restante do uso normal, e volta sozinha ao quiosque. **Continuam bloqueados** restauração de fábrica, novos usuários/contas e modo de segurança. Testado no emulador: o item "Erase all data" aparece desabilitado com "Blocked by work policy".
  - *Desprovisionamento definitivo*: só pelo painel do síndico, em "Desativar gerenciamento" (com senha recente), e fica pendente até o aparelho confirmar. O app remove as restrições, libera o Device Owner, **confere no Android** que saiu e só então confirma; se o Android recusar, o comando vai como "falhou" e o quiosque é reaplicado. Sem conexão, nada é liberado: o pedido espera até 30 dias. Se a confirmação se perder na rede depois da liberação, o próximo envio a repete. Não aparece como botão no tablet.
- **Plano vencido ou cancelado:**
  - o aparelho continua sincronizando e recebendo comandos (só novas inscrições são bloqueadas);
  - o síndico pode desativar o gerenciamento pelo painel;
  - sem internet, o aparelho mantém a última política.

  O hardware não fica refém do plano.
- **Credencial revogada:** o aparelho mantém o quiosque com a última política e mostra a tela de reinscrição; um código novo do síndico o recoloca em operação. Código errado não apaga a identidade atual (chave nova só substitui a antiga depois do aceite do servidor).
