# QA — Dispositivos gerenciados e Portaria Prime Kiosk

Atualizado em 29/10/2026 (2ª rodada: saídas, desativação e variante de laboratório, seção 11). Base: commits `8a5f78c`, `a9b0f4c`, `81946a8`, `d482793` e as correções descritas abaixo.

> **Situação: validado em emulador Android 14 gerenciado (Device Owner + Lock Task reais). NÃO homologado em aparelho físico.**
> Não é um MDM completo. É um agente próprio de quiosque Single-App/Multi-App com as políticas descritas no ADR.
> Este documento é um registro: a prova de execução está nos roteiros executáveis citados em cada item e nas saídas reproduzidas aqui.

## 1. Arquivos implementados

| Camada | Arquivos |
|---|---|
| Banco | `supabase/migrations/20261028000100_mdm_schema.sql` (350 linhas), `…0200_mdm_panel.sql` (319), `…0300_mdm_agent.sql` (219), `…0400_mdm_platform.sql` (65), `…0500_mdm_shift.sql` (55), `20261029000100_mdm_expired_maintenance.sql` (46) |
| API | `api/totem/_kiosk.ts` (123), roteado por `api/totem/[action].ts` |
| Painel | `src/pages/tenant/config/DevicesCard.tsx` (427), `src/pages/admin/DevicesPanel.tsx` (56), `src/lib/mdm.ts` (105), `src/lib/kiosk-shift.ts` (26) |
| Android | `android/app/src/main/java/br/com/portariaprime/kiosk/`: `Agent.kt`, `Api.kt`, `DeviceIdentity.kt`, `KioskActivity.kt`, `Receivers.kt`, `Store.kt`, `admin/{KioskAdminReceiver,PolicyEnforcer,ProvisioningActivity}.kt`, `core/{Backoff,MaintenanceClock,NavigationGuard,Policy,RecoveryCodes}.kt` |
| Testes | `tests/db/mdm.test.mjs`, `tests/api/kiosk.test.mjs`, `tests/mdm-frontend.test.mjs`, `android/app/src/test/.../CoreTest.kt`, `tests/e2e/devices.mjs`, `tests/e2e/kiosk-device.sh`, `tests/e2e/kiosk-webview.mjs`, `tests/e2e/kiosk-flow.mjs`, `tests/e2e/kiosk-security.mjs`, `tests/e2e/kiosk-lab-setup.mjs`, `tests/e2e/kiosk-lab-cmd.mjs` |
| Docs | `docs/ADR_KIOSK_ANDROID.md`, `docs/KIOSK_ANDROID.md` (build, assinatura, operação), `docs/KIOSK_HOMOLOGACAO_FISICA.md` (roteiro do aparelho real), este arquivo |

## 2. Produção (somente leitura nesta rodada; nada foi reaplicado)

Consulta feita em 29/10/2026, sem alterações:

- Migrações registradas: `20261028000100`, `…0200`, `…0300`, `…0400`, `…0500`.
- 13 tabelas `mdm_*`, todas com RLS ligado.
- 0 aparelhos e 0 versões de agente publicadas.
- 1 condomínio; assinatura `trialing / monthly / 14900` (sem alteração).
- Preços ativos inalterados: essencial 9900 / 28200 / 100900; profissional 14900 / 42400 / 151900; prime 34900 / 99400 / 355900.
- Deploys: `dpl_Am3snRYGdmSUPHcy3ejKqG7XCezs` (8a5f78c) e `dpl_5jSbsssXiF1yo5Tqr4txDbzk92xj` (a9b0f4c), ambos READY.

**Pendente:** a nova migração `20261029000100` (correção de manutenção expirada) foi aplicada **só na stack local**. Ela vai para produção junto com o próximo deploy, com backup.

## 3. APK

| Item | Valor |
|---|---|
| Arquivo entregue | `J:\android-toolchain\entrega\portaria-prime-kiosk-1.0.0-teste-debug.apk` (fora do repositório) |
| Pacote | `br.com.portariaprime.kiosk` |
| Versão | versionName 1.0.0, versionCode 1 |
| Android | minSdk 26 (8.0), targetSdk 35 |
| Tamanho | 894.267 bytes |
| SHA-256 do arquivo | `97eef38ed41383becdb6502b48de8c0a2ea731cc77dee4613aebaca18bfc1481` |
| Assinatura | **debug** (APK Signature Scheme v2, `CN=Android Debug`, cert SHA-256 `b0e0d94a…905d3c2`) |
| Aponta para | produção: `https://portariaprime.vercel.app` + Supabase `zehijyqgqkouzhldeqio` (`LAB_LOOPBACK=false`) |

**É um build de teste.** Serve para instalar por cabo em aparelho de laboratório (`KIOSK_HOMOLOGACAO_FISICA.md`, anexo). **Não** serve para o QR de provisionamento de cliente: este exige o build **release** assinado com a chave definitiva, que **não foi gerada**. Os motivos e a forma de manter a mesma assinatura estão em `KIOSK_ANDROID.md`.

## 4. Testes executados nesta rodada (resultado real)

| Suíte | Comando | Resultado |
|---|---|---|
| Banco (PGlite), suíte inteira | `npm run test:db` | **88/88** |
| API, suíte inteira | `npm run test:api` | **71/71** |
| Typecheck, lint e build web | `npm run typecheck`, `lint`, `build` | ok |
| Android JVM | `gradlew testDebugUnitTest` | **8/8** |
| Android lint | `gradlew lintDebug` | **0 erros** (15 avisos de estilo) |
| Android gerenciado: Device Owner, Lock Task, saídas, reboots, manutenção, offline | `bash tests/e2e/kiosk-device.sh` | **22 PASS / 0 FALHA** (saída na seção 5) |
| WebView real: pushState, URLs externas, servidor, turno | `node tests/e2e/kiosk-webview.mjs` | **OK** |
| Fluxo operacional na WebView real | `node tests/e2e/kiosk-flow.mjs` | **OK**, protocolo `PP-20261029-BBE5488A` |
| Segurança no aparelho real e servidor | `node tests/e2e/kiosk-security.mjs` | **OK** |

### Ambiente

- Emulador AVD `ppkiosk34`: Pixel Tablet, **Android 14 (API 34)**, patch 2023-09-05, imagem AOSP x86_64 userdebug, aceleração WHPX, sem contas.
- Device Owner aplicado por `dpm set-device-owner` (procedimento de laboratório).
- Backend: stack Supabase local + Vite/API locais, ligados ao emulador por `adb reverse`. Build de laboratório `./gradlew -PppLab=true assembleLab` (variante lab, testOnly).
- OCR: Gemini real, com a chave do `.env` local, que não é versionado.

## 5. Validação em Android gerenciado (saída real de `kiosk-device.sh`)

```
Aparelho: unknown Android SDK built for x86_64 · Android 14 (API 34) · patch 2023-09-05
1. Device Owner            PASS  Device Owner = br.com.portariaprime.kiosk
2. Lock Task               PASS  mLockTaskModeState=LOCKED
3. Rotas de saída          PASS  KEYCODE_HOME mantém o quiosque
                           PASS  KEYCODE_APP_SWITCH mantém o quiosque
                           PASS  Configurações bloqueadas
                           PASS  link externo (intent) bloqueado
                           PASS  outro app bloqueado
                           PASS  barra de notificações sem foco
4. Reboot com internet     PASS  após reboot: LOCKED em br.com.portariaprime.kiosk/.KioskActivity
                                 URL: /c/e2emvsiy6sw-lab/portaria   (condomínio vinculado)
5. Reboot sem internet     PASS  sem internet: LOCKED
6. Manutenção (síndico)    PASS  manutenção aplicada (Lock Task NONE)
                           PASS  na manutenção, restauração de fábrica continua bloqueada
                           PASS  instalação liberada na manutenção
                           PASS  Configurações acessíveis na manutenção
                           PASS  encerrada pelo painel → LOCKED
7. Expiração               PASS  voltou sozinho em 300s (prazo 300s)
8. Reboot em manutenção    PASS  em manutenção
                           PASS  após reboot durante manutenção: LOCKED
9. Recuperação offline     PASS  código válido offline → manutenção
                           PASS  encerrada no aparelho → LOCKED
                           PASS  mesmo código não vale duas vezes
                           PASS  evento offline sincronizado ao reconectar
Resultado: 22 PASS, 0 FALHA
```

Na mesma rodada, verificado à mão, com captura:
- **Manutenção não é saída definitiva.** Em Configurações → Sistema → Opções de redefinição, "Erase all data (factory reset)" aparece desabilitado. Ao tocar, o Android mostra "Blocked by work policy" (`emu-30-reset-bloqueado.png`).
- **Restrições ativas fora da manutenção:** `no_add_user no_factory_reset no_install_apps no_install_unknown_sources no_modify_accounts no_safe_boot no_uninstall_apps no_usb_file_transfer`.
- **Restrições durante a manutenção:** `no_add_user no_factory_reset no_modify_accounts no_safe_boot`. Instalação e USB ficam liberados para o ajuste.
- **Depois da manutenção** as restrições voltam integralmente (listadas pelo `dumpsys user`).

## 6. Segurança, isolamento e auditoria (`kiosk-security.mjs`, `kiosk-webview.mjs` e PGlite)

- **Assinatura das requisições:** sem cabeçalhos → 401; chave de outro aparelho → 401; corpo adulterado → 401. Tentativas inválidas não avançam o contador anti-replay. Contador repetido já é recusado no banco (PGlite).
- **Permissões por função:** porteiro e morador recebem erro em `mdm_overview`, `mdm_device_detail`, `mdm_command_create` (manutenção), `mdm_enrollment_create` e `mdm_recovery_set`, e não leem a auditoria. Síndico de outro condomínio também é recusado (PGlite).
- **Expiração e repetição de comandos:**
  - repetir a chave de idempotência devolve o mesmo comando (`replayed=true`);
  - uma manutenção vencida antes de o aparelho buscar é marcada `expired`, e o aparelho **continua LOCKED**;
  - um `sync_policy` chegou ao aparelho e foi confirmado `applied`.
- **Revogação:**
  - credencial revogada → o aparelho recebe 401, **mantém o Lock Task** com a última política e mostra a tela de reinscrição (`emu-32-revogado-reinscricao.png`);
  - código de inscrição errado é recusado **sem destruir a identidade atual**;
  - código novo do síndico recoloca o aparelho em operação.
- **Isolamento e navegação na WebView real:**
  - pushState para outro condomínio, `/admin`, `/org`, `/contratar` e `/planos` volta sempre para `/c/<condomínio vinculado>/portaria`;
  - `location.href` para outro condomínio, https externo e `intent:`, além de `window.open` e `target=_blank`, são bloqueados;
  - com a sessão do porteiro, `mdm_overview` (do próprio e de outro condomínio), `create_invitation` de admin e `mdm_command_create` são negados; `platform_context` vem sem capacidades; nenhuma encomenda de outro condomínio é visível; `mdm_devices` está fechada.
- **Troca de turno:** saída do porteiro A e entrada da porteira B dentro do quiosque. O servidor registrou `shift.end` (porteiro A) e `shift.start` (porteira B), com `actor_id`, `device_id`, `tenant_id`, papel e horário do servidor (09:16:38 e 09:16:40).

## 7. Fluxo operacional dentro do app Android (`kiosk-flow.mjs`)

Login do porteiro → receber (foto da etiqueta pela câmera da WebView) → **OCR real (Gemini)** → morador e unidade confirmados → guarda física confirmada (Estante A › Prateleira 1) → aviso ao morador → morador gera QR → leitura do QR pela câmera → quem retira + assinatura no canvas (traço verificado) → foto do item → confirmação → comprovante `PP-20261029-BBE5488A` → PDF no visualizador interno → consulta no histórico (aba Buscar).

O OCR leu o destinatário "MARIA MORADORA LAB", o complemento "BLOCO A APTO 101" e o rastreio. Casou a unidade "Bloco A · 101" automaticamente.

**Notificações: pedido × aceito pelo provedor × entregue** (ambiente local):

| Evento | Canal | Situação na fila | Significado |
|---|---|---|---|
| package_received | e-mail | `queued`; o job devolveu `email:disabled` | **pedido** registrado; provedor **não chamado** (Resend não configurado na API local) |
| package_received | push | `queued`; job `push:disabled` | **pedido**; VAPID não configurado localmente |
| package_picked_up | e-mail / push | `queued` | **pedido** |
| WhatsApp | — | job `whatsapp:disabled` | Evolution não configurada na API local |

**Nada foi enviado a provedores nesta rodada.** Você preferiu não autorizar destinatários de teste agora. Assim, "aceito pelo provedor" (`accepted`) e "entrega confirmada" **não foram testados**. Observação: o sistema registra `accepted` quando o provedor aceita; **não existe confirmação de entrega** (webhook de leitura ou recebimento) para e-mail nem WhatsApp, então "entregue" nunca é afirmado.

## 8. Falhas encontradas nesta rodada e corrigidas (testes afetados reexecutados)

1. **A manutenção liberava a restauração de fábrica** e usuários/contas extras. Agora a manutenção mantém `no_factory_reset`, `no_add_user`, `no_modify_accounts` e `no_safe_boot`; a saída definitiva fica só no desprovisionamento pelo painel. Reteste: item 6 e verificação manual do "Erase all data".
2. **Uma manutenção pedida que expirava sem o aparelho aplicar deixava o painel mostrando "em manutenção"** (migração `20261029000100`). Agora a sessão é encerrada ao expirar, e o estado exige confirmação do aparelho. Reteste: PGlite (novo teste) e `kiosk-security.mjs`.
3. **Um código de inscrição errado destruía a identidade do aparelho**, que perdia a chave e o vínculo. Agora a chave nova nasce em alias reserva (A/B do Keystore) e só substitui a antiga após o aceite do servidor. Reteste: `kiosk-security.mjs`.
4. **Um aparelho revogado ficava em quiosque sem caminho de volta.** Agora mostra a tela de reinscrição dentro do quiosque. Reteste: `kiosk-security.mjs`.
5. **Câmera do sistema web (afeta também o PWA):** em aparelho lento, o vídeo não recebia a imagem (`requestAnimationFrame` antes da montagem) e "Capturar" falhava em silêncio. Corrigido em `src/components/CameraCapture.tsx`. Reteste: `kiosk-flow.mjs`, typecheck, lint e build.

## 9. Sem validação em aparelho físico (pendente)

Nada abaixo pode ser concluído com emulador:

- QR de provisionamento na tela de boas-vindas (o emulador usou `dpm`), que exige o APK release e a versão publicada;
- câmera física: foco, luz e leitura de etiqueta real e de QR na tela de outro celular (o emulador não tem câmera; a imagem foi injetada no vídeo da WebView);
- teclado do fabricante, botões físicos, menu liga/desliga, bloqueio de tela com senha após reboot;
- Wi-Fi em duas etapas com rollback (não testado em emulador);
- leitores USB/Bluetooth, consumo de bateria, aquecimento em 8 h de tomada;
- comportamento de fabricante (Samsung, Motorola, Xiaomi, Positivo etc.) e Android Go;
- desativação: se o modelo volta ao uso comum ou exige restauração (no emulador AOSP voltou sem restauração, seção 11);
- variante lab num aparelho real: `dpm set-device-owner` aceito pelo fabricante e ADB após reboot;
- notificações reais por e-mail e WhatsApp (destinatários autorizados pendentes).

Roteiro para você executar: `docs/KIOSK_HOMOLOGACAO_FISICA.md`.

## 10. Limitações conhecidas

- O emulador AOSP não é igual a um aparelho de fabricante; os resultados não garantem funcionamento universal.
- Sem FCM: a v1 só faz polling (120 s na política padrão). Um comando pode levar até cerca de 2 min para chegar.
- O alarme exato de fim de manutenção depende da permissão de alarme exato; sem ela, pode atrasar alguns minutos.
- Atualização do APK: manual, dentro da manutenção (instalação silenciosa não implementada).
- Restauração por botões físicos (recovery) não é bloqueável por software.
- PDF local: a fila processa 5 por execução do job, então ele pode levar alguns minutos.

## 11. Segunda rodada (29/10/2026): manutenção, desativação e variante de laboratório

Nenhum aparelho físico foi instalado ou provisionado nesta rodada. Tudo abaixo é **emulador** (Android 14, AOSP, sem contas) ou **teste automatizado**.

### 11.1 O que mudou no código

| Item | Mudança |
|---|---|
| Desativação pelo painel (`Agent.kt`, `PolicyEnforcer.releaseOwnership`) | Antes o app confirmava "aplicado" **antes** de liberar o Android, sem conferir. Agora: libera, **confere** `isDeviceOwnerApp == false`, remove o admin ativo (app fica desinstalável) e só então confirma. Se o Android recusar: confirma "falhou" e reaplica o quiosque. Se a confirmação se perder na rede, o próximo envio a repete; a credencial só para de sincronizar depois do aceite do servidor. |
| Tela pós-desativação (`KioskActivity`) | "Gerenciamento retirado", com o caminho para desinstalar. Sem botão de saída no quiosque ativo. |
| Variante `lab` (`build.gradle.kts`, `app/src/lab/`) | Nova variante separada: `android:testOnly=true`, nome "PP Kiosk LAB (teste)", faixa vermelha permanente "LABORATÓRIO · versão de teste · não usar em cliente", ADB nunca desligado pela política, cleartext só para 127.0.0.1 e só com `-PppLab=true`. Debug e release não herdam nada disso. |
| Versão | 1.0.1 (versionCode 2). |

Manutenção temporária e saída local autenticada **já existiam** e foram reverificadas (seção 5): painel (com reautenticação do síndico) ou código de recuperação de uso único (PBKDF2, gerado no navegador do síndico, sem senha padrão ou global, nada no frontend do quiosque), 5 erros → bloqueio de 15 min (dobra até 4 h), contado desde o boot, eventos `recovery.failed`/`recovery.locked`/`maintenance.offline_start` na auditoria. Na manutenção continuam bloqueados: restauração de fábrica, novos usuários, contas e modo de segurança. Desativação definitiva é outro fluxo: só pelo painel, com senha recente.

### 11.2 Manifesto final dos APKs (`aapt dump xmltree` e `apksigner`)

| APK | versão | `testOnly` | `debuggable` | Assinatura | Nome |
|---|---|---|---|---|---|
| `portaria-prime-kiosk-1.0.1.apk` (release) | 1.0.1 / 2 | **ausente** | ausente | chave definitiva, cert SHA-256 `cdc082cc…058061d` (igual à 1.0.0) | Portaria Prime Kiosk |
| `app-debug.apk` | 1.0.1 / 2 | **ausente** | sim | debug | Portaria Prime Kiosk |
| `portaria-prime-kiosk-1.0.1-lab.apk` | 1.0.1-lab / 2 | **presente** | sim | debug (`CN=Android Debug`) | PP Kiosk LAB (teste) |

- Release 1.0.1: 62.353 bytes, SHA-256 `41fe00b919b09963a524d50f33b80d254c5f013723aa979482b32839ae023c71`, em `public/kiosk/`.
- Lab 1.0.1: 895.763 bytes, SHA-256 `c34f51f1d7fe5c625fd2e4678bc1eb70862af8c46359fec58fe464b43f529d41`, em `J:\android-toolchain\entrega\` (fora do repositório e do site; **não entregar a clientes**).

### 11.3 Matriz de testes

Legenda: **Auto** = teste automatizado (JVM/PGlite/API); **Emu** = emulador gerenciado real (Device Owner + Lock Task do Android); **Físico** = aparelho real.

| Cenário | Auto | Emu | Físico | Evidência |
|---|---|---|---|---|
| Bloqueio Single-App (Início, Recentes, Configurações, intent externo, outro app, barra) | — | PASS | pendente | `kiosk-device.sh` 3 |
| Reboot em quiosque (com e sem internet) → volta ao condomínio vinculado | — | PASS | pendente | `kiosk-device.sh` 4–5 (URL `/c/<slug>/portaria`) |
| Manutenção com internet (painel): abre Configurações, mantém reset bloqueado, encerra pelo painel | PGlite | PASS | pendente | `kiosk-device.sh` 6 |
| Manutenção sem internet (código de recuperação), uso único, encerramento manual | JVM | PASS | pendente | `kiosk-device.sh` 9 |
| Expiração da manutenção | JVM | PASS (301 s para prazo de 300 s) | pendente | `kiosk-device.sh` 7 |
| Reboot durante manutenção → volta ao quiosque | JVM | PASS | pendente | `kiosk-device.sh` 8 |
| Código incorreto: 5 erros, bloqueio, código certo recusado durante o bloqueio, reboot não fura, eventos no painel | JVM | PASS | pendente | `kiosk-exit.sh` A |
| Com códigos bloqueados, manutenção pelo painel continua disponível | — | PASS | pendente | `kiosk-exit.sh` A |
| Admin não-testOnly recusa `dpm remove-active-admin` | — | PASS (`SecurityException`, 1ª execução, app 1.0.0 sem testOnly) | pendente | `kiosk-exit.sh` B |
| Desativação sem conexão: continua gerenciado e em quiosque; painel "desativação pendente" | PGlite | PASS | pendente | `kiosk-exit.sh` C |
| Desativação com conexão: painel "desativado"; Android sem Device Owner, sem restrições, sem Lock Task, Configurações abrem, tela "Gerenciamento retirado", agente para | PGlite | PASS | pendente | `kiosk-exit.sh` C, `emu-51-gerenciamento-retirado.png` |
| App desinstalável após desativação, sem restauração | — | PASS | pendente | `kiosk-exit.sh` C |
| Lab: Device Owner por cabo + inscrição + quiosque; admin `testOnly` | — | PASS | pendente | `kiosk-exit.sh` D |
| Lab: ADB ativo com quiosque e após reboot; volta ao quiosque após reboot | — | PASS | pendente | `kiosk-exit.sh` D |
| Lab: `dpm remove-active-admin` remove Device Owner, restrições e Lock Task; app desinstala | — | PASS | pendente | `kiosk-exit.sh` D |
| Painel: "liberação local verificada" com o aparelho fora do ar | PGlite | PASS | — | `kiosk-exit.sh` D |
| Dados preservados em cada fluxo não destrutivo (arquivo-sentinela em `/data/local/tmp`) | — | PASS (A, C, D) | pendente | `kiosk-exit.sh` |
| Regressão completa com a variante lab | — | 22/22 | — | `kiosk-device.sh` |

Saídas reais desta rodada:

```
bash tests/e2e/kiosk-device.sh   → Resultado: 22 PASS, 0 FALHA   (app 1.0.0-lab)
bash tests/e2e/kiosk-exit.sh     → Resultado: 30 PASS, 0 FALHA   (2ª execução; B pulado porque o admin já era testOnly)
                                   1ª execução: 28 PASS, 3 FALHA — as 3 falhas eram do próprio teste: a sentinela
                                   não era criada em /sdcard (fechado ao shell pela restrição no_usb_file_transfer);
                                   B passou nessa execução com o app 1.0.0 não-testOnly.
gradlew testDebugUnitTest lintDebug lintLab lintRelease assembleDebug assembleLab assembleRelease → ok, 0 erros
```

Restrições efetivas após a desativação e após a remoção por cabo (`dumpsys user`): **nenhuma**.

### 11.4 Achados

1. **Desativação confirmava antes de executar** (corrigido): o "aplicado" ia ao servidor antes de o Android liberar; uma recusa do Android deixaria o painel "desativado" com o aparelho ainda travado. Reteste: `kiosk-exit.sh` C.
2. **Achado de teste, não de produto:** com `no_usb_file_transfer`, o shell ADB não escreve em `/sdcard`. Esperado; o roteiro passou a usar `/data/local/tmp`.
3. **Inscrição no emulador:** um código digitado com caracteres perdidos pelo teclado virtual foi recusado ("Código de inscrição inválido"); o roteiro agora confere o texto do campo antes de enviar. O aparelho segue protegido nesse caso (identidade A/B preservada).

### 11.5 Limitações e pendências

- Emulador AOSP sem contas, sem Pasta Segura/Segundo espaço e sem camada de fabricante. Em aparelho real, `dpm set-device-owner` exige nenhum usuário/perfil extra e nenhuma conta; alguns fabricantes recusam. Ver `KIOSK_LAB_APARELHO_DEDICADO.md`, passo 1 (identificar antes de mudar).
- A release 1.0.1 **não** foi instalada no emulador: o emulador usa a variante lab (assinatura debug), e as duas não se atualizam uma sobre a outra. O código Android é o mesmo nas duas; difere só o `testOnly`, o nome, a faixa e o ADB.
- Atualizar um aparelho já provisionado com a 1.0.0 para a 1.0.1 (mesma chave) não foi testado em aparelho físico.
- **Homologação física: não executada.**

## 12. Terceira rodada (29/10/2026): versão 1.0.2 e domínio oficial

Somente **emulador** (Android 14) e testes automatizados. Nenhum aparelho físico.

### 12.1 Achado e correção no app
- **Código válido recusado ("Código inválido").** O teclado do Android aplicava sugestões/autocorreção no campo de código e alterava o texto antes da validação; um código certo virava tentativa errada e, repetido, levava ao bloqueio de 15 min. Correção: campos de código de inscrição e de recuperação sem sugestões (`TYPE_TEXT_FLAG_NO_SUGGESTIONS` + `VISIBLE_PASSWORD`).
- Investigação: os hashes PBKDF2 gravados no aparelho conferem 5/5 com os códigos gerados no painel (verificado fora do app); o defeito era só a entrada de texto.
- Roteiros de emulador: passam a conferir o texto do campo antes de enviar (`typeChecked`), a limpar o campo com um único evento e a gravar dumps de UI em `/data/local/tmp` (`/sdcard` fica fechado ao shell com `no_usb_file_transfer`).

### 12.2 Domínio
- Origem padrão do APK: `https://portariaprime.com.br`. `https://portariaprime.vercel.app` continua aceita pela WebView durante a transição (`LEGACY_APP_ORIGIN`), com as mesmas regras de rota e condomínio. Teste JVM `dominioAnteriorAceitoNaTransicaoSemAbrirOutrasOrigens`.
- APK 1.0.1 já instalado (origem antiga) continua funcionando: o endereço antigo não foi redirecionado.

### 12.3 Resultado
```
bash tests/e2e/kiosk-device.sh  → 22 PASS, 0 FALHA   (app 1.0.2-lab; expiração em 298 s para prazo de 300 s)
bash tests/e2e/kiosk-exit.sh    → 30 PASS, 0 FALHA   (B pulado: admin já testOnly; recusa do não-testOnly registrada na seção 11)
gradlew testDebugUnitTest lintLab lintRelease assembleLab assembleRelease → ok
```

| Item | Valor |
|---|---|
| Release 1.0.2 (versionCode 3) | `public/kiosk/portaria-prime-kiosk-1.0.2.apk`, 62.525 bytes, SHA-256 `773d30eca9f55b43b6de4203c2bb130b4aa98f755c8945621218865964d10aa1`, sem `testOnly` |
| Assinatura | mesmo certificado (`cdc082cc…058061d`), checksum `zcCCzPlA3Q01sNr6QM-RpxYfoRUWQpfZQ0aDh8BYBh0` |
| Lab 1.0.2 | `J:\android-toolchain\entrega\portaria-prime-kiosk-1.0.2-lab.apk` (fora do site), SHA-256 `88158114ff44b2242b1ca14dad5fda9addefc7ffed93bd2126eaf33adf1c7709` |

Homologação física: **não executada**.
