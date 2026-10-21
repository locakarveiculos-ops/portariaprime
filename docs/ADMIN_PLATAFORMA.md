# Administração da plataforma (`/admin`)

Revisão: 21/10/2026.

## Acesso

- Proprietário: `portariaprime@gmail.com` (ID `fa8a1bc1-…`), promovido em produção em 21/10/2026, em transação, pelo ID da conta confirmada, sem alterar senha nem vínculos. Registro de auditoria `platform.owner_bootstrap` (origem: Management API, a pedido explícito do proprietário).
- Entrar em `https://portariaprime.vercel.app/entrar`, depois “Administrar plataforma” ou `/admin`. Se já estava logado antes da promoção, saia e entre de novo para recarregar o papel.
- A permissão vem do banco (`platform_admins`); nenhuma regra por e-mail existe no código.

## Papéis (matriz de capacidades)

| Capacidade | Proprietário | Suporte | Financeiro | Auditor |
|---|---|---|---|---|
| Ver condomínios, testes | ✅ | ✅ | ✅ | ✅ |
| Ver usuários | ✅ | ✅ | — | ✅ |
| Ver equipe global, auditoria | ✅ | — | — | ✅ |
| Ver notificações | ✅ | ✅ | — | ✅ |
| Ver pedidos, incidentes, planos | ✅ | — | ✅ | ✅ |
| Ver contatos/suporte | ✅ | ✅ | ✅ | ✅ |
| Estender teste, cortesia, trocar plano, resolver incidente | ✅ | — | ✅ | — |
| Suspender/reativar condomínio | ✅ | — | — | — |
| Revogar/reativar vínculo de usuário | ✅ | ✅ | — | — |
| Reenviar aviso com falha | ✅ | ✅ | — | — |
| Recuperação de senha (e-mail oficial do Supabase) | ✅ | ✅ (não para contas da equipe global) | — | — |
| Limites, publicação e preço de planos | ✅ | — | — | — |
| Equipe global (conceder/remover papéis) | ✅ | — | — | — |

Proteções no banco: ninguém altera o próprio papel; o último proprietário ativo não pode ser removido nem rebaixado; quem tem MFA verificado precisa de sessão `aal2` para ações que alteram dados.

## Regras comerciais

- **Teste**: um mês de calendário a partir da ativação (último dia do mês quando não existe o mesmo dia). Estender exige data final absoluta, posterior à atual e ao fim vigente; reativar teste expirado é uma escolha explícita. Pedido com tentativa de pagamento em andamento bloqueia a extensão até conciliar.
- **Cortesia**: período de acesso liberado sem pagamento; não marca pedido como pago, não conta como receita e não reinicia teste. Até 366 dias, sem sobreposição; pode ser revogada.
- **Período pago**: só existe após confirmação do pagamento pela InfinitePay (`payment_check`).
- **Suspensão** administrativa bloqueia o condomínio; **reativar** não concede assinatura paga nem ignora vencimento.
- **Troca de plano**: durante o teste, vale na hora; com assinatura paga, vale no próximo pagamento, sem pró-rata. Recusada se o uso atual excede o destino (nada é apagado).
- **Limites**: cada condomínio guarda um retrato dos limites do plano que contratou; mudar o catálogo não altera contratos existentes.

## Fora do escopo (honesto)

- Bloqueio global de conta (todas as sessões): não implementado; exige revisar todos os caminhos de Auth/RLS. Use “revogar vínculo” por condomínio.
- Exceções de limite por condomínio e migração explícita de limites para contratos antigos: não implementadas.
- Recriação automática de link de pagamento travado: não exposta; a função antiga só libera pedido aberto e ambíguo sem link, após conferência manual no painel da InfinitePay.
- Reenvio de aviso só para falha definitiva (5 tentativas), com confirmação manual, no máximo 3 reenvios e intervalo de 1 hora; timeout com entrega desconhecida não é reenviado.

## Migrations

`20261021000200_platform_admin.sql` e `20261021000300_platform_plan_change.sql`, aplicadas em produção em 21/10/2026 com cópia prévia de todas as funções `app`/`public` e da tabela `platform_admins` (fora do Git). Rollback: recriar as funções do arquivo salvo; colunas/tabelas novas são aditivas e podem permanecer.

## Testes

- PGlite: `tests/db/platform-admin.test.mjs` (8), `tests/db/platform-plan-change.test.mjs` (3).
- API: `tests/api/platform-users.test.mjs` (recuperação oficial, cooldown, sem token).
- Front: `tests/platform-frontend.test.mjs` (6).
- Stack real (Postgres 17 + Auth/PostgREST/Storage oficiais): `tests/e2e/platform.mjs` — papéis, negação para usuário comum e síndico, autoelevação, extensão de teste concorrente com a mesma solicitação, suspensão/reativação sem inventar pagamento, papéis globais sem acesso a encomendas, painel em 390/768/1440 px com refresh.
- Não testado com a sessão real do proprietário (não tivemos acesso a ela) nem a recuperação de senha com e-mail real.
