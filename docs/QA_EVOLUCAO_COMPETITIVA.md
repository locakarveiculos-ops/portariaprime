# QA — evolução competitiva, contratação e landing (23/10/2026)

Ambiente: Windows 10, Edge headless (Playwright), stack Supabase local isolada
(`scripts/local-stack.mjs`), dados fictícios. Nenhum envio externo, nenhum pagamento real.

## Resultados

| Verificação | Resultado |
|---|---|
| `tsc --noEmit` (app e `tsconfig.api.json`) | sem erros |
| `npm run test:db` (PGlite, usuários comuns) | 74/74 |
| `npm run test:api` | 62/62 |
| `npm run build` | ok |
| e2e `landing-tour` (planos do banco, funil sem PII, contato persistido, zoom 200%) | ok |
| e2e `public-pages` (landing, tutoriais, legais em minuta, `/validar`, `/proposta`, rotas privadas, 11 tamanhos de tela) | ok |
| e2e `admin-ux`, `resident-app`, `totem-flow`, `journey` (regressão) | ok |
| Capturas (10) regeneradas e inspecionadas | ok: QR e código de verificação desfocados, dados `.invalid` |

## Corrigido durante o QA

- Migration `20261023000120_outbox_events.sql` quebrava com checkout CRLF (`autocrlf`):
  regex tolerante e `.gitattributes` com LF para `.sql/.ts/.tsx/.mjs`.
- O código de verificação do comprovante aparecia legível na captura: agora é desfocado,
  e o roteiro falha se o alvo do desfoque não existir.
- Os e2e `journey` e `landing-tour` não marcavam o novo aceite obrigatório de termos no
  onboarding, e a landing passou a ter dois formulários. Testes atualizados.
- O roteiro de capturas criava condomínios fora do prefixo `e2e`, e a guarda dos e2e passava
  a recusar a stack. Agora usa o prefixo.

## Não executado / limitações

- **Revalidação das fontes do concorrente:** sem acesso HTTPS externo nesta máquina.
  `docs/MATRIZ_COMPETITIVA.md` usa os dados de 23/10/2026 do pedido e indica isso.
- WhatsApp/e-mail/push reais: não disparados (sem destinatário autorizado nesta etapa; sem
  Resend). Integração WhatsApp foi homologada antes (`QA_WHATSAPP_PWA_PUSH.md`).
- Leitor de tela e navegação só por teclado em todas as telas: não automatizados além dos
  rótulos e foco verificados nos e2e.
- Lighthouse/desempenho: não medido.
- Pagamento InfinitePay real e webhook em produção: não exercitados.
- Aparelhos físicos (iOS/Android) para PWA/push: não testados nesta etapa.
- Modo lote do recebimento: sem e2e próprio.
