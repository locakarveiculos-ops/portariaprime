# Comercial: catálogo, viabilidade e propostas

Migrations: `20261023000200_commercial.sql` (custos, simulação, preço em rascunho, política) e
`20261023000201_quotes.sql` (orçamentos, propostas, link público, outbox `quote_sent`).
Testes: `tests/db/commercial.test.mjs`, `tests/api/quote.test.mjs`.

## Catálogo e versões de preço

| Plano | Mensal | Unidades | Portarias | OCR/mês | WhatsApp/mês |
|---|---|---|---|---|---|
| Essencial | R$ 119 (R$ 99 até 20261029000200) | 80 | 1 | não incluso | não incluso |
| Profissional | R$ 169 (R$ 149 antes) | 400 | 2 | 600 | 1.500 |
| Prime | R$ 369 (R$ 349 antes); rascunho de R$ 249 pendente de revisão | 600 | 4 | 1.500 | 4.000 |

Tabela `20261029000200_kiosk_pilot_pricing.sql` (novas contratações): mensal + R$ 20 pelo Modo Portaria Exclusiva
(quiosque Android, acesso piloto, incluído em todos os planos); trimestral = 3 × mensal − 5% e anual = 12 × mensal − 15%,
arredondados para baixo ao real. Essencial 119/339/1.213; Profissional 169/481/1.723; Prime 369/1.051/3.763.
Limite técnico de 20 aparelhos ativos por condomínio (`mdm_device_create`); **não há limite por plano** (política comercial pendente).
| Sob medida / administradoras | por proposta | — | — | — | — |

- `plan_prices` continua sendo o catálogo (versões imutáveis, uma ativa por plano/ciclo).
- Preço novo nasce em `plan_price_drafts` (`draft` → `approved` → `active` | `discarded`). O Prime R$ 249/mês
  já está lá como **rascunho**: não publica sozinho.
- Ativar (`commercial_action('price_activate')`, capacidade `plan_price`) exige rascunho aprovado
  (`costs_manage`), viabilidade validada e preço ≥ piso no cenário **alto**. Cria nova versão em `plan_prices`.
- Vale só para **novos contratos**: assinaturas guardam `price_cents_snapshot` e limites em
  `app.tenant_plan_limits`; nada disso é alterado. Tudo é auditado em `audit_logs` (`commercial.*`).

## Custos (`commercial_costs`)

Chaves: `infra_monthly`, `storage_gb_month`, `pdf_unit`, `ocr_unit`, `whatsapp_unit`, `email_unit`
(centavos, aceitam frações), `payment_fee_pct`, `tax_pct`, `min_margin_pct` (%), `support_monthly`.
Cada valor exige fonte; guarda `updated_at`/`updated_by`. **Todos começam ausentes.**
Custo ausente nunca é zero: a simulação devolve `validated=false` e `missing=[...]`.

## Simulação (`commercial_viability(plan, scenario, amount_cents?, cycle?)`)

Cenários (`commercial_scenarios`, hipóteses a revisar com dado real):

| | Típico | Alto |
|---|---|---|
| Ocupação das unidades do plano | 60% | 100% |
| Encomendas por unidade/mês | 2 | 4 |
| Moradores avisados por encomenda | 4 | 4 |
| Avisos por encomenda | 2 (chegada e retirada) | 2 |
| Parcela por WhatsApp / e-mail | 50% / 50% | 100% / 100% |
| Encomendas com OCR | 70% | 100% |

Custo mensal = infra + suporte + armazenamento + PDF + OCR + WhatsApp + e-mail + taxa de pagamento + tributos.
Piso = `ceil(custos variáveis / (1 − taxa − tributos − margem mínima))`.

### Regra de franquia (o que consome)

- Cada mensagem **aceita pelo provedor, por destinatário**, consome 1 (4 moradores avisados = 4).
- Tentativas com falha, duplicatas (deduplicação do outbox) e envios desativados **não** consomem.
- O contador reinicia todo mês (período UTC `AAAA-MM`, tabela `usage_counters`).
- Esgotada a franquia, não há envio por WhatsApp/leitura de OCR, então a simulação limita o consumo à
  franquia (`whatsapp_capped=true`). E-mail e PDF não têm franquia.

## Política de cobertura (`quote_policy`)

- Desconto sugerido padrão: **5%** abaixo do orçamento elegível. Campanha pública: **desligada**.
- Ativar a campanha exige texto de critérios e exclusões (mín. 20 caracteres), no banco e na ação.
- "Cobrimos qualquer orçamento" **não** é texto padrão e não deve ser usado: a sugestão sempre respeita o piso.
- `quote_policy_public()` (anon) só revela desconto e critérios quando a campanha está ativa.

Sugestão (`quote_suggest`, interna): escolhe o menor plano que comporta unidades e portarias.
- Administradora ou vários condomínios, ou porte acima do catálogo → `needs_review` (sob medida).
- Sem orçamento → preço de catálogo. Orçamento vencido, ou sem anexo e sem validade → `needs_review`.
- Catálogo já ≥5% abaixo → `catalog`. Senão alvo = orçamento × 0,95 por mês; viabilidade não validada
  ou alvo abaixo do piso → `needs_review` com motivo; caso contrário `ok` com `suggested_cents`.
- Nunca é promessa: só a proposta enviada pelo responsável tem valor.

## Fluxo

1. Landing: `<QuoteForm />` → `POST /api/quote` (multipart). Honeypot `website`; 3 envios/IP/hora (hash do IP,
   no banco); anexo opcional PDF/JPEG/PNG detectado pelos **bytes**, ≤ 5 MB, enviado pelo backend ao bucket
   privado `quote-attachments` (`<quote_id>/<uuid>.<ext>`). Protocolo `PP-ORC-AAAAMMDD-XXXXXX`.
   Limitação: o corpo de função da Vercel aceita ~4,5 MB; acima disso a plataforma devolve 413.
2. Admin Master (`quotes`): lista, detalhe, histórico, sugestão; anexo por URL assinada de 120 s
   (`/api/commercial/attachment`, cada acesso fica no histórico).
3. `quote_manage`: assumir, nota, encerrar, criar rascunho de proposta (preço total por ciclo em centavos,
   validade 1–90 dias, condições; limites ajustáveis só no sob medida), retirar.
4. Envio (`/api/commercial/send_proposal` → `quote_proposal_send`): bloqueado sem viabilidade validada ou abaixo
   do piso. Congela `content` (jsonb canônico), grava `content_sha256`, protocolo `PP-PROP-…`, `valid_until`,
   e `token_hash` = sha256 do token opaco. Enfileira um e-mail `quote_sent` apenas para o e-mail da
   solicitação; o token fica no payload até o envio ser aceito e então é apagado.
   Proposta enviada é imutável (trigger); nova condição = nova versão.
5. Cliente abre `/proposta#<token>` (token no fragmento, fora de logs/Referer), vê condições e aceita
   (`proposal_accept`, verifica validade, não recalcula) → `/contratar?proposta=<token>`.
6. PDF (`/api/commercial/proposal_pdf`): identidade Portaria Prime, protocolo, validade, limites, condições e o
   aviso "Proposta sujeita às condições descritas; não constitui desconto aprovado até o envio pelo responsável".
   Rascunho sai marcado como RASCUNHO.

Histórico: `quote_events` é append-only (trigger). Nenhuma tabela comercial é legível por anon/authenticated;
tudo passa por RPC.

## Contrato `public.proposal_terms(p_token text) → jsonb`

Para a frente de contratos. Executável por anon, authenticated e service_role.

Retorno (condições congeladas no envio, nunca recalculadas):
`proposal_id, quote_id, protocol, version, status ('sent'|'accepted'), accepted, accepted_at, plan_id, plan_code,
plan_name, is_custom, cycle, amount_cents (total por ciclo), limits {max_units, max_concierges, ocr_monthly,
whatsapp_monthly, storage_mb, feature_ocr, feature_whatsapp, feature_totem, feature_reports_plus}, valid_until,
conditions, org_name, org_kind, units, condos_count, content_sha256`.

Erros: `P0002` token inválido/inexistente; `P0001` proposta vencida (enviada e `valid_until` ≤ agora) ou retirada.
Proposta aceita continua válida após o vencimento. Use sempre `amount_cents`/`limits` daqui, nunca do navegador.

## Ponte proposta → contrato → cobrança (`20261023000600_proposal_billing.sql`)

- `/api/billing/checkout` chama `public.prepare_proposal_billing(p_tenant)` (só `p_tenant`; nada de preço/plano/token
  do navegador). Sem contrato ativo de proposta, delega a `prepare_checkout` sem alteração (clientes de catálogo
  mantêm o mesmo contrato da API).
- Com contrato `active` (e-mail do representante verificado) de origem `proposal`: confere que plano, ciclo,
  valor, limites e validade do contrato são **idênticos** à proposta aceita e que o hash do conteúdo confere.
  Qualquer divergência bloqueia a cobrança (`P0001`). Aceite pendente de verificação não vincula nada.
- Primeiro checkout cria um preço **privado** (`plan_prices.active=false`, invisível no catálogo) e grava o vínculo
  imutável em `app.proposal_billing_terms` (contrato, proposta, preço, limites, hash). Uma proposta vincula a um único
  contrato/condomínio.
- O mês grátis e as demais regras de `prepare_checkout` (cancelada, janela de renovação) continuam valendo.
- O aceite e o pedido **não** mudam a assinatura: plano, preço e limites só mudam em `apply_verified_payment`
  (pagamento confirmado no provedor). A partir daí `app.entitlements` usa os limites congelados da proposta
  pelo preço efetivo; período anterior pago continua com os limites anteriores.
- Trigger `guard_proposal_order` em `billing_orders`: pedido com preço de proposta precisa ter valor, ciclo, plano,
  limites, proposta, contrato e hash iguais ao vínculo, em qualquer caminho de escrita.

## Retenção do anexo

`attachment_delete_after` = envio + 180 dias. Limpeza (não agendada ainda), chamável pelo worker com service role:

```ts
const { data } = await svc.rpc('quote_attachments_due', { p_limit: 50 });
for (const a of data || []) {
  const { error } = await svc.storage.from('quote-attachments').remove([a.path]);
  if (!error) await svc.rpc('quote_attachment_purged', { p_quote: a.id, p_path: a.path });
}
```

## Roteador comercial (`api/commercial/[action].ts`)

Última vaga de função da Vercel (12/12). Ações: `attachment`, `proposal_pdf`, `send_proposal`. Outras frentes
devem acrescentar ações aqui (arquivos `_x.ts`), não criar novas pastas em `api/`.
