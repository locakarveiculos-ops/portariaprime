# Matriz competitiva — gestão de encomendas em condomínios

**Data de referência das fontes:** 23/10/2026 (Brasil), conforme a pesquisa pública
registrada no pedido de trabalho.
**Revalidação nesta execução:** não foi possível. A máquina de desenvolvimento estava sem
acesso HTTPS externo durante o trabalho. Antes de qualquer uso comercial, reabra as fontes e
atualize a coluna "Documentado".

## Limites da análise

- As fontes são páginas públicas: homepage, guias, preços, contrato e privacidade.
  As áreas autenticadas dos dois produtos **não** foram auditadas.
- Material comercial não comprova funcionamento. "Não mencionado" não significa "ausente".
- Este arquivo é **interno**. A landing não publica comparação nominal. Ela apresenta
  benefícios próprios com evidência.
- Nenhum texto, marca, captura ou cláusula de terceiros foi copiado.

## Preço e condições

| Item | Documentado na fonte pública (23/10/2026) | Portaria Prime (catálogo) | Observação |
|---|---|---|---|
| Faixa até 300 unidades | R$ 199/mês ¹ | Profissional R$ 169/mês até 400 unidades (tabela 20261029000200; R$ 149 para contratos anteriores) | Diferença de R$ 30 (≈15,1%) **só na mensalidade**. Franquias e canais diferem: não é equivalência de cobertura. |
| Grande porte | R$ 299/mês ¹ | Prime: R$ 369 na tabela 20261029000200 (R$ 349 antes); o rascunho de R$ 249 não foi ativado e precisa ser revisto | Hoje o Prime é **mais caro** (≈23,4% acima). Não usar comparação de preço nessa faixa. |
| Administradoras | Oferta para até 20 condomínios ² | Sob proposta (carteira com vínculos explícitos) | Preço por carteira ≠ preço por condomínio. |
| Teste | 7 dias ¹ | 1 mês de calendário, sem cartão | Conferir no código: `provision_tenant` + `subscriptions.trial_*`. |
| Cancelamento | Aviso de 30 dias ¹ | Fim do período pago, sem fidelidade; ver minuta | A minuta contratual está pendente de revisão jurídica. |
| Mensagens/armazenamento | Anunciados como ilimitados ¹ | Franquias mensais explícitas por plano | Não prometer ilimitado. |

## Recursos

Legenda: **Documentado** = afirmado na fonte pública; **Validado PP** = coberto por teste
automatizado no repositório (ver `docs/MATRIZ_RECURSOS.md`).

| Recurso | Documentado (fonte) | Situação no Portaria Prime | Validado PP | Benefício que pode ser comunicado |
|---|---|---|---|---|
| Fotos no recebimento | Fotos múltiplas ³ | Ver `MATRIZ_RECURSOS.md` (galeria) | ver matriz | Prova visual do estado na chegada |
| QR na retirada | Sim ³ | QR de uso único validado no servidor, retirada atômica | `tests/db/totem.test.mjs`, e2e `totem-flow` | Sem retirada dupla nem código reaproveitado |
| Assinatura na retirada | Sim ³ | Assinatura + foto do item obrigatórias | `receipt-pdf.test.mjs`, e2e | Comprovante com assinatura e foto |
| PDF | Sim ³ | PDF de entrega com identidade, versão do layout e protocolo | `receipt-pdf.test.mjs` | Documento enviado ao morador |
| Leitura de etiqueta (OCR) | Sim (guia da portaria) ⁴ | OCR sugere campos; revisão humana obrigatória | `device-ocr`, e2e `totem-flow` | **Não** anunciar como diferencial exclusivo |
| Push | Sim (Firebase, na privacidade) ⁵ | Web Push por usuário e dispositivo | `notifications-ops.test.mjs` | **Não** anunciar como diferencial exclusivo |
| WhatsApp | Guia/privacidade descrevem abertura de mensagem pronta, sem API ⁴ ⁵ | Envio automático pelo provedor configurado (Evolution, **não** API oficial Meta), com fila, retry e estados | Homologado por destinatário de teste (QA_WHATSAPP_PWA_PUSH.md) | Aviso automático com fila e recuperação, sem depender da tela da portaria |
| Relatórios | Sim ³ | Visão geral com agregações no servidor + Relatórios/CSV | `dashboard.test.mjs`, e2e `admin-ux` | Indicadores com fórmula e fuso documentados |
| Contrato | Página pública com campos em branco ⁶ | Fluxo de aceite versionado com hash e PDF (ver `docs/CONTRATACAO.md`) | ver docs | Contratação transparente, versão aceita guardada |

A homepage fala em automação, mas o guia e a política descrevem um fluxo manual de WhatsApp.
Isso é uma **divergência documental**, não prova de falha do produto, e não deve ser usada
como ataque.

## Fontes

1. https://appcorrespondencia.com.br/guias/quanto-custa-sistema-de-correspondencia
2. https://appcorrespondencia.com.br/guias/correspondencia-para-administradoras
3. https://appcorrespondencia.com.br/
4. https://appcorrespondencia.com.br/guia/portaria.html
5. https://appcorrespondencia.com.br/privacidade
6. https://appcorrespondencia.com.br/contrato

## Regras para uso comercial

- Um recurso só vira argumento depois de **validado** no Portaria Prime (coluna "Validado PP").
- Toda comparação publicada mostra junto o escopo, as franquias e a data. Comparação nominal
  só com revisão e atualização prévias.
- Proibido: "menor preço do mercado", "segurança total", "exclusivo" sem evidência atual,
  depoimentos ou contagem de clientes inventados.
