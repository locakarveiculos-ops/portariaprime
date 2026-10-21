# Manifesto de capturas

Geradas por `scripts/capture-screens.mjs` em 2026-10-21, commit `09063af` (mais alterações locais da sessão), stack Supabase local isolada (`scripts/local-stack.mjs`), Edge headless, tema claro, movimento reduzido.
Todos os dados são fictícios (domínio `.invalid`). QR da tela do morador desfocado; assinatura é traço sintético; tokens pertencem apenas à stack local.

| Arquivo | Rota | Viewport | Cenário |
|---|---|---|---|
| `public/screens/recebimento-desktop.webp` | `/c/:slug/portaria` | 1440x900 | Recebimento preenchido manualmente, antes de salvar |
| `public/screens/comprovante-desktop.webp` | `/c/:slug/portaria (comprovante)` | 1440x900 | Comprovante após retirada real com assinatura sintética |
| `public/screens/portaria-mobile.webp` | `/c/:slug/portaria (Buscar)` | 390x844 | Portaria no celular: aguardando retirada |
| `public/screens/morador-mobile.webp` | `/c/:slug/morador (QR)` | 390x844 | Morador com QR de uso único (QR desfocado na captura) |
| `public/screens/painel-desktop.webp` | `/c/:slug/painel` | 1440x900 | Painel do síndico após 7 recebimentos e 1 retirada |
| `public/screens/armazenamento-desktop.webp` | `/c/:slug/painel (ocupação)` | 1440x900 | Ocupação dos locais de guarda |
| `public/screens/assinatura-desktop.webp` | `/c/:slug/assinatura` | 1440x900 | Mês grátis ativo com plano escolhido |
| `public/screens/marca-a-desktop.webp` | `/c/:slug/portaria` | 1440x900 | Condomínio A com marca azul |
| `public/screens/marca-b-desktop.webp` | `/c/:slug/portaria` | 1440x900 | Condomínio B com marca verde; dados separados de A |
| `public/screens/og.png` | derivada de painel-desktop | 1200x630 | Imagem Open Graph |

Recapturar: subir a stack local, `npm run dev:stack` e `node --env-file=.env.stack.local scripts/capture-screens.mjs`.
