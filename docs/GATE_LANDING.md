# Gate da landing

Situação: **FECHADO** — revisão de 20/10/2026. A matriz atual e ressalvas estão em `IMPLEMENTACAO_STATUS.md`; não considerar os checkboxes abaixo como homologação integral.

Não iniciar landing comercial ou capturas promocionais antes de comprovar:

- [x] TypeScript frontend e backend (verificação local).
- [x] Build Vite e service worker.
- [x] Testes de banco em PGlite com shim mínimo do Supabase.
- [x] Testes de contrato InfinitePay com respostas simuladas somente na suíte.
- [x] Interface real de login/recuperação em 360, 390, 768, 1024 e 1440 px.
- [ ] Jornada autenticada nas APIs Vercel. Duas sondas sem autenticação passaram (401 JSON); runtime local também testado, mas isso não aprova a jornada inteira.
- [ ] Migrations em Supabase isolado real; Auth, RLS, Storage e Realtime entre dois tenants.
- [ ] Recebimento, OCR, upload, retirada, assinatura e comprovante ponta a ponta.
- [ ] Concorrência com conexões Postgres distintas.
- [ ] Homologação de pagamento InfinitePay e canais externos.
- [ ] Restore com contagens, Auth e objetos Storage.
- [ ] Revisão dos limites, consentimentos, políticas de retenção e segurança restantes.

A raiz direciona ao login/seletor de condomínio. Houve deploy e configuração remota em rodadas anteriores; não houve homologação financeira. Nenhuma nova publicação, cobrança ou envio real faz parte desta rodada de revisão. Build e testes locais não equivalem a produto pronto.
