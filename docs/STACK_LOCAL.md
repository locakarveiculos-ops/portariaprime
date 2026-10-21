# Stack Supabase local (sem Docker)

Usada para E2E mutável, capturas e ensaio de restauração. Nunca aponta para produção (`tests/e2e/environment.mjs` só aceita loopback).

| Serviço | Origem | Porta |
|---|---|---|
| PostgreSQL 17.6 | binários portáteis EDB (`postgresql-17.6-1-windows-x64-binaries.zip`) | 54329 |
| Supabase Auth v2.197.0 | binário Linux oficial (`auth-v2.197.0-x86.tar.gz`) via WSL1 (`Debian`) | 54331 |
| PostgREST 12.2.3 | release oficial Windows + `libpq.dll` do pacote PostgreSQL | 54332 |
| Supabase Storage v1.x | código oficial (`supabase/storage`), Node 24, backend `file` | 54333 |
| Gateway (lugar do Kong) | `scripts/local-stack.mjs gateway` | 54321 |
| SMTP de captura | `scripts/local-stack.mjs smtp` grava `.eml` em `pp-stack/mailbox` | 54325 |

Tudo em `%LOCALAPPDATA%\pp-stack` (fora do Git).

## Subir

1. Baixar/extrair os binários acima em `%LOCALAPPDATA%\pp-stack` (`pg17/pgsql`, `auth/auth`, `artifacts/postgrest-windows-x64`, `storage` com `npm ci --ignore-scripts --force` e `node build.js`; `node_modules/fs-xattr/index.js` substituído por shim de arquivo `.xattr.json`, pois o Windows não tem xattr).
2. `node scripts/local-stack.mjs up` (gera `auth/run.sh`, segredo JWT e `.env.stack.local`).
3. Em outro terminal: `wsl -d Debian -- sh /mnt/c/Users/<usuário>/AppData/Local/pp-stack/auth/run.sh` (o `wsl.exe` não roda destacado).
4. `node scripts/dev-stack.mjs` → app em `http://127.0.0.1:3017`, API local em 3019.

## Usar

- `PP_E2E_ALLOW=1 node --env-file=.env.stack.local --test tests/e2e/supabase-real.test.mjs`
- `PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/journey.mjs`
- `PP_E2E_ALLOW=1 APP=http://127.0.0.1:3017 node --env-file=.env.stack.local tests/e2e/landing-tour.mjs`
- `node --env-file=.env.stack.local scripts/capture-screens.mjs`
- `BACKUP_PASSPHRASE=... node --env-file=.env.stack.local scripts/restore-drill.mjs` e depois `scripts/restore-drill-login.mjs`

## Diferenças em relação ao Supabase hospedado

- Sem Realtime (WebSocket): isolamento do Realtime não é exercitado aqui.
- Gateway mínimo: valida presença de `apikey`, libera health, links de verificação e URLs assinadas/públicas do Storage, como o Kong.
- E-mail do Auth vai para a caixa local; nenhum e-mail real é enviado.
