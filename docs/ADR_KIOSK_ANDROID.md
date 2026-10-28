# ADR — Dispositivos gerenciados e Portaria Prime Kiosk

Data: 28/10/2026 · Situação: **aceita para v1; homologação física pendente** (ver `KIOSK_QA.md`).

## Contexto

O condomínio quer tablets/celulares próprios dedicados à portaria. O PWA não consegue impedir a saída para o Android: fullscreen, service worker, interceptar o botão Voltar e fixar a tela não equivalem a gerenciamento. Lock Task gerenciado, restrições do sistema e recuperação após reboot exigem um DPC (Device Policy Controller) como **Device Owner**.

Já existe o totem PWA (`device_enrollments`, segredo por aparelho). Ele continua igual e é outro produto: não gerencia o Android.

Este projeto não tinha integração MDM aprovada. Um aparelho só pode ter um Device Owner, então a v1 não convive com outro MDM no mesmo aparelho.

## Decisão

App nativo **Portaria Prime Kiosk** (Kotlin, `android/`, pacote `br.com.portariaprime.kiosk`). Um único APK reúne:

- **DPC**: `KioskAdminReceiver`, `ProvisioningActivity` e `PolicyEnforcer`. Usa apenas APIs públicas de `DevicePolicyManager`.
- **Launcher e quiosque** (`KioskActivity`):
  - Atividade HOME persistente com Lock Task (`if_whitelisted`).
  - Barra de atalhos no Multi-App.
- **WebView endurecida** sobre o sistema web existente. Nenhuma regra de negócio duplicada no Android.

Mantivemos DPC e interface no mesmo pacote porque Lock Task e launcher persistente precisam pertencer ao pacote do DPC, ou a uma lista de permissões que ele mesmo controla. Separar em dois APKs exigiria duas assinaturas e duas atualizações sincronizadas, sem ganho de segurança. Dentro do APK, o isolamento é feito por pacotes:

- `core/`: lógica pura, testada na JVM.
- `admin/`: DPC.
- raiz do pacote: agente e interface.

O backend fica nas funções existentes (Supabase RPC + Vercel). Não há daemon permanente:

- Comandos ficam em tabela durável.
- O aparelho busca por **polling com backoff** (JobScheduler).
- O FCM está previsto apenas como sinal de "acorde e sincronize". **Não foi implementado na v1**: depende de credencial FCM do projeto, que não foi publicada nem configurada.

O tempo real não é garantido, nem online nem offline.

## Alternativas avaliadas

| Alternativa | Por que não na v1 |
|---|---|
| **Android Management API (Google)** | Exige projeto Google Cloud, aceite das regras de uso permitido (*permissible usage*), elegibilidade e cotas. O uso em produção depende de aprovação, e o acesso não é automático nem irrestrito. Também tira de nós o controle fino de manutenção offline e dos códigos de recuperação. Fica como evolução se a escala justificar: o modelo de dados (políticas versionadas, comandos, ACK) é compatível. |
| **EMM comercial** (ex.: Intune, Hexnode, Scalefusion etc.) | Custo por aparelho e contrato com terceiro: **não contratado sem autorização**. Também cria dois painéis para o síndico. Fica documentado como opção para quem já tem EMM: nesse caso o Kiosk **não** deve ser Device Owner; ele seria distribuído como app gerenciado pelo EMM, que faria o Lock Task. |
| **Legacy Device Admin** | Obsoleto, não faz Lock Task gerenciado e **não é equivalente a Device Owner**. Não usado. |
| **Fixar tela / fullscreen / acessibilidade / overlay / root** | Não é gerenciamento. Overlay, acessibilidade e root são proibidos por segurança e pelas políticas da loja. Não usado. |

## Segurança (resumo)

**Provisionamento × pareamento**
- O QR de configuração inicial (payload documentado, APK por HTTPS e checksum da assinatura) concede Device Owner.
- O token de inscrição de 24 caracteres vincula o aparelho ao condomínio. Ele é de uso único, dura 10 a 120 min, fica atrelado ao aparelho pretendido e só o hash vai para o banco.

**Identidade do aparelho**
- Chave EC P-256 gerada no **Android Keystore** (StrongBox quando houver), não exportável.
- O banco guarda só a chave pública.
- Toda requisição é assinada sobre método, caminho, aparelho, contador e SHA-256 do corpo.
- O **contador estritamente crescente** é validado com trava de linha no banco: impede replay e reordenação.
- Ao se inscrever, o aparelho prova posse da chave.

**Autoridade**
- O tenant vem sempre do registro no banco. Tabelas MDM sem grant para clientes; tudo passa por RPC.
- Ações sensíveis exigem login de até 5 min (claim `amr` do JWT) e MFA, se cadastrado.
- O Admin Master só lê, com auditoria. Não envia comandos.

**Comandos**
- Lista fechada: `sync_policy`, `start_maintenance`, `end_maintenance`, `reboot`, `wifi_apply`, `deactivate`. Não existe shell remoto.
- Cada comando tem expiração própria. O de manutenção vale **10 min**: um desbloqueio antigo não vale depois de reconectar.
- Idempotência e ordem por `seq`.

**WebView**
- Só HTTPS, apenas com CAs do sistema. Erro de SSL cancela a carga.
- Navegação permitida só para `/c/*` e telas de login da origem do app, fixa no APK.
- Sub-recursos limitados ao app e ao Supabase.
- `intent:`, `file:`, `content:`, `javascript:`, pop-ups e downloads são bloqueados.
- Câmera liberada só para a origem do app.
- PDF assinado é renderizado internamente (`PdfRenderer`).
- **Nenhuma bridge JavaScript.**

**Manutenção**
- Prazo contado por `elapsedRealtime` (tempo desde o boot), não pelo relógio de parede. Reboot encerra a manutenção.
- Expiração local via alarme, mesmo offline.

**Recuperação offline**
- 10 códigos de uso único gerados no navegador do síndico. Servidor e aparelho guardam só PBKDF2-HMAC-SHA256 (120 mil iterações, sal por código).
- 5 erros bloqueiam por 15 min, com bloqueio progressivo. Reboot não fura o bloqueio.

**Câmera**
- Nenhuma política consegue bloqueá-la: validação no banco, no Android e na interface.
- O agente força `setCameraDisabled(false)` e concede a permissão de câmera ao próprio app.

## Limitações conhecidas (não prometidas)

- Não impede restauração de fábrica pelos botões físicos (recovery), flash nem desligamento forçado.
- Notificações do sistema bloqueadas no Single-App: banners de push do sistema podem não aparecer. Os avisos internos do Portaria Prime continuam.
- `clearDeviceOwnerApp` é obsoleto. Em parte dos aparelhos, voltar ao uso comum exige restauração de fábrica.
- Abaixo do Android 9 (API 28) não há escolha de recursos do Lock Task. O agente exige Android 8.0+ (API 26).
- Compatibilidade por fabricante, Android Go e aparelhos econômicos **só após homologação física**.
- Sem apagamento remoto (*wipe*) na v1, por decisão de escopo.
- Geofencing não implementado: desligado por padrão, conforme exigido.
- Push/FCM não implementado na v1: só polling.
