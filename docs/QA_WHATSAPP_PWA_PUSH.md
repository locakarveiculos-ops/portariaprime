# QA — WhatsApp, PWA e push (22/10/2026)

Legenda: **homologado** (produção, efeito real confirmado) · **testado** (teste automatizado/local) · **não testado** · **bloqueado externo**.

## Causa raiz do WhatsApp

A cadeia parava **na fila**. Encomendas e jobs eram gravados corretamente (`notification_jobs` com `status = queued`), mas nenhum worker consumia a fila.

| Etapa | Onde | Estado observado antes |
|---|---|---|
| Registro persistido | `device_receive` / `receive_and_store` | ok |
| Destinatários resolvidos | `app.enqueue_package_notifications` | ok (2 WhatsApp, 2 e-mail, 1 push) |
| Job por canal | `notification_jobs` | `queued`, 0 tentativas desde 12:54 |
| Worker | `api/jobs/tick.ts` | **nunca executado** |
| Evolution | `channels.ts` | não alcançado |

Por quê: o GitHub Actions (`tick.yml`) roda, mas sem os secrets `APP_URL`/`CRON_SECRET` termina com sucesso e o aviso “nada executado”; o cron da Vercel (plano Hobby) é diário. O `CRON_SECRET` antigo não era legível na Vercel.

Verificado e descartado como causa: chave e instância Evolution (instância `open`, chave do servidor válida), telefones (formato aceito), plano (WhatsApp incluído).

## Correção

- `CRON_SECRET` rotacionado na Vercel; o mesmo valor e a URL do app ficam no **Supabase Vault**.
- `pg_cron` + `pg_net` no Supabase chamam `/api/jobs/tick` **a cada minuto**, independente de navegador ou GitHub.
- Worker grava batimento (`worker_runs`), classifica erros e alerta o síndico quando a instância cai.

## Resultados

| Caso | Ambiente | Esperado | Observado | Status |
|---|---|---|---|---|
| Fila antiga processada | produção | WhatsApp aceito pela Evolution | 3 WhatsApp `accepted` (IDs `3EB0230D…`, `3EB0CD45…`, `3EB08C37…`) | homologado |
| Agendador sem ação manual | produção | worker chamado a cada minuto | `net._http_response` 200 em 18:40 e 18:41 | homologado |
| Retirada → WhatsApp automático | produção, unidade 12B/23 | aviso aos 2 contatos ativos | jobs 19:03:35, aceitos 19:04:07–09 (`3EB0786B…`, `3EB0E631…`), **34 s**; usuário confirmou recebimento no celular | homologado |
| Contato inativo não recebe | produção | só contatos ativos | contato inativo da unidade sem job | homologado |
| E-mail | produção | — | `disabled` (Resend não configurado) | bloqueado externo |
| Push | produção | — | `disabled` (nenhum aparelho inscrito ainda); VAPID configurado | não testado em aparelho |
| Número inválido = falha final sem retry, alerta ao síndico | PGlite | falha final, central + push do síndico, morador não vê | conforme | testado |
| Tempo esgotado após envio não repete sozinho | PGlite | job fora do `claim` | conforme | testado |
| Falha transitória reagenda com backoff + jitter | PGlite | `attempts` preservado | conforme | testado |
| Reenvio manual reaproveita o job | PGlite | mesma linha, sem nova encomenda | conforme | testado |
| Diagnóstico só para síndico, destinatário mascarado | PGlite | porteiro/morador negados | conforme | testado |
| Teste de WhatsApp: permissão, canal conectado, 1/2 min | PGlite | negado sem permissão/conexão; limite | conforme | testado |
| Push: mesmo navegador, outro usuário | PGlite | endpoint fica só com o novo usuário | conforme | testado |
| Push: endpoint fora da lista | PGlite | recusado | conforme | testado |
| 3 moradores da unidade, outra unidade não recebe | PGlite + Supabase local | — | conforme (`totem.test`, `supabase-real`) | testado |
| Atualização do app preserva formulário | Edge | — | `npm run test:pwa` PASS | testado |
| Build, tipos, 58 testes de banco, 38 de API | local | — | todos passaram | testado |

## Destinatários por perfil (implementado)

| Evento | Morador | Síndico/administrador |
|---|---|---|
| Encomenda recebida | central + push + e-mail/WhatsApp dos contatos ativos da unidade | — (sem cópia por pacote) |
| Encomenda retirada | idem, com link do comprovante | — |
| Falha final de aviso / WhatsApp desconectado | nada | central + push (no máximo 1 a cada 6 h), link para diagnóstico |
| Trial, cobrança | nada | e-mail aos administradores de faturamento |

Pendente (origem ainda não existe no sistema; não disparado de forma inventada): lembrete de encomenda parada, resumo diário ao síndico, aprovação de cadastro, estante lotada.

## Pendências externas

1. **Resend**: `RESEND_API_KEY` e `RESEND_FROM_EMAIL` (domínio verificado) na Vercel.
2. **Push em aparelho real**: instalar o app (iPhone iOS 16.4+ pela Tela de Início; Android pelo Chrome), abrir “Aplicativo e notificações” e ativar. Não homologado em iPhone/Android físico nesta execução.
3. **Confirmação de leitura do WhatsApp**: o sistema registra “aceito pelo provedor”; callbacks de entrega da Evolution não estão configurados.
4. **Rotação de credenciais** expostas em conversas anteriores (Evolution, Gemini, Vercel, Supabase).
