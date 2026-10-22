# Avisos para todos os moradores da unidade

## Quem recebe

`app.enqueue_package_notifications`, na mesma transação do recebimento ou da entrega:

- Central interna (`notifications`) e push: cada morador com `unit_memberships` ativo e `tenant_memberships` morador ativo. Central não duplica em retry.
- E-mail e WhatsApp: contatos ativos da unidade (`resident_contacts`) com preferência ligada; o mesmo e-mail/telefone compartilhado recebe uma vez.
- WhatsApp só com recurso no plano e instância conectada no condomínio.

## Deduplicação

Índice único `notification_jobs (tenant_id, event, ref_id, recipient, channel)`. `ref_id` = encomenda; o par evento+encomenda é a versão (chegada e retirada são eventos distintos). `on conflict do nothing`.

## Revalidação e envio

Worker `api/jobs/tick.ts` (Vercel Cron diário + GitHub Actions agendado): `claim_notification_jobs` com lock, `notification_is_authorized` revalida vínculo e preferência **no envio** (morador revogado vira `disabled`), envia, `complete_notification_job` com backoff 1/4/16/64 min. Roda no servidor: fechar o navegador do porteiro não interrompe nada.

Status honestos: `accepted` (provedor aceitou), `delivered` (só com confirmação do provedor), `failed`, `disabled` (sem canal, sem autorização, sem inscrição).

## Conteúdo

- Push: título genérico e corpo discreto na tela bloqueada (sem nome, unidade, rastreio ou loja). Clique abre a URL do app (comprovante estável no caso de retirada) e reaproveita janela aberta.
- E-mail/WhatsApp: link do comprovante `/c/:slug/comprovante?p=<id>` (exige login e vínculo; não é público).

## Testes

`tests/db/totem.test.mjs`: 3 moradores da unidade recebem central + push + e-mail; morador de outra unidade não; retry não duplica; morador revogado não recebe. E2E local confirmou outbox `package_received` e `package_picked_up` com 3 e-mails e 3 push cada.

## Pendências externas (não homologado)

- `RESEND_API_KEY` e `RESEND_FROM_EMAIL` ausentes na Vercel: e-mails ficam `failed`/`disabled` até configurar com domínio verificado.
- `VITE_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` ausentes: botão de push não aparece e jobs ficam `disabled`.
- WhatsApp: parear instância Evolution por condomínio.
- Entrega real em iPhone/Android precisa de aparelho físico.
