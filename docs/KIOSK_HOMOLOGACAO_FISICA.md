# Roteiro de homologação física — Portaria Prime Kiosk

Este roteiro valida o quiosque em um celular ou tablet **real**. O emulador já foi testado (`KIOSK_QA.md`), mas isso **não** equivale à homologação física. Cada modelo precisa passar por este roteiro antes de ser recomendado a clientes.

Tempo estimado: 1 h 30 min, mais 8 h de teste de tomada (item 11).

## Antes de começar (obrigatório)

1. **O aparelho deve ser do condomínio** ou de laboratório. Nunca use celular pessoal, de morador ou de funcionário.
2. **O processo apaga tudo do aparelho.** O Android só deixa um app virar "proprietário" (Device Owner) em aparelho recém-restaurado de fábrica. Antes de restaurar:
   - faça backup do que for importante (fotos, documentos, conversas);
   - anote as senhas de Wi-Fi da portaria;
   - **remova a conta Google** (Configurações → Contas → remover). Com a conta presente, o aparelho pode pedir essa conta depois do reset (proteção contra roubo);
   - se o aparelho já for gerenciado por uma empresa (outro MDM), **pare** e peça a liberação a quem gerencia.
3. **A restauração de fábrica só pode ser feita com a sua autorização expressa.** O roteiro não faz isso sozinho.
4. Requisitos do aparelho:
   - Android 8.0 ou superior. Recomendado Android 9+, que permite escolher recursos do quiosque;
   - câmera traseira funcionando;
   - Wi-Fi da portaria com internet.
5. Do nosso lado (pendente): APK de produção assinado com a chave definitiva, hospedado em HTTPS e publicado no Admin Master. **Sem isso, o QR de provisionamento não aparece no painel.** Alternativa de laboratório, só para aparelho de teste: instalação por cabo USB, ver o anexo no final.

## Anote para cada aparelho

| Campo | Valor |
|---|---|
| Fabricante e modelo | |
| Versão do Android | |
| Patch de segurança (Configurações → Sobre) | |
| É Android Go? (sim/não) | |
| Versão do app (aparece na tela de inscrição) | |
| Data e quem testou | |

## Passo a passo

Para cada item, anote **Aprovado** ou **Reprovado**, com uma foto da tela e o horário.

| # | O que fazer | Critério de aprovação |
|---|---|---|
| 1 | No painel: Configurações → Dispositivos e quiosque → **Adicionar dispositivo** → **Detalhes** → **Gerar QR de provisionamento** (pode pedir sua senha). Anote o horário. | QR aparece, com o aviso de uso único e validade de 1 h |
| 2 | Restaure o aparelho (só com autorização). Na tela "Bem-vindo", **toque 6 vezes** no mesmo ponto, conecte ao Wi-Fi e leia o QR. | O Android baixa o app e mostra que o aparelho é gerenciado pelo condomínio. Anote qualquer tela diferente |
| 3 | Aguarde o app abrir. | Abre a **portaria do seu condomínio**; no painel aparece "Ativo · Device Owner · conforme" |
| 4 | Tente sair: botão Início, Recentes, puxar a barra de cima, segurar o botão liga/desliga, abrir Configurações. | Nenhum deles sai do Portaria Prime (o menu de desligar pode aparecer, conforme a política) |
| 5 | Entre como **porteiro**: fotografe uma etiqueta real → confira a sugestão de leitura → confirme morador e unidade → marque "Guardei fisicamente" → registrar. | Encomenda registrada; o morador recebe o aviso no app |
| 6 | No celular do morador, abra a encomenda e gere o QR. No tablet: Entregar → **Ler QR** com a câmera → nome de quem retira → assinatura → foto do item → **Confirmar**. | Comprovante com protocolo `PP-…`; "Baixar PDF" abre o PDF **dentro** do app, sem navegador |
| 7 | Toque em um link externo, se houver, ou tente abrir outro site. | Mensagem "Link externo bloqueado" e o app continua |
| 8 | **Troca de turno:** menu da conta → Sair → outro porteiro entra. | A tela de login aparece dentro do quiosque; no painel, Detalhes → Eventos mostra `shift.end` e `shift.start` com os nomes |
| 9 | **Reinicie** o aparelho (sem senha de tela) e marque o tempo. Repita com senha de tela, se usar. | Volta sozinho à portaria; com senha, volta depois do desbloqueio; sem tela presa em laço |
| 10 | **Sem internet:** ligue o modo avião e reinicie. | Volta ao quiosque com o aviso "Sem conexão…"; nenhuma entrega é confirmada offline |
| 11 | **Manutenção pelo painel:** Detalhes → Abrir manutenção (5 min, motivo). No tablet, entre em Configurações e mude algo simples, como o brilho. Espere os 5 min sem tocar. | As Configurações abrem; "Restaurar padrão de fábrica" continua **bloqueado**; volta sozinho ao quiosque em cerca de 5 min |
| 12 | Abra outra manutenção e encerre pelo botão **Encerrar manutenção agora** no tablet. | Volta ao quiosque na hora |
| 13 | Abra uma manutenção de 30 min e **reinicie** no meio. | Depois do boot volta ao quiosque (a manutenção termina com o reinício) |
| 14 | **Recuperação offline:** no painel, Códigos de recuperação → Gerar 10 → imprima. Ligue o modo avião. No tablet: **Manutenção** → digite um código. | Abre a manutenção; o mesmo código não funciona uma segunda vez; 5 códigos errados bloqueiam por 15 min |
| 15 | **Wi-Fi:** no painel, Trocar Wi-Fi com a **senha errada**; depois com a senha certa. | Senha errada: volta para a rede anterior. Senha certa: troca e remove a antiga |
| 16 | Se houver leitor de código USB ou Bluetooth: no campo Rastreio, leia uma etiqueta. | O código entra no campo |
| 17 | Deixe ligado na tomada por 8 h, com a tela ativa na portaria. | Sem superaquecimento (anote a temperatura ao toque) e sem travar |
| 18 | **Só se for retirar o aparelho do serviço:** painel → Desativar gerenciamento (pede senha). | Fica "desativação pendente" até o aparelho confirmar e depois "desativado". Anote se o aparelho voltou ao uso normal ou se pediu restauração |

**Critério final:** o modelo é **homologado** se os itens 2 a 15 forem aprovados, junto com o 16 e o 17 quando aplicáveis. Qualquer reprovação: mande a foto, o horário e o modelo.

## O que devolver para nós

- A tabela "Anote para cada aparelho" preenchida.
- Aprovado ou Reprovado em cada item, com fotos.
- Se algo falhar: o horário exato. Com o horário encontramos o evento no painel (Detalhes → Eventos).

## Recuperação, se algo der errado

- **Aparelho sem internet e preso no quiosque:** use um código de recuperação impresso (item 14).
- **Sem códigos:** reconecte à internet e abra a manutenção pelo painel.
- **Credencial revogada:** o tablet mostra a tela de reinscrição e continua protegido. Gere um código de inscrição novo no painel e digite-o.
- **Retirar de vez:** painel → Desativar gerenciamento (item 18). Se o aparelho foi perdido ou restaurado à mão, use "Registrar liberação local".

## Anexo: instalação de laboratório por cabo (aparelho de TESTE apenas)

Para quando ainda não há APK de produção publicado. **Nunca use em aparelho de cliente.**

1. Restaure o aparelho e, na configuração inicial, **não** adicione conta Google.
2. Ative Opções do desenvolvedor → Depuração USB.
3. No computador, com o arquivo `portaria-prime-kiosk-1.0.0-teste-debug.apk`:
   ```
   adb install portaria-prime-kiosk-1.0.0-teste-debug.apk
   adb shell dpm set-device-owner br.com.portariaprime.kiosk/.admin.KioskAdminReceiver
   ```
   Resposta esperada: `Success: Device owner set to package br.com.portariaprime.kiosk/...`
4. Abra o app, digite o código de inscrição gerado no painel e siga do passo 3 da tabela.
5. Para tirar: painel → Desativar gerenciamento, ou restauração de fábrica.

**Atenção:** o APK de teste é assinado com chave de *debug*. Para passar o aparelho para o APK de produção, é preciso restaurá-lo de fábrica de novo.
