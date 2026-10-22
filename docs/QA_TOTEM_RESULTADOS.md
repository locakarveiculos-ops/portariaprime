# QA do totem — resultados (22/10/2026)

Legenda: ✅ executado e passou · ⛔ bloqueado por insumo externo · ➖ fora do escopo entregue

## Execuções

| Comando | Ambiente | Resultado |
|---|---|---|
| `npm run typecheck` | — | ✅ |
| `npm run test:db` | PGlite + shim | ✅ 52/52 (inclui `totem.test.mjs`, 5) |
| `npm run test:api` | Node | ✅ 36/36 (inclui normalização do OCR) |
| `npm run build` | Vite + PWA | ✅ |
| `npm run test:pwa` | Edge headless | ✅ |
| `tests/e2e/supabase-real.test.mjs` | Supabase local real (Postgres 17, Auth, PostgREST, Storage) | ✅ 6/6 |
| `npm run test:totem` | Edge + Supabase local real | ✅ percurso completo |

## Requisito → código → teste → evidência

| # | Requisito | Código | Teste | Evidência |
|---|---|---|---|---|
| 1 | Totem só para equipe logada, 2 abas | `App.tsx` (`totem-equipe`), `PortariaPage({totem})` | `totem-flow.mjs` | `tests/evidence/totem-registrar.png` |
| 2 | Totem público segue restrito | `TotemPage.tsx` inalterado | testes existentes de dispositivo | — |
| 3 | OCR separa destinatário/remetente, rastreio/pedido/nota, evidências, alertas | `api/ocr/analyze-label.ts` | `tests/api/ocr.test.mjs` | — |
| 4 | Códigos `J`, `RJ2-2`, `LSP-105` não viram unidade | `normalizeLabel`, `match_recipient` | ocr.test, totem.test 1 | — |
| 5 | Correspondência no servidor, homônimo/conflito → revisão | `match_recipient` | totem.test 1 | — |
| 6 | Nunca cria morador/contato | `match_recipient` só lê | revisão de código | — |
| 7 | Foto repetida não duplica | `label_sha256` + índice parcial | totem.test 2 | — |
| 8 | Hierarquia portaria › estante › prateleira, capacidade, observação | colunas `rack/shelf/notes`, `ConfigPage` | totem.test 2/4 | comprovante mostra local |
| 9 | Sugestão de local livre; contingência por último | `storage_availability` | totem-flow | toast “em Portaria principal › Estante A › Prateleira 2” |
| 10 | Última vaga protegida | `pick_storage` `FOR UPDATE` | totem.test 2 | — |
| 11 | Guarda física confirmada | `receive_and_store` + checkbox | totem.test 2, totem-flow | `storage_confirmed_at` |
| 12 | Aviso a todos os moradores ativos da unidade | `enqueue_package_notifications` | totem.test 3, E2E real | outbox 3 e-mail + 3 push por evento |
| 13 | Outra unidade não recebe/vê | RLS + destinatários do banco | totem.test 3/4, E2E real | — |
| 14 | Dedup `(tenant, evento, versão, destinatário, canal)` | `notification_jobs_dedup_uq` | totem.test 3 | — |
| 15 | Revalida destinatário no envio; revogado não recebe | `notification_is_authorized`, guarda de insert | totem.test 5, `security-fixes` | — |
| 16 | Funciona com navegador fechado | outbox + cron | — | arquitetura (`NOTIFICACOES_UNIDADE.md`) |
| 17 | QR: consulta não consome; local atual | `lookup_pickup_token` | totem.test 4, E2E real, totem-flow | — |
| 18 | Assinatura + foto do item obrigatórias | `deliver_package`, `proof_ok` | totem.test 4, db.test, E2E real | `totem-comprovante-morador.png` |
| 19 | Provas do próprio operador, não reutilizadas | `proof_ok` (`owner = auth.uid()`) | db.test, E2E real | — |
| 20 | Confirmação atômica e idempotente | `deliver_package(p_request)` | totem.test 4, db.test, E2E real | mesmo protocolo no retry |
| 21 | Uma única entrega em concorrência | `FOR UPDATE` | E2E real (2 conexões) | — |
| 22 | Comprovante imutável, mesmo snapshot página/PDF | `receipts` append-only, `Receipt.tsx` | totem.test 4 | `totem-comprovante*.png` |
| 23 | Link estável autenticado | `/c/:slug/comprovante?p=` | totem-flow (login → comprovante) | `totem-comprovante-morador.png` |
| 24 | Histórico para todos os moradores da unidade | RLS `receipts_select` | totem.test 4, E2E real | — |
| 25 | Offline nunca confirma | `PickupModal.confirm` | revisão de código | — |
| 26 | Atualização do SW não recarrega durante captura | `capture.ts`, `PwaUpdate` | `test:pwa` (rascunho) | — |
| 27 | Manifest com `id` | `vite.config.ts` | build | — |
| 28 | Push discreto, click seguro | `sw.js` | revisão de código | — |
| 29 | Ajuda/tour atualizados | `help.ts`, `tours.ts` | `help-tours.test.mjs` | — |
| 30 | PDF assíncrono por job no servidor | — | — | ➖ ver `COMPROVANTES.md` |
| 31 | E-mail real | Resend | — | ⛔ `RESEND_*` ausentes |
| 32 | Push real iOS/Android | VAPID | — | ⛔ chaves VAPID e aparelhos |
| 33 | WhatsApp real | Evolution | — | ⛔ pareamento por condomínio |
| 34 | OCR nas duas fotos reais | — | — | ⛔ arquivos não recebidos |

## Percurso E2E demonstrado (`npm run test:totem`)

3 moradores na unidade A·12B e 1 na B·34. Porteiro registra no totem com foto, local sugerido “Portaria principal › Estante A › Prateleira 2” e guarda confirmada → os 3 recebem aviso, o 4º não → morador 2 gera QR → consulta repetida não consome → entrega com assinatura desenhada e foto do item → protocolo `PP-…` → os 3 veem comprovante e aviso de retirada; o 4º não → morador 3 abre o link estável no celular (390×844), passa pelo login e vê o comprovante com assinatura e foto.

Capturas ficam em `tests/evidence/` (ignorado pelo Git; dados sintéticos).
