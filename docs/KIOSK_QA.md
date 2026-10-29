# QA — Dispositivos gerenciados e Portaria Prime Kiosk

Atualizado em 29/10/2026. Base: commits `8a5f78c` e `a9b0f4c` (em `main`, deploy `dpl_5jSbsssXiF1yo5Tqr4txDbzk92xj` READY) e as correções desta rodada, descritas abaixo.

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
- Backend: stack Supabase local + Vite/API locais, ligados ao emulador por `adb reverse`. Build de laboratório `-PppLab=true`.
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
- desativação: se o modelo volta ao uso comum ou exige restauração;
- notificações reais por e-mail e WhatsApp (destinatários autorizados pendentes).

Roteiro para você executar: `docs/KIOSK_HOMOLOGACAO_FISICA.md`.

## 10. Limitações conhecidas

- O emulador AOSP não é igual a um aparelho de fabricante; os resultados não garantem funcionamento universal.
- Sem FCM: a v1 só faz polling (120 s na política padrão). Um comando pode levar até cerca de 2 min para chegar.
- O alarme exato de fim de manutenção depende da permissão de alarme exato; sem ela, pode atrasar alguns minutos.
- Atualização do APK: manual, dentro da manutenção (instalação silenciosa não implementada).
- Restauração por botões físicos (recovery) não é bloqueável por software.
- PDF local: a fila processa 5 por execução do job, então ele pode levar alguns minutos.
