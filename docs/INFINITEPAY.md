# InfinitePay

Fonte oficial consultada em 19/10/2026: https://www.infinitepay.io/checkout-documentacao . HTML recuperado por HTTPS; nenhuma cobrança criada.

## Contrato observado

`POST https://api.checkout.infinitepay.io/links`

```json
{"handle":"INFINITETAG_SEM_CIFRAO","items":[{"quantity":1,"price":14900,"description":"Serviço"}],"order_nsu":"IDENTIFICADOR_DO_PEDIDO","redirect_url":"https://SEU_DOMINIO/checkout/retorno","webhook_url":"https://SEU_DOMINIO/api/webhooks/infinitepay"}
```

A página tem exemplo textual com `itens`, mas o payload gerado utiliza `items`. Valores em centavos. Conta recebedora global: `INFINITEPAY_HANDLE`. Campo exato da resposta de criação do link precisa de homologação; o adaptador atual aceita nomes candidatos e falha se não houver URL, sem simular sucesso.

`POST https://api.checkout.infinitepay.io/payment_check`

```json
{"handle":"INFINITETAG_SEM_CIFRAO","order_nsu":"PEDIDO","transaction_nsu":"TRANSACAO","slug":"FATURA"}
```

Resposta documentada: `success`, `paid`, `amount`, `paid_amount`, `installments`, `capture_method`.

Webhook documentado: `invoice_slug`, `order_nsu`, `transaction_nsu`, `amount`, `paid_amount`, `installments`, `capture_method`, `receipt_url`, `items`. A consulta usa `slug`, não `invoice_slug`.

A documentação recomenda resposta rápida, preferencialmente abaixo de um segundo; 200 indica recebimento e 400 solicita reenvio. Autenticação criptográfica do webhook não está documentada. O webhook é aviso não confiável: evento persistido e pagamento conferido separadamente no provedor.

## Não comprovado

- Recorrência automática via API pública: não implementada; usar renovação por link.
- Idempotência do endpoint de criação no provedor: não presumir que repetir `order_nsu` impede dois links. Timeout ambíguo requer revisão; implementação ainda precisa endurecer essa política.
- Valor-base deve corresponder ao pedido; `paid_amount` pode incluir encargos. Divergências exigem revisão.
- Estornos/contestações: sem endpoint fictício; revisão administrativa até contrato documentado.
- Testes atuais usam respostas simuladas explicitamente em `tests/api/billing.test.mjs`. Não houve homologação financeira.

## Homologação da conta recebedora (21/10/2026)

- Conta: InfiniteTag `marco-boggian`, CNPJ 59.760.458/0001-91 (dígitos verificadores válidos). O CNPJ não é enviado à API: a InfinitePay identifica a conta só pelo `handle`.
- `POST /links` com `handle=marco-boggian` respondeu **200** com `{"url":"https://checkout.infinitepay.io/marco-boggian?lenc=…"}`: checkout externo habilitado e campo de resposta confirmado (`url`). Foi criado **um** link de R$ 1,00 identificado como “Homologacao Portaria Prime - nao pagar”; não foi pago.
- Controle negativo: handle inexistente responde **404** `external_checkout_not_enabled`; o adaptador trata como falha não ambígua.
- `payment_check` para pedido inexistente: **200** `{"success":false}` (não confirma pagamento, como esperado).
- Pendente: um pagamento real de valor baixo autorizado pelo proprietário para confirmar webhook + `payment_check` com `paid=true` e o recibo.

## Configuração no servidor

Na Vercel (projeto `portariaprime`, ambiente Production): `INFINITEPAY_HANDLE=marco-boggian` e redeploy. Sem essa variável, `/api/billing/checkout` responde 503 com mensagem clara (nunca gera link falso).