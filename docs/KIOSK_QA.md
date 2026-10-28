# QA — Dispositivos gerenciados e Portaria Prime Kiosk

Atualizado em 28/10/2026, às 18h30.

**Situação: testado em emulador gerenciado. NÃO homologado em aparelho físico.** Esta não é uma solução de MDM completa: é um agente próprio de quiosque Single-App/Multi-App, com as políticas listadas no ADR.

## Inventário real

| Camada | Arquivos | Implementado | Compilado | Testado | Homologado (físico) |
|---|---|---|---|---|---|
| Banco | `supabase/migrations/20261028000100…0500` (tabelas `mdm_*`, RPCs do painel, do agente, Admin Master e troca de turno) | ✔ | — | ✔ PGlite 12/12; stack local; produção | — |
| API | `api/totem/_kiosk.ts` (`kiosk-enroll`, `kiosk-sync`, `kiosk-ack`, `kiosk-event`) | ✔ | ✔ | ✔ 3/3 (assinatura ECDSA, replay, adulteração); smoke em produção | — |
| Painel | `src/pages/tenant/config/DevicesCard.tsx`, `src/pages/admin/DevicesPanel.tsx`, `src/lib/mdm.ts`, `src/lib/kiosk-shift.ts` | ✔ | ✔ | ✔ e2e no Edge (`tests/e2e/devices.mjs`) | — |
| Android | `android/` (DPC, launcher, Lock Task, WebView, agente) | ✔ | ✔ debug 872 KB / release 56 KB (sem assinatura definitiva) | ✔ JVM 8/8; lint 0 erros; **emulador Android 14 como Device Owner** | **Pendente** |

**APK de teste:** `android/app/build/outputs/apk/debug/app-debug.apk`

- pacote `br.com.portariaprime.kiosk`;
- versionCode 1, versionName 1.0.0;
- minSdk 26 (Android 8.0), targetSdk 35;
- SHA-256 `b92b9f2c3b8e0086949714de4765a49534166b533edc08c46268d5a559e3d2ad`.

Esse APK aponta para produção (`portariaprime.vercel.app` + Supabase de produção).

A variante de laboratório (`-PppLab=true`) aponta para a stack local por `adb reverse`. Ela é a única que aceita `http://127.0.0.1`, mantém o ADB ligado e abre o DevTools da WebView.

## Ambiente

| Item | Situação |
|---|---|
| Toolchain | JDK 17.0.20.1, SDK 35, build-tools 35, Gradle 8.11.1 em `J:\android-toolchain` (fora do repositório) |
| Emulador | AVD `ppkiosk34`: Pixel Tablet, Android 14 (API 34), imagem AOSP x86_64, aceleração WHPX, sem contas |
| Device Owner | `adb shell dpm set-device-owner br.com.portariaprime.kiosk/.admin.KioskAdminReceiver` (procedimento de **laboratório**) |
| Backend do teste | Stack Supabase local + Vite/API locais, ligados ao emulador por `adb reverse` |
| Aparelho físico | **Nenhum.** Homologação pendente: roteiro abaixo |

Correção do relatório anterior: o emulador **é** viável nesta máquina. Ele usa o Windows Hypervisor Platform (WHPX). O indicador `VirtualizationFirmwareEnabled=False` lido antes não refletia o hypervisor ativo.

## Resultados no emulador gerenciado (Device Owner real, Lock Task real)

| # | Teste | Resultado |
|---|---|---|
| 1 | Provisionamento como Device Owner e inscrição com código de uso único | ✔ `Device Owner: admin=…KioskAdminReceiver`. Inscrição pelo app: painel mostra "ativo / Device Owner · conforme" |
| 2 | Single-App: Home, Recentes, `am start` de Configurações, `monkey` em outro app e intent `VIEW` https | ✔ Em todos os casos o topo continua sendo `KioskActivity`; `mLockTaskModeState=LOCKED` |
| 3 | Barra de notificações (`cmd statusbar expand-notifications`) | ✔ Foco permanece no quiosque |
| 4 | Navegação interna por pushState para outro condomínio, `/admin`, `/org`, `/contratar` e `/planos` | ✔ Todas devolvidas a `/c/<condomínio inscrito>/…` (`tests/e2e/kiosk-webview.mjs`) |
| 5 | `location.href` para outro condomínio, https externo e `intent:`; `window.open`; `target=_blank` | ✔ Bloqueados; Lock Task mantido |
| 6 | Autorização no servidor com a sessão do porteiro | ✔ Ver detalhamento abaixo |
| 7 | Manutenção remota pelo painel (síndico) | ✔ Comando → recebido → aplicando → aplicado; `LOCKED → NONE`; Configurações do Android abrem |
| 8 | Encerrar manutenção manualmente no aparelho | ✔ Volta a `LOCKED`; evento `maintenance.end reason=manual` no servidor |
| 9 | Retorno automático no prazo | ✔ Ver detalhamento abaixo |
| 10 | Reinício durante manutenção de 30 min | ✔ Após o boot: `LOCKED` no condomínio correto; evento `maintenance.end reason=reboot` |
| 11 | Reinício sem internet (Wi-Fi e dados desligados; servidor inalcançável) | ✔ Ver detalhamento abaixo |
| 12 | Recuperação offline com código descartável | ✔ Ver detalhamento abaixo |
| 13 | Parada forçada do app (`am force-stop`) | ✔ O Android reabre o quiosque sozinho, já em `LOCKED` |
| 14 | Atualização do APK | ✔ Fora da manutenção é recusada (`User restriction prevents installing`, restrição `no_install_apps` funcionando). Dentro da manutenção instala e mantém Device Owner e inscrição |
| 15 | Troca de turno auditada | ✔ Ver detalhamento abaixo |
| 16 | Fluxo completo: etiqueta pela câmera → registro com guarda confirmada → QR do morador → leitura do QR → assinatura → foto do item → comprovante → PDF | ✔ Ver detalhamento abaixo |

**#6 — autorização no servidor com a sessão do porteiro:**
- `mdm_overview` (do próprio condomínio e de outro), `create_invitation` de admin e `mdm_command_create` são **negados**;
- `platform_context` não tem capacidades;
- nenhuma encomenda de outro condomínio é visível;
- a tabela `mdm_devices` está fechada.

**#9 — retorno automático no prazo:**
- Manutenção de 5 min: voltou dentro da janela do alarme inexato. Corrigido para alarme exato.
- Manutenção offline de 15 min: voltou em **888 s** (prazo de 900 s).

**#11 — reinício sem internet:**
- Volta a `LOCKED` em cerca de 3 s após o boot.
- A tela mostra "Sem conexão com o Portaria Prime… nenhum comprovante é gerado offline".

**#12 — recuperação offline com código descartável:**
- Código errado: continua `LOCKED`.
- Código válido offline: `NONE`, com Configurações acessíveis.
- O mesmo código usado de novo é recusado.
- Após 5 erros, um código válido é bloqueado (`recovery.locked`).
- Ao reconectar, a fila local enviou ao servidor `maintenance.offline_start idx=0`, `maintenance.end expired`, `recovery.failed` ×6 e `recovery.locked`.

**#15 — troca de turno auditada:**
1. O porteiro A sai pelo menu.
2. A tela de login aparece **dentro do quiosque**.
3. A porteira B entra.
4. O servidor registra `shift.end` (porteiro A) e `shift.start` (porteira B), com `actor_id`, `device_id`, `tenant_id`, papel e horário do servidor.

**#16 — fluxo completo de encomenda:**
- Protocolo `PP-20261028-AC9DBCF9`, com 2 avisos ao morador.
- O PDF abriu no **visualizador interno** (`PdfRenderer`), sem navegador e sem sair do quiosque.
- Detalhes de câmera e OCR nas limitações abaixo.

Evidências: `tests/evidence/emu-*.png` (não versionadas). Roteiros: `tests/e2e/kiosk-lab-setup.mjs`, `kiosk-lab-cmd.mjs`, `kiosk-webview.mjs` e `kiosk-flow.mjs`.

### Falhas encontradas no emulador e corrigidas

1. **O APK apontava para o projeto Supabase antigo.** Corrigido para o projeto de produção.
2. **A política embutida bloqueava o ADB antes do primeiro contato com o servidor**, o que tirou o acesso ao emulador. Agora `no_debugging` só vale quando vem da política do servidor; o build de laboratório nunca desliga o ADB.
3. **Falta de rede perdia o reagendamento da sincronização.** `flushEvents` lançava exceção antes do `finally`. Corrigido: depois de ficar offline, o agente volta a sincronizar sozinho.
4. **A tela "sem conexão" criava um laço** de eventos `policy.failed`. Corrigido: tentativa única a cada 20 s e evento limitado a 1 por minuto.
5. **A navegação SPA (pushState) não passava pelo filtro.** Adicionado `doUpdateVisitedHistory`, e o filtro de rota agora exige o **condomínio inscrito** e áreas de operação.
6. **Tela branca depois de bloquear uma navegação externa** do quadro principal. O app passa a recarregar o início do condomínio.
7. **A expiração da manutenção dependia de alarme inexato** (atraso de minutos). Agora usa alarme exato.
8. **O painel mostrava estado antigo após boot ou fim de manutenção.** Agora o agente sincroniza imediatamente.
9. **Faltava auditoria de troca de turno.** Implementada (migração `0500`): o aparelho recebe um nonce no sync assinado, o app web o recebe pelo fragmento `#ppk=` (sem bridge JavaScript) e o servidor só registra se o operador for da equipe ativa daquele condomínio.

## Limitações comprovadas (não escondidas)

- **Câmera no emulador:**
  - O emulador sem janela não fornece câmera (`cr_VideoCapture: unknown device 0`).
  - A permissão `CAMERA` foi concedida e fixada pelo DPC (`granted=true, POLICY_FIXED`), e a WebView libera a câmera só para a origem do app.
  - No fluxo #16, o vídeo foi substituído por um canvas com a imagem da etiqueta, do QR e do item. O leitor jsQR, o recorte, o upload e as RPCs são os reais.
  - **Câmera física: só no aparelho.**
- **OCR:**
  - O botão de leitura automática não apareceu no ambiente local (`feature_ocr` indisponível para este condomínio de teste e sem chave Gemini na stack local).
  - O registro foi feito digitando os dados, que é o caminho previsto.
  - O OCR real foi validado antes, no web app (`docs/OCR_VALIDACAO.md`). **Não foi testado dentro do quiosque.**
- **PDF no ambiente local:** a fila de PDFs processa 5 por execução do job, então o PDF fica disponível alguns minutos após a entrega. É o comportamento esperado.
- **Reinício com senha de tela:** não testado (o emulador não tinha bloqueio de tela).
- **Restauração de fábrica pelo recovery:** fora de alcance; não é bloqueável por software.

## Homologação física: roteiro para o aparelho do condomínio

**Não execute restauração de fábrica sem confirmar:**
- que o aparelho é do condomínio;
- que há backup;
- que contas pessoais e senhas foram removidas.

O processo apaga tudo. Para cada aparelho, anote: fabricante, modelo, versão do Android, patch de segurança, se é Android Go e a versão do agente.

**Preparação, feita por nós (pendente):**
- assinar o APK com a chave definitiva;
- hospedar o APK em HTTPS;
- publicar a versão no Admin Master.

Sem isso, o QR não aparece no painel.

**Passo a passo (devolva os resultados de cada item):**
1. No painel: Configurações → Dispositivos e quiosque → Adicionar dispositivo → Gerar QR de provisionamento.
2. Restaure o aparelho de fábrica. Na tela de boas-vindas, toque 6 vezes, conecte ao Wi-Fi e leia o QR. Anote se o Android pediu algo diferente.
3. Quando o app abrir na portaria, confirme no painel "ativo / Device Owner · conforme". Tire uma foto da tela do aparelho.
4. Tente sair: Início, Recentes, puxar a barra de cima, botão liga/desliga. Anote o que aparece.
5. Entre como porteiro e:
   - fotografe uma etiqueta real;
   - registre a encomenda;
   - no celular do morador, gere o QR;
   - leia o QR com a câmera do tablet;
   - colha a assinatura e a foto do item;
   - abra o PDF.
6. Troca de turno: saia e entre com outro porteiro. Confirme no painel (Detalhes → Eventos) `shift.end` e `shift.start`.
7. Reinicie o aparelho com e sem senha de tela. Anote o tempo até voltar à portaria.
8. Manutenção:
   - pelo painel, com 5 min: confira se abre as Configurações e volta sozinho;
   - em modo avião, com um código impresso: idem;
   - erre o código 5 vezes: deve bloquear.
9. Troque o Wi-Fi pelo painel com a senha errada (deve voltar para a rede anterior) e depois com a certa.
10. Se houver leitor USB ou Bluetooth, leia um código de rastreio no campo Rastreio.
11. Deixe ligado na tomada por 8 h. Anote a temperatura e se a tela permaneceu ligada.
12. Só se for retirar o aparelho do serviço: Desativar gerenciamento. Anote se ele voltou ao uso comum ou se pediu restauração.

Envie fotos, os horários e o modelo. Só depois disso o modelo entra como homologado.

## Pendências

- Chave de assinatura definitiva (guardar com backup), hospedagem HTTPS do APK e publicação da versão no Admin Master.
- Homologação física (roteiro acima).
- FCM não implementado: a v1 só faz polling (120 s na política padrão).
- Atualização silenciosa do APK não implementada: hoje a atualização é manual, dentro da manutenção.
- Revisão jurídica do texto sobre gestão institucional.
