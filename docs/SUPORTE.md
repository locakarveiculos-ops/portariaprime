# Suporte com protocolo

Migration: `supabase/migrations/20261023000400_support.sql` · Teste: `tests/db/support.test.mjs`

## Quem abre e quem vê

| Ator | Pode |
|---|---|
| Admin do condomínio | abrir, ver **todos** os chamados do condomínio, responder, encerrar |
| Porteiro | abrir, ver/responder/encerrar **só os que abriu** (enquanto o vínculo estiver ativo) |
| Morador | nada; continua falando com a portaria (“Contato da portaria”) |
| Plataforma `support` | ler fila, detalhe (inclui notas internas), métricas |
| Plataforma `support_manage` | assumir, responder, nota interna, mudar situação e prioridade (inclui `urgente`), configurar atendimento |

Tabelas sem grant para clientes: tudo passa pelas RPCs `SECURITY DEFINER` com `search_path = ''`.

## Dados

- `support_tickets`: protocolo `SUP-AAAA-NNNNNN` (sequência por ano no fuso de São Paulo, em `app.support_protocol_seq`, atômica via `insert … on conflict do update`), condomínio, papel de quem abriu, tipo (`operacional|comercial`), assunto, tema, prioridade (`baixa|normal|alta`; `urgente` só pela plataforma), situação (`aberto|em_atendimento|aguardando_cliente|resolvido|encerrado`), contexto seguro (`ctx_route` só caminho, sem query/hash; `ctx_app_version` de `VITE_APP_VERSION`), timestamps `first_response_at`, `resolved_at`, `closed_at`.
- `support_messages`: append-only (trigger `app.block_mutation`), `internal` só para a equipe, corpo de 1 a 4000 caracteres.
- `support_settings`: linha única com horário, canais, prazo de 1ª resposta e `approved`. O prazo só é devolvido ao cliente com `approved = true`. Sem linha: a UI mostra “Horário de atendimento a definir”.
- Limite anti-abuso: 5 chamados por usuário por hora.

## RPCs

Cliente: `support_open(p_tenant, p_kind, p_subject, p_category, p_body, p_priority, p_route, p_app_version)`, `support_my_tickets(p_tenant)`, `support_ticket(p_ticket)`, `support_reply(p_ticket, p_body)`, `support_close(p_ticket)`, `support_settings_get()`.

Plataforma: `support_admin_list(p_status, p_priority, p_category, p_query, p_tenant, p_mine, p_page)` (`p_status = 'ativos'` exclui resolvidos/encerrados; 25 por página), `support_admin_ticket`, `support_admin_assign`, `support_admin_reply(p_ticket, p_body, p_internal)`, `support_admin_set(p_ticket, p_status, p_priority)`, `support_metrics(p_from, p_to)`, `support_settings_save(...)`.

## Fluxo de situação

- Abrir: `aberto`. Assumir: `em_atendimento`. Resposta pública da equipe: `aguardando_cliente` e grava `first_response_at` (uma vez).
- Resposta do cliente em `aguardando_cliente`/`resolvido` volta para `aberto` (e zera `resolved_at` se estava resolvido).
- `resolvido` grava `resolved_at`; `encerrado` grava `closed_at` e bloqueia novas mensagens do cliente.
- Nota interna não muda situação, não conta como resposta e não avisa ninguém.

## Avisos (outbox)

Resposta pública cria `support_reply` em e-mail (e-mail da conta) e push (user_id) **só para quem abriu**, com `ref_id = <ticket_id>:<id da mensagem>`, e só se ainda for equipe ativa do condomínio. A guarda do outbox (`20261023000120`) revalida no envio. `notification_context` foi estendido encadeando a versão anterior (renomeada para `app.notification_context_before_support`) e acrescenta só `support.protocol` e `support.ticket_id`. O template (`api/_lib/templates.ts`) não leva o conteúdo da conversa e reforça “Nunca pedimos sua senha”.

## Senhas

Não há bloqueio no servidor. A UI mostra aviso quando a mensagem parece conter senha (`senha:`/`password=`) e o texto do formulário pede para não enviar senhas.

## O que medir

| Indicador | Fonte | Observação |
|---|---|---|
| Chamados por tema | `support_metrics.by_category` / `by_kind` | Temas mais frequentes viram artigos de ajuda |
| Tempo real de 1ª resposta | `first_response_at - created_at` (mediana e média) | Horas corridas; `pending` = sem resposta ainda |
| Tempo real de resolução | `resolved_at - created_at` | Reabertura zera a resolução anterior |
| Fila atual | `support_metrics.backlog` | Por situação, fora resolvidos/encerrados |
| Falhas de envio do aviso | `notification_jobs` com `event='support_reply'` e `status='failed'` | Ver em Admin Master › Notificações |
| Ativação do suporte | condomínios com ≥ 1 chamado / condomínios ativos | Consulta manual em `support_tickets` |
| Desvio pela ajuda | chamados abertos depois de ver sugestões | Ainda não instrumentado (ver pendências) |

## Pendências

- Horário útil/feriados não entram no cálculo (horas corridas).
- Desvio pela ajuda (sugestão aceita sem abrir chamado) não é medido.
- `VITE_APP_VERSION` precisa ser definido no build para registrar a versão.
