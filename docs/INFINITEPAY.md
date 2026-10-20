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
