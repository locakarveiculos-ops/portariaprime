# Status de implementação — Portaria Prime

> **Atualização de 21/10/2026 — prevalece sobre o texto abaixo.** Stack Supabase local real (sem Docker) montada: migrations aplicadas em banco novo, E2E de API 6/6, jornada completa do síndico no navegador, restore físico com login, tour/ajuda completos, capturas reais e landing em `/`. Matriz atual: `FINALIZACAO_CHECKLIST.md`, `QA_FINAL.md`, `GATE_LANDING.md`. Continuam bloqueados por insumo externo: catálogo publicado, InfinitePay/Resend/Evolution/Gemini/VAPID, backup agendado e revisão jurídica.

Revisão em 20/10/2026. Especificação válida: versão 2 enviada pelo proprietário. O arquivo mestre local contém V1 histórica, com aviso de precedência. **Entrega integral ainda não aceita.**

## Evidências e limites

- Supabase configurado; migrations até `20261020000200` aplicadas anteriormente. Uma conta Auth real já existia.
- Seis cenários API/Auth/RLS/Storage passaram no Supabase remoto, inclusive retirada concorrente. Esses testes modificaram temporariamente catálogo e fixtures no projeto publicado; não devem ser repetidos ali.
- A limpeza antiga usava `session_replication_role=replica`: desabilitava também as FKs e cascatas. As contagens parciais verificadas depois NÃO provam ausência de resíduos. A migration `20261020000300_disable_test_cleanup.sql` desabilita essa RPC; por enquanto apenas local, não aplicada remotamente nesta revisão.
- Jornada no navegador passou por login, criação do condomínio/trial, marca, local e unidade; parou no convite porque o Vite não servia APIs. Não é E2E completo. Não usar capturas parciais como prova comercial.
- Runtime local dos handlers implementado em `scripts/dev-api.mjs`, porta 3019, com proxy do Vite. Sondas HTTP de 401/400/405/404 passaram. Não equivale a homologação completa da Vercel.
- Backup remoto foi exportado e restaurado em PGlite: 36 tabelas, 31 linhas, 1 identidade inventariada, nenhum objeto. Ensaio sintético adicional verifica contagens/checksums. Isso NÃO restaura binários no Storage real, senhas/sessões nem valida FKs durante toda a importação.
- Docker, Podman e psql não encontrados no PATH nesta rodada. E2E mutável agora aceita somente stack local de loopback; falta disponibilizar essa stack para concluir a jornada sem alterar produção.

## Matriz dos 15 critérios de aceite

| # | Critério | Situação / pendência |
|---|---|---|
| 1 | Migrations, seed e restore | Migrations e seed locais testados. Restore parcial PGlite; falta restore físico Storage/Auth/Postgres isolado completo. |
| 2 | Isolamento em todos os canais | Tabelas/RPC/Storage com testes; faltam Realtime, exportações e matriz CRUD integral em ambiente isolado. |
| 3 | Vínculos e revogação | Convites, escalada de papel e revogação testados. Revisar revogação de contatos sem usuário e alterações indiretas de vínculo. |
| 4 | Totem | Pareamento/revogação implementados. Falta sessão curta, limites persistentes e jornada física homologada. |
| 5 | Operação completa | API recebeu/retirou com arquivo sintético; navegador parou nos convites. OCR e canais não homologados. |
| 6 | Concorrência e QR | Retirada concorrente real passou; última vaga concorrente e QR renovado simultaneamente ainda precisam cobertura. |
| 7 | Ocupação e relatórios | Regras e testes locais presentes; validar relatórios paginados completos e filtros de datas. |
| 8 | Falhas e fila | Tratamento parcial; falta retomada real após queda de worker, prova de push remoto e canais. |
| 9 | Cobrança | Reserva persistente de criação de link e seis regressões corrigidas. Falta homologação InfinitePay e testar cancelamento durante criação externa. |
| 10 | Personalização isolada | Marca em áreas principais; faltam login do tenant, totem personalizado, contraste completo e alternância de usuários. |
| 11 | Build e runtime | Tipos/build locais; sondas públicas Vercel retornaram 401 JSON. Falta jornada autenticada nas APIs publicadas. |
| 12 | Jornada do síndico | Parcial; ainda não aceita. Confirmação de e-mail, convite, entrega e primeira cobrança devem ser concluídos em homologação. |
| 13 | Identidade integral | Kit reutilizado e legado removido. Auditoria visual completa em claro/escuro pendente. |
| 14 | Trial universal | Calendário, troca, cancelamento e idempotência testados; elegibilidade depende de documento informado, não de prova de vínculo/cadastro verificado. |
| 15 | Landing e screenshots | Gate fechado. Não implementados nem anunciados como entregues. |

## Lacunas de implementação independentes de credenciais

- Convites enviados por API diretamente, ainda sem outbox persistente de convite.
- Quota Storage e MIME real precisam garantia no servidor, não apenas re-encode no navegador.
- Sessão curta/revogável do totem e rate limiting persistente.
- Evidência de consentimento versionado ligada à conta/tenant; termos continuam minuta.
- Administração global: edição completa de franquias, tratamento auditado de ocorrências financeiras e configurações faltantes.
- Onboarding retomável como fluxo verificável, além do link para Configurações.
- Backup com snapshot/schema vivo, retenção automatizada, alertas e restore real seguro.
- Revisão das condições de corrida dos jobs e das mutações de configurações/limites.

## Dependências externas

Já configurados anteriormente: Supabase, domínio Vercel, variáveis públicas/servidor básicas e CRON_SECRET. Não solicitar novo projeto por engano: agora o projeto publicado tem dados Auth reais.

Pendentes de homologação: INFINITEPAY_HANDLE; RESEND_API_KEY/RESEND_FROM_EMAIL e SMTP Auth; EVOLUTION_API_URL/EVOLUTION_API_KEY; GEMINI_API_KEY/GEMINI_OCR_MODEL; VITE_VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT; scheduler frequente confirmado em apenas um repositório.

Nenhuma nova publicação ou cobrança nesta revisão. Não reutilizar os tokens pessoais expostos no chat para novos testes; revogá-los. Nenhum dado histórico foi importado.
