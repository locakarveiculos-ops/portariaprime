# Banco e restauração

## Dados antigos

O banco do Village Azaleia foi perdido. **Nenhum dado histórico foi recuperado ou importado.** O que existe é o schema reconstruído (migrations canônicas) e dados fictícios de demonstração/QA. O seed `supabase/seed/demo.sql` só roda com a flag `allow_demo_seed` e não cria senha padrão.

## Cadeia de migrations

`supabase/migrations/*.sql`, em ordem. Verificado em 21/10/2026:

| Ambiente | Situação |
|---|---|
| PGlite (testes unitários de banco) | todas aplicadas a cada `npm run test:db` |
| PostgreSQL 17 real + Supabase Auth/Storage/PostgREST oficiais (stack local, `docs/STACK_LOCAL.md`) | **16 de 16 aplicadas em banco novo**, cada uma em transação única (`psql -1`) |
| Supabase de produção `zehijyqgqkouzhldeqio` | **todas aplicadas** (as três últimas em 21/10/2026, cada uma em transação com registro em `supabase_migrations.schema_migrations`; definições anteriores das funções alteradas guardadas fora do Git para rollback) |

As três últimas são aditivas (revogam uma RPC de teste, endurecem uma atualização condicional, adicionam colunas com default e uma tabela nova). Próximas migrations, com a conta dona do projeto:

```
supabase link --project-ref zehijyqgqkouzhldeqio
supabase db push        # aplica só as que faltam
```

Verificado após aplicar: `funnel_events` existe e recebe eventos de `/api/funnel` em produção; anon não lê a tabela nem executa `funnel_summary`; `e2e_cleanup` desabilitada; guarda de checkout ativa.

## Backup e restauração física — ensaiado

`scripts/restore-drill.mjs` (stack local, 21/10/2026):

1. `pg_dump -Fc` dos schemas `public`, `auth`, `storage`, `app`, `extensions` + binários do Storage, empacotados e criptografados (AES-256-GCM, chave derivada por scrypt de `BACKUP_PASSPHRASE`). Saída em `%LOCALAPPDATA%\pp-stack\backups`, fora do Git.
2. Cluster PostgreSQL **novo** (porta 54339), papéis do Supabase recriados, `pg_restore` em transação única, objetos em pasta separada.
3. Verificação: contagens idênticas em 75 tabelas (822 linhas), nenhuma FK inválida, nenhum anexo sem objeto, checksums SHA-256 idênticos dos objetos.
4. `scripts/restore-drill-login.mjs`: Supabase Auth separado apontado para o banco restaurado; **login com a senha original funcionou** e senha errada foi recusada.

Achado do ensaio, já tratado no script: restaurar com `--no-owner` deixa as tabelas do `auth` com dono `postgres`; como elas têm RLS sem policies, o serviço Auth passa a ver **zero usuários** e ninguém entra, mesmo com os dados presentes. É preciso devolver a posse a `supabase_auth_admin` (e as do `storage` a `supabase_storage_admin`).

### Em produção (Supabase hospedado)

- Banco: `supabase db dump` (schema e dados) ou backups diários do plano; os hashes de senha estão em `auth.users` e voltam com o dump.
- Storage: baixar os buckets `tenant-private` e `tenant-public` (API do Storage com service role) e guardar com o dump, criptografado.
- Restaurar SEMPRE num projeto novo, conferir contagens/objetos/login e só então trocar o apontamento.
- Ainda não executado contra o projeto de produção (exige a conta dona do projeto; o token anterior foi exposto no chat e deve ser revogado).

`scripts/backup-prime.mjs`/`restore-prime.mjs` (lógicos, via API) continuam como alternativa sem acesso ao Postgres; não substituem o ensaio físico.

## Retenção e alerta

Pendente de configuração no ambiente do proprietário: agendar o dump diário (GitHub Actions com secret ou máquina do operador), reter 7 diários + 4 semanais + 3 mensais fora do repositório, e alertar falha pelo próprio job (e-mail do Actions). Sem isso, o critério "job verificável com alerta" não está fechado.

## Rollback

Nunca reset/drop no projeto existente. Reverter a versão do aplicativo é seguro com as migrations atuais (todas aditivas). Para rollback de dados, restaurar em projeto separado e migrar o apontamento, sem apagar transações novas.
