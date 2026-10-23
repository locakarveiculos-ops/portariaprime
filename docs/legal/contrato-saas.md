---
kind: contrato_saas
version: 0.1-rascunho
summary: Contrato de uso do Portaria Prime por condomínios. Um mês de teste sem cartão; depois, cobrança por link a cada ciclo, sem débito automático. O condomínio pode cancelar sozinho pelo sistema; o acesso segue até o fim do período já liberado e os registros de entrega não são apagados por atraso de pagamento.
---

# Contrato de prestação de serviços Portaria Prime

> Minuta 0.1-rascunho para revisão jurídica. Não vigente até publicação no sistema.

## 1. Partes e poderes

1.1. **Contratada:** {{RAZAO_SOCIAL}}, CNPJ {{CNPJ}}, com endereço em {{ENDERECO}}, representada por {{REPRESENTANTE}}, contato {{EMAIL_CONTATO}}.

1.2. **Contratante:** o condomínio identificado no registro de aceite, pelo nome e CNPJ (ou CPF do responsável) informados no momento da contratação.

1.3. Quem aceita este contrato declara, sob sua responsabilidade, ter poderes para obrigar o condomínio (por exemplo, síndico eleito ou procurador) e informa nome, cargo e e-mail. A contratada pode solicitar o documento que comprova esses poderes.

## 2. Objeto e escopo

2.1. Licença de uso, por assinatura, do sistema Portaria Prime para registrar o recebimento, a guarda, o aviso e a retirada de encomendas no condomínio, com os recursos do plano contratado.

2.2. Não fazem parte do objeto: serviços de portaria, vigilância, guarda física de bens, transporte, seguro de encomendas ou responsabilidade por mercadorias.

2.3. Novos recursos podem ser incluídos; recursos do plano contratado não serão retirados durante o período já pago sem aviso prévio de {{PRAZO_AVISO_MUDANCA}} [PENDENTE DE DEFINIÇÃO].

## 3. Plano, limites e valores

3.1. Plano, ciclo (mensal, trimestral ou anual), valor e limites (unidades, portarias, leituras de etiqueta, mensagens de WhatsApp, armazenamento) são os exibidos e registrados no momento do aceite, calculados pelo servidor a partir do catálogo publicado ou de proposta comercial aceita.

3.2. Ao atingir um limite, o sistema avisa e pode bloquear apenas o recurso excedido; nenhum dado é apagado por isso.

## 4. Mês de teste

4.1. Cada condomínio tem direito a um único período de teste de um mês de calendário, contado da ativação, sem cadastro de cartão e sem cobrança.

4.2. Antes do fim do teste, o condomínio recebe lembretes por e-mail. Ao fim do teste, só há cobrança se o condomínio continuar com o serviço.

4.3. Contratar durante o teste não encurta o teste: a primeira cobrança só é gerada depois do término.

## 5. Duração e início da cobrança

5.1. O contrato vale por prazo indeterminado, renovando-se a cada ciclo pago.

5.2. Após o teste, a cobrança é feita por link de pagamento a cada ciclo. Não há débito automático nem cobrança recorrente em cartão.

5.3. O período pago começa na confirmação do pagamento pelo provedor (ou no fim do período vigente, em caso de renovação antecipada) e dura o ciclo contratado.

5.4. O aceite deste contrato não é pagamento e não ativa período pago.

## 6. Meios de pagamento

6.1. Os pagamentos são processados pela InfinitePay, pelos meios que o link de pagamento oferecer no momento (por exemplo, Pix ou cartão). Encargos de parcelamento, quando houver, são definidos pelo provedor.

6.2. O pagamento só é considerado confirmado quando o provedor o confirma ao servidor da contratada; tela de retorno ou comprovante enviado pelo cliente não bastam.

## 7. Atraso

7.1. Após o vencimento há carência de {{CARENCIA_DIAS}} [PENDENTE DE DEFINIÇÃO; o sistema usa 7 dias por padrão] com operação normal e avisos.

7.2. Depois da carência, o acesso fica restrito: novos recebimentos e recursos pagos são bloqueados; consulta, exportação e retirada de encomendas já guardadas continuam disponíveis.

7.3. O atraso não autoriza apagar histórico, comprovantes nem provas de entrega.

## 8. Reajustes e mudança de plano

8.1. Preços do catálogo podem mudar para novas contratações. Para quem já contratou, reajuste só vale a partir do ciclo seguinte e com aviso prévio de {{PRAZO_AVISO_REAJUSTE}} [PENDENTE DE DEFINIÇÃO]. Índice de reajuste: [A DEFINIR].

8.2. Durante o teste, a troca de plano vale na hora e não altera o fim do teste. Com período pago, a troca vale a partir do próximo ciclo, sem cobrança proporcional, desde que o uso atual caiba no novo plano.

8.3. Mudança material das condições deste contrato exige novo aceite (aditivo), ligado ao aceite anterior.

## 9. Suporte

9.1. Canal de suporte: {{EMAIL_CONTATO}}. Horário de atendimento: {{HORARIO_SUPORTE}}.

9.2. Prazos de resposta: [A DEFINIR].

## 10. Disponibilidade e manutenção

10.1. A contratada empenha esforços razoáveis para manter o sistema disponível. Meta de disponibilidade: {{DISPONIBILIDADE}}.

10.2. Manutenções programadas serão avisadas com antecedência sempre que possível. Falhas de internet, energia ou equipamentos do condomínio não são indisponibilidade do serviço.

## 11. Serviços de terceiros

11.1. O sistema depende de terceiros, cuja disponibilidade não é controlada pela contratada: Supabase (banco de dados, autenticação e arquivos), Vercel (hospedagem), Resend (e-mail), InfinitePay (pagamentos), Google Gemini (leitura de etiquetas por OCR, quando habilitada) e servidor de WhatsApp baseado em Evolution API.

11.2. O envio por WhatsApp usa integração não oficial (Evolution API), **não é a API oficial da Meta**, pode sofrer bloqueios ou instabilidade e não tem garantia de entrega. Avisos importantes também ficam no aplicativo.

11.3. Leitura por OCR é sugestão que exige conferência humana.

## 12. Responsabilidades do condomínio

12.1. Manter cadastro correto de unidades, moradores, equipe e contatos, e revogar acessos de quem deixar de ter vínculo.

12.2. Fornecer equipamentos, internet e energia, e orientar a equipe.

12.3. Conferir destinatário, unidade e identidade de quem retira; a assinatura desenhada na tela é registro operacional, não assinatura digital certificada.

12.4. Ter base legal para tratar os dados de moradores e informar a eles sobre o uso do sistema.

## 13. Proteção de dados

13.1. Nos dados operacionais (moradores, encomendas, fotos, assinaturas, registros de retirada), o condomínio é o controlador e a contratada atua como operadora, conforme o Anexo de Tratamento de Dados.

13.2. Nos dados do relacionamento comercial (cadastro do contratante, representante, cobrança, aceite), a contratada é controladora, conforme a Política de Privacidade.

13.3. Incidentes de segurança que possam afetar dados do condomínio serão comunicados ao condomínio pelo canal {{CANAL_PRIVACIDADE}}, em prazo de {{PRAZO_INCIDENTE}} [PENDENTE DE DEFINIÇÃO].

## 14. Acesso, exportação e encerramento

14.1. O condomínio pode cancelar a qualquer momento pelo próprio sistema, sem contato comercial. O cancelamento impede novas cobranças; o acesso completo continua até o fim do período já liberado.

14.2. Após o encerramento, o condomínio pode exportar seus dados por {{PRAZO_EXPORTACAO}} [PENDENTE DE DEFINIÇÃO]. Depois, os dados são eliminados ou anonimizados conforme os prazos de retenção do Anexo, salvo obrigação legal de guarda.

14.3. Valores pagos por ciclos iniciados não são reembolsados proporcionalmente, salvo previsão legal [A VERIFICAR com assessoria jurídica, inclusive direito de arrependimento quando aplicável].

## 15. Propriedade intelectual

15.1. O software, a marca Portaria Prime e a documentação pertencem à contratada. O condomínio mantém a titularidade dos seus dados e da sua marca usada no sistema.

## 16. Limitação de responsabilidade

16.1. Limite de responsabilidade e exclusões: [A DEFINIR com assessoria jurídica].

## 17. Comunicações

17.1. Comunicações são feitas pelo e-mail do representante e dos administradores com permissão de faturamento, e por avisos no sistema. Mudanças de contato devem ser atualizadas no sistema.

## 18. Aceite eletrônico

18.1. Este contrato é aceito eletronicamente. O registro guarda a versão e o hash SHA-256 do texto exibido, data e hora do servidor, conta autenticada, IP, navegador e os dados informados pelo representante. Não se trata de assinatura digital com certificado ICP-Brasil; as partes reconhecem esse meio de comprovação, com base de consulta na MP 2.200-2/2001, art. 10, §2º.

## 19. Solução de conflitos

19.1. As partes buscarão primeiro solução amigável pelos canais de suporte. Fica eleito o foro de {{FORO}}.
