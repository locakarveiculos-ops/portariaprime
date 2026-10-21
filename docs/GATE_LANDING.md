# Gate da landing

Revisão de 21/10/2026. Separado em dois gates para evitar dependência circular.

## GATE_PRODUTO — condição para construir e ativar a landing

| Requisito | Caso / comando | Resultado | Evidência |
|---|---|---|---|
| Migrations em banco novo real | `node scripts/local-stack.mjs up` (PG 17 + Auth/Storage/PostgREST oficiais) | ✅ 16/16 | log do comando |
| Isolamento A/B (tabelas, RPC, Storage, mesmo bloco/unidade) | `tests/e2e/supabase-real.test.mjs` na stack local | ✅ 6/6 | saída do teste |
| Auth, convites, revogação imediata | idem | ✅ | idem |
| Recebimento → QR → retirada concorrente → comprovante | idem + `tests/e2e/journey.mjs` | ✅ | `tests/evidence/journey-*.png` |
| Jornada do síndico no navegador (cadastro → trial → marca → local → unidade → convites → receber → QR → entregar → comprovante → painel → assinatura) | `tests/e2e/journey.mjs` | ✅ PASS | saída do teste |
| Trial de um mês, cobrança e regras de pagamento | `npm run test:db` (PGlite) + E2E | ✅ lógica; ⛔ InfinitePay real | `docs/QA_FINAL.md` |
| Backup e restore | `scripts/restore-drill.mjs` + `restore-drill-login.mjs` | ✅ físico + login | `docs/BANCO_E_RESTAURACAO.md` |
| Tour e ajuda | `tests/help-tours.test.mjs`, `tests/e2e/landing-tour.mjs` | ✅ | saída dos testes |
| PWA atualização segura | `tests/pwa-update.mjs` | ✅ | saída |
| Ausência de P0/P1 abertos | `docs/QA_FINAL.md` | ✅ nenhum P0/P1 aberto no que foi testado | — |

Integrações não homologadas (InfinitePay real, Resend, Evolution, Gemini, Web Push com VAPID real) **não são anunciadas como entregues** na landing: o texto fala em “canais configurados”, “quando o plano incluir” e “pagamento por link”, sem prometer entrega. Por isso não bloqueiam a ativação.

**GATE_PRODUTO: aprovado para a landing**, com as ressalvas acima.

## GATE_LANCAMENTO — condição para divulgar e vender

| Requisito | Situação |
|---|---|
| Landing ativa em `/`, deep links e `/entrar` preservados | ver `docs/QA_FINAL.md` (verificação de produção) |
| Catálogo publicado em produção | ⛔ **0 planos publicados** no banco de produção; a landing mostra “planos em revisão” até o superadmin publicar em `/admin` |
| Migrations 0300, 0400 e 20261021000100 em produção | ⛔ pendente (conta dona do projeto) |
| `INFINITEPAY_HANDLE` + primeiro pagamento homologado | ⛔ pendente |
| Resend/SMTP para e-mails de cadastro e convite | ⛔ pendente; sem isso a confirmação de e-mail depende do SMTP padrão do Supabase (limitado) |
| Termos e privacidade revisados juridicamente | ⛔ minuta |
| Contato comercial real (e-mail/WhatsApp) | formulário próprio ativo; nenhum número/e-mail inventado |
