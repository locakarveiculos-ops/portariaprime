# Chatbot do Morador no WhatsApp (botões, sem IA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O morador de um condomínio fala com o WhatsApp da IA daquele condomínio (`ppia-<condomínio>`) e usa, só por botões e listas, as mesmas funções do app do morador, consultando o banco, sem IA.

**Architecture:** O webhook Whaileys atual (`api/webhooks/_whaileys.ts`) já recebe as mensagens da instância do condomínio e hoje ignora quem não é equipe autorizada. Ele passa a encaminhar esses remetentes para um motor de conversa novo do morador (`api/_lib/resident-bot.ts`), que é puro (texto/botões/ids) e executa cada ação por RPCs `resident_bot_*` no banco. Essas RPCs agem COMO o morador (mesmo padrão `app.assistant_as`, fixando `request.jwt.claim.sub` na transação), então valem exatamente as regras do app (`app.is_unit_member`, `app.resident_units`). Identidade: celular do cadastro (`resident_contacts`/`access_requests`), ou e-mail + código de 6 dígitos enviado ao e-mail.

**Tech Stack:** Vercel Functions (TypeScript, Node 22), Supabase Postgres (PL/pgSQL, RLS), motor Whaileys (VM, sem alteração), testes `node:test` com PGlite (banco) e `tsx --test` (API).

## Global Constraints
- Produção: **nenhuma** instância Evolution ou Whaileys é reiniciada, desconectada ou reconfigurada. O motor Whaileys (`/opt/locakar-whaileys`) **não muda**. Não rodar `docker compose up --build` nesta entrega.
- Sem IA: o bot do morador nunca chama Gemini. Texto livre que não for comando conhecido devolve o menu.
- Toda escrita pelo morador usa as RPCs do app (`delivery_keyword_save_v2`, `delivery_keyword_cancel`, `resident_reject_package`, `issue_pickup_token`) executadas como o morador; nenhuma regra nova de permissão.
- Equipe autorizada no mesmo número continua indo para a IA (`assistant_resolve`) exatamente como hoje.
- Migrations estritamente aditivas; funções existentes só via `create or replace` com assinatura e grants iguais.
- QR de retirada: link de uso curto que abre o QR; nunca enviar o token cru como texto.
- Português do Brasil com acentos em todo texto ao usuário.
- Cada mensagem do bot repete as opções numeradas no texto (reserva quando o aparelho não mostra botões).
- **Mesmo chip da Evolution:** no Azaléia o número da IA (`ppia-304f1cc1…`, final 0336) é o mesmo chip dos avisos e das Conversas do síndico. O bot só **abre** atendimento quando o morador manda uma palavra de início (`menu`, `oi`, `olá`, `encomenda`, `encomendas`, `portaria`, `início`) ou toca um botão do bot; dentro do atendimento (30 min desde a última resposta do bot) trata cliques, números e o texto do passo atual; fora dele fica em silêncio. Assim a resposta do morador a um aviso ou à conversa do síndico nunca recebe mensagem automática.
- Comprovante de retirada: botão abre o link do comprovante no app (exige login do morador), sem gerar PDF no WhatsApp.

---

## File Structure
- `supabase/migrations/20261125000100_resident_bot.sql` — tabelas `resident_bot_sessions`, `resident_bot_codes`, `resident_bot_qr_links`; funções `app.resident_bot_as`, `public.resident_bot_resolve`, `public.resident_bot_email_start`, `public.resident_bot_email_verify`, `public.resident_bot_call`, `public.resident_bot_qr_open`; evento de e-mail `resident_bot_code` na fila.
- `api/_lib/resident-bot.ts` — motor de conversa (puro): menus, roteamento de cliques, textos.
- `api/webhooks/_whaileys.ts` — encaminha remetente que não é equipe para o bot do morador.
- `api/_lib/templates.ts` — template do e-mail com o código.
- `api/portal/[action].ts` — rota pública `qr` que troca o link curto pelo token (uma vez) para a página.
- `src/pages/QrRetiradaPage.tsx` + `src/App.tsx` — página `/qr?c=...` que mostra o QR.
- Testes: `tests/db/resident-bot.test.mjs`, `tests/api/resident-bot.test.mjs`.

---

### Task 1: Banco — identidade e ações do morador pelo WhatsApp
**Files:** Create `supabase/migrations/20261125000100_resident_bot.sql`; Test `tests/db/resident-bot.test.mjs`.

**Interfaces (Produces):**
- `public.resident_bot_resolve(p_tenant uuid, p_phone text) returns jsonb` → `{ status: 'linked'|'pending'|'unknown', links: [{ user_id, name, units:[{id, label}] }], portal: '/c/<slug>' }`. Casa o celular (11 dígitos, com/sem 55) com `resident_contacts.phone` ativo de morador ativo **ou** com a sessão já verificada por e-mail (`resident_bot_sessions`).
- `public.resident_bot_email_start(p_tenant uuid, p_phone text, p_email text) returns jsonb` → `{ sent: boolean }`. Sempre `{ sent: true }` para não revelar se o e-mail existe; só enfileira o código se o e-mail for de morador ativo do condomínio. Limite: 3 códigos por telefone/hora.
- `public.resident_bot_email_verify(p_tenant uuid, p_phone text, p_code text) returns jsonb` → `{ ok: boolean }`. Código de 6 dígitos, 10 min, 5 tentativas; ok grava a sessão (telefone → usuário, 90 dias).
- `public.resident_bot_call(p_tenant uuid, p_phone text, p_user uuid, p_action text, p_args jsonb) returns jsonb` → confere que o telefone pertence ao usuário (contato ou sessão), age como ele e chama: `home`→`resident_home`, `package`→`resident_package`, `history`→`resident_history`, `keywords`→`list_delivery_keywords`, `keyword_save`→`delivery_keyword_save_v2`, `keyword_cancel`→`delivery_keyword_cancel`, `reject`→`resident_reject_package`, `qr`→`issue_pickup_token` + grava link curto e devolve `{ link: '<código>' }`.
- `public.resident_bot_qr_open(p_code text) returns jsonb` → `{ token, expires_at, carrier, unit }` na primeira abertura; depois `{ used: true }`.

- [ ] Escrever `tests/db/resident-bot.test.mjs`: (a) celular de contato ativo → `linked` com a unidade certa; (b) celular desconhecido → `unknown` com `portal`; (c) e-mail errado/inexistente → `{sent:true}` sem job; e-mail certo → job `resident_bot_code` com o e-mail; 4º pedido na hora é recusado; (d) código errado 5x bloqueia; certo cria sessão e `resolve` passa a `linked`; (e) `resident_bot_call` com usuário que não é dono do telefone → erro `42501`; (f) `home` devolve só encomendas da unidade do morador (não de outra unidade nem de outro condomínio); (g) `keyword_save` cria palavra visível em `list_delivery_keywords` como staff (portaria/totem); (h) `reject` revoga QR; (i) `qr` gera link; `resident_bot_qr_open` entrega o token uma vez e depois `{used:true}`; link de encomenda já retirada não abre; (j) tabelas sem acesso para `authenticated`/`anon`; funções só `service_role`.
- [ ] Rodar `node --test tests/db/resident-bot.test.mjs` → FALHA (funções inexistentes).
- [ ] Implementar a migration.
- [ ] Rodar o teste → PASSA. Rodar `node --test tests/db/whatsapp-assistant.test.mjs` → continua PASSANDO.
- [ ] Commit `feat(bot): banco do atendimento ao morador pelo WhatsApp`.

### Task 2: Motor de conversa do morador (puro)
**Files:** Create `api/_lib/resident-bot.ts`; Test `tests/api/resident-bot.test.mjs`.

**Interfaces:**
- Consumes: RPCs da Task 1 via `svc.rpc(...)`; `numberedCard`, `parseIncoming` de `api/_lib/whatsapp-card.ts`.
- Produces: `export async function residentReply(svc: Svc, ctx: { tenantId: string; tenantName: string; phone: string; appUrl: string }, ev: Incoming, session: BotSession): Promise<{ card: Card; options: string[]; session: BotSession }>` e `export interface BotSession { user?: string; unit?: string; step?: 'email'|'code'|'kw_word'|'reject_note'; draft?: Record<string,string> }`.

Telas (ids): `m` menu · `w` aguardando retirada · `p:<id>` detalhe · `q:<id>` QR (link) · `r:<id>` recusar (lista de motivos `rr:<id>:wrong_unit|cancelled|other`) · `h` histórico · `k` palavras-chave (`kc:<id>` cancelar, `kn` nova) · `u` trocar unidade (`us:<id>`) · `a` meu cadastro · `e` entrar por e-mail.

- [ ] Testes: menu de vinculado; desconhecido recebe link de cadastro + botão "Já tenho cadastro (e-mail)"; fluxo e-mail→código; lista de aguardando com botões por encomenda; QR devolve link `${appUrl}/qr?c=`; palavra-chave pede só a palavra (texto) e confirma com botão; recusa com motivo; várias unidades pedem escolha; **sem atendimento aberto, texto qualquer ("obrigado", resposta a aviso) não recebe nada**; palavra de início abre o menu; atendimento expira após 30 min sem resposta do bot; dentro do atendimento, texto fora de passo devolve o menu (sem IA).
- [ ] Rodar → FALHA. Implementar. Rodar → PASSA. Commit `feat(bot): conversa do morador por botões`.

### Task 3: Webhook encaminha o morador; e-mail do código
**Files:** Modify `api/webhooks/_whaileys.ts`, `api/_lib/templates.ts`; Test `tests/api/resident-bot.test.mjs` (webhook ponta a ponta) e `tests/api/whatsapp-assistant.test.mjs` (regressão da equipe).

- [ ] Teste: na instância `ppia-*`, número da equipe → menu da IA (igual hoje); número de morador → menu do morador; desconhecido → convite para cadastro (antes: silêncio); número da plataforma (`portaria-prime`) mantém o comportamento atual.
- [ ] Implementar: quando `box.tenantId` existe e `assistant_resolve` não devolve vínculo, chamar `residentReply` com a sessão salva em `resident_bot_sessions` (passo de conversa). Template `resident_bot_code` (assunto "Código de acesso pelo WhatsApp — <condomínio>").
- [ ] Rodar suíte de API → PASSA. Commit `feat(bot): webhook atende o morador no WhatsApp do condomínio`.

### Task 4: Página do QR de retirada
**Files:** Create `src/pages/QrRetiradaPage.tsx`; Modify `src/App.tsx`, `api/portal/[action].ts`; Test em `tests/api/resident-bot.test.mjs`.

- [ ] Teste: `POST /api/portal/qr {c}` primeira vez devolve token; segunda `{used:true}`; código inválido 404; sem cache (`no-store`).
- [ ] Implementar rota e página (usa `QRCodeDisplay` de `src/components/VisualCodes.tsx`; mostra transportadora, unidade e validade; "use na portaria ou no totem").
- [ ] Rodar → PASSA. Commit `feat(bot): link do QR de retirada`.

### Task 5: Validação e publicação
- [ ] `npm run lint`, `npm run build`, `npm test` → tudo verde.
- [ ] Banco de produção: aplicar `20261125000100` numa transação com registro em `schema_migrations`; conferir grants.
- [ ] Push para `locakarveiculos-ops/portariaprime` (main), esperar deploy READY.
- [ ] Conferir que todas as instâncias que estavam `open` (Evolution e Whaileys) continuam `open`; nada reiniciado.
- [ ] Teste real com o celular do responsável, só leitura (menu e lista), sem gerar QR de encomenda de outra pessoa.
