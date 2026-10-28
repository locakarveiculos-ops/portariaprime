# QA — Dispositivos gerenciados e Portaria Prime Kiosk

Data: 28/10/2026. **O módulo NÃO está homologado.** Ainda não houve teste em aparelho físico nem em emulador gerenciado. Esta não é uma solução de MDM completa: é um agente próprio para quiosque Single-App/Multi-App com o conjunto de políticas listado no ADR.

## Ambiente desta rodada

| Item | Situação |
|---|---|
| JDK 17 (Temurin 17.0.20.1), Android SDK 35, build-tools 35, Gradle 8.11.1 | Instalados em `J:\android-toolchain`, fora do repositório; downloads com checksum conferido |
| Aparelho físico | **Nenhum conectado** (`adb devices` vazio) |
| Emulador | **Inviável nesta máquina**: virtualização desligada no firmware (`VirtualizationFirmwareEnabled = False`) |
| Banco/API/painel | PGlite (testes), stack Supabase local e Microsoft Edge (Playwright) |

## Executado e aprovado

| Suíte | Resultado | O que prova |
|---|---|---|
| `tests/db/mdm.test.mjs` (PGlite) | 11/11 | Ver detalhamento abaixo |
| `tests/api/kiosk.test.mjs` | 3/3 | Ver detalhamento abaixo |
| `tests/mdm-frontend.test.mjs` | 3/3 | Ver detalhamento abaixo |
| `android: testDebugUnitTest` (JUnit, JVM) | 7/7 | Ver detalhamento abaixo |
| `android: lintDebug` | 0 erros | Uso de APIs acima do minSdk corrigido (WPA3 só no 30+, brilho só no 28+) |
| `android: assembleDebug` / `assembleRelease` | APK debug de 870 KB; release de 57 KB assinado com **chave de laboratório** | Build reproduzível. Checksum da assinatura de laboratório: `WViSjDZLiV0TRkYzKjBo81z0c0P2JPKSKfScI-kfofc` |
| `tests/e2e/devices.mjs` (stack local, Edge real e agente simulado com chave P-256) | OK | Ver detalhamento abaixo |
| Suítes existentes `test:db` / `test:api`, typecheck, lint e build web | Ver o resumo da entrega | Nada do sistema existente regrediu |

**`tests/db/mdm.test.mjs`**
- Permissão: só síndico com "settings"; porteiro e outro condomínio são recusados; tabelas fechadas.
- Exigência de login recente.
- Token de inscrição: uso único, expiração, revogação do anterior e tentativa recusada auditada.
- Aparelho sem Device Owner fica em "falha".
- Anti-replay por contador.
- Política desejada × aplicada; estado "offline" calculado pelo último contato.
- Política: câmera não bloqueável; campo desconhecido recusado; Single-App sem Início/Recentes; catálogo de apps.
- Publicação de política; piloto obrigatório antes de lote; isolamento entre condomínios.
- Comandos: enumerados, idempotentes, com expiração (desbloqueio velho não vale depois de reconectar); ACK em ordem.
- Senha de Wi-Fi nunca aparece no painel nem nos eventos e é apagada após o ACK.
- Códigos de recuperação: só hash; uso registrado.
- Desativação: pendente até o ACK; credencial revogada depois; confirmação local quando o aparelho foi perdido.
- Admin Master: leitura auditada; financeiro sem acesso; publicação do agente só pelo owner; suporte não comanda aparelhos.

**`tests/api/kiosk.test.mjs`**
- Prova de posse da chave na inscrição; RSA recusado.
- Assinatura ECDSA válida aceita.
- Recusados: corpo adulterado, chave de outro aparelho, aparelho desconhecido, assinatura de outra rota.
- Token em texto nunca chega ao banco.

**`tests/mdm-frontend.test.mjs`**
- Payload do QR contém só chaves `android.app.extra.PROVISIONING_*` e exige HTTPS.
- PBKDF2 do navegador idêntico ao de referência do Node.
- A matriz de capacidades não oferece bloqueio de câmera.

**`android: testDebugUnitTest`**
- Revalidação local da política (câmera, campos, Single-App).
- `NavigationGuard`: bloqueia `intent:`, `file:`, `content:`, `javascript:`, http, host parecido, userinfo, `/admin`, `market:` e `tel:`; PDF assinado vai ao visualizador interno; câmera só na origem do app.
- Manutenção expira pelo tempo desde o boot e não sobrevive a reboot.
- Códigos offline: uso único, bloqueio após 5 erros; reboot não fura o bloqueio.
- Backoff com teto.

**`tests/e2e/devices.mjs`**
1. O painel cadastra o aparelho.
2. O QR é gerado (com reautenticação quando o login é antigo).
3. O agente se inscreve; o token reutilizado é recusado.
4. Replay é recusado.
5. Status "Ativo · conforme".
6. Manutenção pedida no painel → recebida → aplicada (ACK real no painel).
7. Códigos de recuperação exibidos uma vez; só o hash fica no banco.
8. Desativação fica pendente até o ACK; depois aparece "Fora do gerenciamento" e a credencial passa a ser recusada.
9. Sem rolagem horizontal em 360 px e 1280 px.

Evidências: `tests/evidence/devices-*.png` (não versionadas).

## Matriz obrigatória — situação

Legenda: **S** = servidor/painel provado; **J** = lógica do agente provada na JVM; **F** = depende de aparelho físico/emulador (**pendente**).

| # | Item | Situação |
|---|---|---|
| 1 | Inscrição válida, token expirado/reutilizado, outro tenant, aparelho já gerenciado | S ✔ · F pendente: QR real na tela de boas-vindas e aparelho com outro DPC (o Android recusa; precisa observar a mensagem) |
| 2 | Single-App: Home, Recentes, Voltar, status bar, notificações, teclado, links, compartilhar, arquivo, PDF, atividades externas | J ✔ (navegação, PDF, esquemas) · F pendente: comportamento do Lock Task, teclado do fabricante, seletor de arquivos e câmera na WebView |
| 3 | Multi-App: permitidos, não permitidos, ausente, atualização, troca de política | S ✔ (catálogo, inventário) · F pendente |
| 4 | Reinício, tela bloqueada, crash do agente/WebView, atualização, perda de energia — retorno sem loop | J ✔ (manutenção encerra no reboot) · F pendente: launcher persistente após boot, `onRenderProcessGone`, Direct Boot/criptografia |
| 5 | Rede perdida, Wi-Fi inválido com rollback, heartbeat atrasado, comando duplicado/expirado, revogação | S ✔ · J ✔ (backoff) · F pendente: Wi-Fi em duas etapas (`addNetwork` como Device Owner varia por versão) |
| 6 | Manutenção online/offline, expiração local, tentativas erradas, recuperação, retirada de gerenciamento | S ✔ · J ✔ · F pendente: alarme de expiração com Doze e `clearDeviceOwnerApp` por fabricante |
| 7 | Etiqueta, OCR, morador, guarda, QR, assinatura, foto, PDF, notificações ponta a ponta | Web já coberto por `test:journey` (navegador) · F pendente: **dentro da WebView do quiosque** |
| 8 | Troca de porteiro sem sair do quiosque; acesso indevido a síndico/admin global; isolamento de API/storage | S ✔ (RLS/RPC; `/admin` bloqueado na navegação) · F pendente: fluxo de logout/login na WebView |
| 9 | Leitores USB/Bluetooth; câmera negada; botão físico | F pendente (não há leitor nem aparelho) |
| 10 | Nada perigoso executado em produção | ✔ Nenhuma migração, deploy ou reset em produção nesta entrega. Testes só em PGlite e na stack local |

## Homologação física pendente (roteiro)

Use **aparelho de laboratório** do próprio projeto. Nunca use aparelho de cliente. Para cada modelo, registre fabricante, modelo, versão do Android, patch de segurança, se é Android Go e a versão do agente.

1. Restaurar de fábrica → QR (após publicar uma versão com chave definitiva ou de laboratório) → confirmar Device Owner (`adb shell dumpsys device_policy`).
2. Single-App:
   - Início, Recentes e Voltar não saem do app.
   - Status bar bloqueada.
   - Teclado funciona.
   - Câmera: foto da etiqueta e leitura de QR.
   - Upload de arquivo.
   - Comprovante PDF.
   - Link externo bloqueado.
3. Reiniciar:
   - volta ao Portaria Prime sem tocar em nada;
   - com senha de tela: só depois do desbloqueio, e sem loop.
4. Forçar parada do app (`am force-stop`) e encerrar a WebView (`am crash` / `chrome://crash`): o app volta.
5. Manutenção:
   - pelo painel: Configurações abre e o app volta no prazo;
   - em modo avião, com código: idem;
   - 5 códigos errados: bloqueio;
   - reiniciar durante a manutenção: volta ao quiosque.
6. Wi-Fi:
   - senha errada: volta para a rede anterior;
   - rede correta: troca e remove a anterior.
7. Multi-App: Calculadora instalada aparece e abre; desinstalada aparece como "ausente"; app fora da lista não abre.
8. Leitor USB/Bluetooth (HID), se houver: digitar código de rastreio.
9. Desativar pelo painel e anotar se o modelo voltou ao uso comum sem restauração.
10. Medir bateria e temperatura em 8 h de tela ligada na tomada.

Só depois disso um modelo entra como **homologado** na documentação de vendas. Nenhum modelo foi homologado até agora.

## Pendências não técnicas

- Chave de assinatura definitiva + hospedagem HTTPS do APK + "Publicar versão" no Admin Master.
- Aplicar as migrações `20261028000100…0400` em produção (não aplicadas; seguir `DEPLOY.md` com backup).
- Credencial FCM, se o sinal de push for adotado (v1 usa só polling).
- Texto dos termos do módulo (gestão institucional e dados coletados) para revisão jurídica.
