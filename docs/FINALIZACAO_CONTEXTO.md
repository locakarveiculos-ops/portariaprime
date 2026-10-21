# Contexto da finalização

Verificado em 21/10/2026, antes de editar.

| Item | Valor observado | Como foi confirmado |
|---|---|---|
| Pasta | `J:\AREA DE TRABALHO\Projetos\Portaria Prime` | diretório de trabalho |
| Produto | Portaria Prime (multi-tenant; legado Village Azaleia em `supabase/legacy` e `docs/legado`) | `package.json` (`portaria-prime`), `src/`, migrations `20261019*` |
| Branch local | `feat/portaria-prime-saas` | `git rev-parse --abbrev-ref HEAD` |
| HEAD no início | `09063af` — fix: proteções de checkout, runtime local de API… | `git rev-parse HEAD`; commit criado nesta mesma linha de trabalho |
| Remoto de publicação | `https://github.com/locakarveiculos-ops/portariaprime.git` (`locakar`), `main` = `09063af` | `git ls-remote locakar main` |
| Remoto espelho | `https://github.com/codigobasejgs/portariaprime.git` (`portariaprime`), `main` = `0c2e62d` (atrasado) | `git ls-remote portariaprime main` |
| Remoto histórico | `origin` = `codigobasejgs/Villageazaleia` — não usar | `git remote -v` |
| Projeto Vercel | `portariaprime` (ID `prj_6huTig14jFrAJW0P2eUBbXBE87S4`, informado pelo proprietário) | variáveis gravadas nele em rodada anterior |
| Domínio | `https://portariaprime.vercel.app` | HTTP 200 via `curl`, `Server: Vercel` |
| Commit em produção | conteúdo de `09063af` | chunk `PortariaPage-C32QIL4c.js` publicado contém o texto novo da assinatura e não contém "MP 2.200" |
| Supabase de produção | projeto `zehijyqgqkouzhldeqio` (sem segredos aqui) | host embutido no bundle publicado |
| Supabase em `.env` | `jxfijaibczyzfomszrqg` — projeto do legado; **não usar** | `.env` local antigo |

## Por que "LocaKar" não é ambiguidade de produto

O repositório `locakarveiculos-ops/portariaprime` é de outra conta GitHub, mas contém este código (mesmos commits) e foi escolhido pelo proprietário como destino principal ("vamos manter nos dois", "commit e push somente neste: git push locakar feat/portaria-prime-saas:main"). O deploy da Vercel do domínio acima reflete o `main` desse repositório. Não é o produto LocaKar.

## Publicação

- Commit anterior (rollback do app): `09063af`. Reverter = `git revert <commit>` e push no mesmo destino; as migrations novas são aditivas e o app antigo funciona com elas.
- Migrations 0300, 0400 e 20261021000100 aplicadas em produção em 21/10/2026, a pedido do proprietário, via Management API com o token que ele forneceu; evento de teste do funil gravado e removido.
- Push: `6e6207b` em `locakarveiculos-ops/portariaprime` `main` (confirmado por `git ls-remote`).
- Deploy: a Vercel passou a servir a versão nova (`og:image` presente no HTML de `/`). Painel/logs da Vercel não consultáveis daqui (`api.vercel.com` dá timeout).
- Site verificado em 21/10/2026, somente leitura: `/` mostra a landing sem sessão (desktop 1440 e celular 390, sem rolagem horizontal, sem erro JS); `/entrar` 200; deep link `/c/.../portaria` com refresh leva ao login; `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest`, `/screens/*` 200; áreas privadas com `X-Robots-Tag: noindex`; `/api/jobs/tick` 401; `/api/funnel` 204. Planos aparecem como “em revisão” porque o catálogo de produção tem 0 planos publicados. Script: `tests/e2e/prod-smoke.mjs`.
- Não executado em produção: cadastro/trial de teste (exigiria criar conta real e enviar e-mail de confirmação) e compra.

## Limites de acesso deste ambiente

- `api.vercel.com` e `api.github.com` dão timeout no Node; `curl` alcança o domínio publicado. Status de build da Vercel não consultável daqui; verificação feita pelo conteúdo servido.
- A CLI Supabase logada não lista `zehijyqgqkouzhldeqio` (outra organização/conta). Aplicar migrations em produção exige o proprietário (`supabase db push` com a conta dona do projeto) ou um token novo. Os tokens colados no chat devem ser revogados e não são reutilizados.
- Docker indisponível. Stack local montada com PostgreSQL 18 instalado no Windows, PostgREST e Supabase Auth (binários oficiais) — ver `docs/STACK_LOCAL.md`.
