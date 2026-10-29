# Aparelho dedicado de teste: instalar e remover a variante de laboratório

Para testar o quiosque num aparelho **real dedicado a teste**, sem restauração de fábrica, e retirar tudo depois só pelo cabo USB.
**Não use** em aparelho de cliente nem em celular pessoal ou de funcionário.

A variante de laboratório é `portaria-prime-kiosk-1.0.1-lab.apk`. Ela é diferente da versão de produção:

| | Laboratório (lab) | Produção (release) |
|---|---|---|
| Nome no aparelho | "PP Kiosk LAB (teste)" + faixa vermelha "LABORATÓRIO" | "Portaria Prime Kiosk" |
| `android:testOnly` | sim: só instala por `adb install -t` | não |
| Remover o gerenciamento por cabo (`dpm remove-active-admin`) | **aceito** pelo Android | **recusado** pelo Android |
| ADB | nunca é desligado pela política | a política pode desligar |
| Assinatura | chave de debug | chave definitiva |
| Servidor | produção (`portariaprime.vercel.app`) | produção |

Um aparelho com a variante lab **não** pode ser atualizado para a versão de produção: as assinaturas são diferentes. Para passar para produção é preciso remover a lab (passo 5) e provisionar de novo.

## 1. Identificar o aparelho (antes de qualquer mudança)

Não remova contas nem perfis sem antes ver o que existe. Com a depuração USB ligada, rode os comandos abaixo. Eles só **leem** e não mudam nada:

```bash
adb shell getprop ro.product.manufacturer      # fabricante
adb shell getprop ro.product.model             # modelo
adb shell getprop ro.build.version.release     # versão do Android
adb shell pm list users                        # usuários e perfis (Pasta Segura, Segundo espaço, perfil de trabalho)
adb shell dumpsys account | grep -E "Account \{|Accounts:"   # contas cadastradas
adb shell dumpsys device_policy | grep -E "Device Owner|Profile Owner|admin="   # outro gerenciador?
```

Mande a saída para nós. Com ela dizemos o que precisa ser ajustado **nesse aparelho** e o impacto de cada ajuste.

O Android só aceita o comando de laboratório (`dpm set-device-owner`) se:

| Condição | Se não atender |
|---|---|
| `pm list users` mostra **só** `UserInfo{0:…}` | Cada usuário ou perfil extra impede o comando. Pasta Segura (Samsung), Segundo espaço (Xiaomi), apps duplicados e perfil de trabalho são perfis. Removê-los **apaga os dados de dentro deles**. Só remova se o conteúdo não for necessário. |
| `dumpsys account` mostra `Accounts: 0` | Cada conta (Google, Samsung, Xiaomi e outras) impede o comando. Ao remover uma conta, os dados sincronizados (contatos, agenda, fotos na nuvem) **saem do aparelho, mas continuam na nuvem**. A conta pode voltar depois da instalação, mas enquanto o quiosque estiver ativo a política bloqueia adicionar contas. |
| Nenhum `Device Owner` ou `Profile Owner` de outro app | Aparelho gerenciado por empresa: **pare** e peça a liberação a quem gerencia. |

Alguns fabricantes recusam o comando mesmo com tudo certo. Se aparecer erro, mande a mensagem completa.

## 2. Pré-requisitos

- Computador com o `adb` (Android SDK Platform-Tools) e cabo USB de dados.
- No aparelho: Opções do desenvolvedor → **Depuração USB** ligada; autorize o computador na janela "Permitir depuração USB?".
  - Xiaomi/Redmi/POCO: ligue também "Depuração USB (configurações de segurança)".
- Aparelho cadastrado no painel: Configurações → Dispositivos e quiosque → **Adicionar dispositivo**.
- **Backup** do que importar no aparelho. Os fluxos abaixo não apagam dados (testado em emulador), mas comportamento de fabricante não está validado.

## 3. Instalar e ativar

```bash
adb install -t portaria-prime-kiosk-1.0.1-lab.apk
adb shell dpm set-device-owner br.com.portariaprime.kiosk/.admin.KioskAdminReceiver
```

Resposta esperada: `Success: Device owner set to package …`. Depois:

1. Abra o app "PP Kiosk LAB (teste)".
2. No painel, Detalhes do aparelho → **Gerar QR de provisionamento** → **Gerar código de uso único**.
3. Digite no app o código de 24 caracteres. O app abre a portaria do condomínio, em quiosque.

## 4. Testar

Siga `docs/KIOSK_HOMOLOGACAO_FISICA.md`, itens 3 a 17. Anote modelo, Android e o resultado de cada item.

## 5. Remover

**Pelo painel (aparelho com internet):** Detalhes → Desativar gerenciamento → Solicitar desativação. Em até ~2 min o painel mostra "desativado" e o app mostra "Gerenciamento retirado". Depois desinstale normalmente ou por `adb uninstall br.com.portariaprime.kiosk`.

**Por cabo (sem internet ou sem painel), só na variante lab:**

```bash
adb shell dpm remove-active-admin br.com.portariaprime.kiosk/.admin.KioskAdminReceiver
adb uninstall br.com.portariaprime.kiosk
```

Depois, no painel: Desativar gerenciamento → Solicitar desativação → **Registrar liberação local** (descreva o que foi feito).

**Confira no aparelho:** Configurações abre, apps instalam e desinstalam, botão Início volta à tela do fabricante. Se o Android perguntar qual tela inicial usar, escolha a do fabricante. Anote qualquer restrição que tenha ficado.

## 6. Se algo der errado

- **Preso no quiosque, com internet:** painel → Abrir manutenção, ou Desativar gerenciamento.
- **Preso no quiosque, sem internet:** remoção por cabo (passo 5). O ADB fica ligado na variante lab, inclusive após reiniciar.
- **Cabo não reconhecido:** confira a depuração USB e a autorização do computador. A política lab não bloqueia o ADB.
- **Último recurso:** restauração de fábrica, que **apaga o aparelho**. Só com sua autorização.
