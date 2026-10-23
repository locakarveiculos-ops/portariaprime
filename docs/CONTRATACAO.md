# Contratação eletrônica e documentos legais

## Estados (separados)

| Domínio | Onde | Estados |
|---|---|---|
| Contrato | `contract_acceptances.status` | `pending_verification` → `active` → `superseded` (aditivo) · situação derivada `contract_overview.state`: `none`, `active`, `ending`, `ended` |
| Pagamento | `billing_orders` / `payments` | inalterado; confirmado só por webhook/reconciliação (`apply_verified_payment`) |
| Serviço | `subscriptions` | inalterado; cancelamento reutiliza `cancel_subscription` (`cancel_at_period_end`) |

Aceite **não** é pagamento: não cria pedido, não muda assinatura, não ativa período. Se o plano aceito difere do da assinatura, a tela `/contratar` oferece a troca explícita via `change_plan` (no teste vale já; com período pago, no próximo ciclo).

## Mês de teste × contratação

- Teste: 1 mês de calendário, sem cartão (`provision_tenant`). O cadastro grava aceite de **termos e privacidade** (`record_trial_consent` → `consent_records`) com a versão publicada vigente, ou `minuta-nao-vigente` se ainda não houver publicação. Checkbox nunca pré-marcado.
- Contratar durante o teste não encurta o teste. `prepare_checkout` recusa cobrança antes de `trial_ends_at` ("A primeira cobrança só fica disponível depois disso") — logo **não é possível pagar antes** pelo sistema; o primeiro pedido nasce no `billing_tick` ao fim do teste.

## Fluxo `/contratar`

1. Escolha do condomínio (admins com `billing`).
2. `contract_quote` (RPC, sessão do usuário): termos calculados **no servidor** (catálogo publicado ou `proposal_terms(token)` quando existir — ausência é tratada via `to_regprocedure`), documento publicado vigente com `sha256`.
3. Contrato completo rolável; checkbox habilitado só após rolar até o fim, nunca pré-marcado.
4. `POST /api/billing/contract_accept` → `contract_accept` (service_role, `p_actor` = usuário validado no Auth). Exige `billing`, `accepted:true`, `document_sha256` igual ao publicado **no momento** (senão "O documento mudou…"). Preço recalculado; corpo com `amountCents`/`price` é rejeitado.
5. PDF gerado (pdf-lib) e gravado em `tenant-contracts/<tenant>/contracts/<aceite>/contrato-<versão>.pdf`; `complete_contract_pdf` grava sha256 e o torna imutável.
6. Verificação do e-mail do representante: código de 6 dígitos (hash SHA-256 com o id do aceite), 15 min, 5 tentativas, reenvio após 60 s, até 5 códigos. **Sem Resend configurado o código não é gerado nem enviado**: o aceite fica `pending_verification` e a UI explica. Nada é simulado.
7. Após verificar: `contract_copy` entra no outbox só para o e-mail do representante (regra `notification_allowed_ext` já existente), com o PDF anexado pelo worker (`api/jobs/tick.ts`). Reenvio (`contract_resend`) recoloca o mesmo job: mesmo PDF/hash.
8. Recibo + link do PDF + botão para Assinatura (pagamento pelo fluxo existente).

## Aditivo

Nova versão publicada com `material_change = true` faz `contract_overview.needs_new_acceptance = true`. Novo aceite vira `kind = 'aditivo'` com `previous_id`; o anterior só passa a `superseded` quando o aditivo é verificado.

## Cancelamento

`contract_cancel_preview` lista efeitos (sem nova cobrança, acesso até o fim do período liberado, depois leitura/exportação, retenção). `contract_cancel(p_confirm => true)` chama `cancel_subscription` e audita. Sem contato comercial.

## Evidências do aceite — finalidade e retenção

| Dado | Finalidade | Retenção |
|---|---|---|
| Data/hora do servidor, conta autenticada | provar quando e quem aceitou | PENDENTE DE DEFINIÇÃO (proposta: vigência + prazo prescricional) |
| IP (`x-forwarded-for` da borda Vercel) e user-agent (até 400 caracteres) | prova técnica de origem do aceite; segurança | PENDENTE DE DEFINIÇÃO |
| Versão e SHA-256 do texto exibido; SHA-256 do PDF | integridade do documento aceito | igual ao contrato |
| Nome, CPF (opcional), e-mail, telefone, cargo, poderes declarados | identificar o representante | igual ao contrato |

Registro append-only (trigger `contract_acceptance_guard`): só situação/PDF mudam; PDF pronto não é trocado; exclusão bloqueada (inclusive `on delete restrict` no condomínio). RLS: `select` só para admins do próprio condomínio; nada para anon. Admin Master vê evidências mascaradas (`platform_contract_acceptances`).

Texto do PDF: "Aceite eletrônico registrado em <data/hora do servidor> · hash SHA-256 do documento <…>". Não é assinatura ICP-Brasil; cita a MP 2.200-2/2001, art. 10, §2º, apenas como base de consulta, sem garantia automática de validade.

## Documentos legais (Admin Master)

- `legal_entity` (linha única, criada no primeiro salvamento): razão social, CNPJ, endereço, e-mail, canal de privacidade, encarregado, foro, representante, horário de suporte, meta de disponibilidade. **Nada é semeado.** `legal_entity_status()` lista pendências.
- `legal_documents`: `draft → review → approved → published` (→ `archived` ao publicar a próxima). Publicar exige dados legais completos, `approved` e nenhum `{{CAMPO}}`/`[PENDENTE…]`/`[A DEFINIR…]`/`[A VERIFICAR…]` após preencher os campos. Na publicação os `{{CAMPOS}}` são substituídos e o sha256 passa a ser o do texto final. Publicado é imutável.
- Capacidades: leitura `legal`, ações `legal_manage` (MFA quando configurado), auditoria em `audit_logs`.
- Minutas originais `0.1-rascunho`: `docs/legal/*.md`. `scripts/seed-legal-drafts.mjs` carrega como `draft` (só ambiente local ou com `ALLOW_LEGAL_DRAFT_SEED=1`).
- Páginas públicas `/contrato`, `/termos`, `/privacidade`: versão publicada ou minuta com faixa "Minuta em revisão — não vigente", sem dados da contratada.

## API (sem função nova na Vercel)

Ações no roteador `api/billing/[action].ts` (arquivo `_contract.ts`): `contract_accept`, `contract_verify`, `contract_code`, `contract_pdf`, `contract_resend`. Também registradas em `scripts/dev-api.mjs`.

## Depende de dado/ação externa

1. Dados legais reais da contratada (o CNPJ citado no site antigo **não** foi usado).
2. Revisão jurídica das minutas: prazos de retenção, aviso de reajuste/mudança, carência, incidente, exportação, limitação de responsabilidade, reembolso/arrependimento, transferência internacional dos suboperadores, horário de suporte e meta de disponibilidade.
3. Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`) para o código de verificação e a cópia do contrato.
4. `public.proposal_terms(text)` (frente comercial) para contratar por proposta; a aplicação do valor negociado à cobrança não é feita por esta frente.
