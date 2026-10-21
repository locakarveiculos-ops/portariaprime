# Checklist de finalização

Estados: pendente · implementado · testado localmente · homologado · bloqueado externo. “Implementado” ≠ “homologado”. Revisão 21/10/2026.

| ID | Requisito | Arquivo/rota | Teste | Situação |
|---|---|---|---|---|
| F01 | Projeto/destino confirmados | `docs/FINALIZACAO_CONTEXTO.md` | conteúdo servido em produção | testado |
| F02 | Migrations reproduzíveis em banco novo | `supabase/migrations` | stack local 16/16 | testado localmente |
| F03 | Upgrade incremental em produção | idem | estado antes/depois via Management API | homologado (21/10/2026) |
| F04 | Seed só em dev/homologação, sem senha padrão | `supabase/seed/demo.sql` | flag obrigatória | testado localmente |
| F05 | Backup criptografado + restore físico + login | `scripts/restore-drill*.mjs` | ensaio completo | testado localmente |
| F06 | Backup agendado com retenção e alerta | — | — | pendente (ambiente do proprietário) |
| F07 | Multi-tenant, RLS, FKs compostas | migrations 0100–0400 | E2E 2, `db.test` | testado localmente |
| F08 | Convites, revogação imediata, permissões delegáveis | migrations 0500, 20261020000100 | E2E 3/5, `billing-authorization` | testado localmente |
| F09 | Totem com pareamento revogável | `api/totem`, `TotemPage` | PGlite | implementado (sem aparelho) |
| F10 | Operação completa de encomendas | `PortariaPage`, RPCs 0600 | `journey.mjs` | testado localmente |
| F11 | Concorrência de retirada | `confirm_pickup` | E2E 4 | testado localmente |
| F12 | Trial de um mês de calendário | `app.add_months`, `provision_tenant` | `db.test`, E2E 1 | testado localmente |
| F13 | Cobrança InfinitePay segura | `api/billing`, `api/webhooks` | suíte com mocks | testado localmente; **homologação bloqueada externo** |
| F14 | E-mail (Resend), WhatsApp (Evolution), OCR (Gemini), Web Push (VAPID) | `api/_lib/channels.ts`, `api/ocr` | contrato | implementado; homologação bloqueada externo |
| F15 | PWA com atualização segura | `PwaUpdate`, `sw.js` | `pwa-update.mjs` | testado localmente |
| F16 | Identidade e tokens globais × condomínio | `design/tokens.css`, `theme.ts` | capturas A/B | testado localmente |
| F17 | Tour por papel/módulo/tarefa | `src/lib/tours.ts`, `TourGuide.tsx` | `help-tours.test`, `landing-tour.mjs` | testado localmente |
| F18 | Central de ajuda pesquisável e contextual | `src/lib/help.ts`, `HelpPage.tsx` | idem | testado localmente |
| F19 | Suporte com formulário persistido e consultável | `api/contact.ts`, `AdminPage` | `landing-tour.mjs` | testado localmente |
| F20 | Capturas reais com manifesto e script | `scripts/capture-screens.mjs`, `public/screens` | executado | testado localmente |
| F21 | Landing em `/` | `src/pages/LandingPage.tsx` | `landing-tour.mjs`, Lighthouse | testado localmente; produção: ver contexto |
| F22 | Funil de conversão sem PII | `api/funnel.ts`, migration 20261021000100 | `funnel.test`, navegador, evento real em produção | homologado |
| F23 | SEO e privadas fora do índice | `index.html`, `robots.txt`, `sitemap.xml`, `vercel.json` | navegador | testado localmente |
| F24 | Catálogo publicado em produção | `/admin` | — | bloqueado externo (decisão comercial do superadmin) |
| F25 | Termos/privacidade revisados | `/termos`, `/privacidade` | — | pendente (revisão jurídica) |

## Matriz tours × papéis

| Tour | Síndico/admin | Porteiro | Morador | Requer |
|---|---|---|---|---|
| Primeiros passos do síndico | ✅ | — | — | — |
| Unidades e importação | ✅ | — | — | approve |
| Moradores, convites e aprovação | ✅ | — | — | approve |
| Equipe e permissões | ✅ | — | — | team |
| Receber uma encomenda | ✅ | ✅ | — | — |
| Entregar com QR, assinatura e comprovante | ✅ | ✅ | — | — |
| Mover, devolver e exceções | ✅ | ✅ | — | — |
| Painel e relatórios | ✅ | — | — | — |
| Identidade e configurações | ✅ | — | — | settings |
| Totem para entregadores | ✅ | — | — | settings (plano com totem; passo pulado sem o recurso) |
| Plano, mês grátis e pagamento | ✅ | — | — | billing |
| Minhas encomendas e QR | — | — | ✅ | — |

Superadmin não tem tour nem artigo público (área privada). Tours só destacam e explicam; nenhuma ação com efeito é executada pelo tutorial. Progresso por usuário/condomínio/versão no navegador (`ponytail`: mover para tabela se precisar valer entre aparelhos).

Artigos (20): primeiros passos, unidades/importação, moradores/convites, equipe, receber, entregar, comprovantes, exceções, armazenamento, relatórios, personalizar, totem, morador, notificações/instalação, plano/pagamento, segurança, câmera, sem internet, aviso não enviado, suporte. Formato: para quem, quando, pré-requisitos, passo a passo, captura real, resultado, como confirmar, problemas comuns, próximos passos, data/versão.
