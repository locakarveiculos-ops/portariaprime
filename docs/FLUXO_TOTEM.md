# Totem da portaria (equipe logada)

Rota: `/c/:slug/totem-equipe` (menu “Totem da portaria”). Só porteiro e administrador ativos. Usa a sessão do operador (RLS), nunca service role. O totem público de entregadores (`/c/:slug/totem`, credencial de dispositivo) continua separado: só pré-registro, sem dados pessoais, sem retirada.

## Registrar encomenda

1. Foto da etiqueta (câmera `getUserMedia` com câmera traseira; alternativa: arquivo). Reencodada no navegador (sem EXIF). SHA-256 da foto original é calculado no cliente.
2. OCR opcional (`/api/ocr/analyze-label`): extrai campos separados e chama `match_recipient` no servidor com a sessão do operador. Ver `OCR_VALIDACAO.md`.
3. Unidade: só vem pré-selecionada quando o servidor responde `matched` ou `name_only`. `conflict`, `ambiguous`, `unit_only` e `not_found` exigem escolha manual.
4. Local: `storage_availability` lista portaria › estante › prateleira com vagas; sugere o de maior folga, contingência por último; local lotado aparece desabilitado.
5. Operador guarda e marca “Guardei fisicamente em …”.
6. `receive_and_store` (uma transação): valida local/lotação com bloqueio (`pick_storage`, `FOR UPDATE`), recusa foto repetida pendente (`label_sha256`), grava encomenda, `storage_confirmed_at`, evento `storage_confirmed`, e enfileira avisos para a unidade inteira. Idempotente por `p_idempotency_key`.
7. Foto da etiqueta sobe ao bucket privado e é vinculada (`attach_package_file`). Falha de upload não duplica a encomenda.

## Entregar ao morador

1. Morador mostra o QR (`issue_pickup_token`, uso único, hash no banco, renovar revoga o anterior).
2. Leitura chama `lookup_pickup_token`: **só consulta**, não consome. Mostra foto da etiqueta, unidade e o local **atual** (após `move_package`, aparece o novo).
3. Operador informa quem retira e a relação (morador / recebedor autorizado), coleta assinatura e **foto do item entregue** (obrigatória).
4. Uploads (assinatura PNG, foto JPEG) vão ao bucket privado no caminho da encomenda.
5. `deliver_package` (uma transação): bloqueia a encomenda, exige que assinatura e foto existam, sejam do próprio operador (`storage.objects.owner = auth.uid()`) e não tenham sido usadas; consome o QR; grava comprovante imutável; enfileira avisos. Idempotente por `p_request`: retry após queda devolve o mesmo protocolo.
6. Comprovante abre na tela; moradores da unidade veem no histórico e recebem link estável.

`confirm_pickup` deixou de ser chamável pelo cliente (`revoke execute ... from authenticated`); só `deliver_package` a usa.

## Offline e atualização

- Sem conexão, “Confirmar entrega” não envia e avisa. Nada é confirmado localmente.
- Erro após envio informa que nada foi confirmado e que repetir é seguro (mesma chave).
- Enquanto o modal de entrega está aberto, o aviso de nova versão fica bloqueado (`src/lib/capture.ts`).

## Testes

- `tests/db/totem.test.mjs` (PGlite): correspondência, última vaga, foto repetida, avisos para 3 moradores e não para a outra unidade, provas obrigatórias, idempotência, revogação.
- `tests/e2e/supabase-real.test.mjs` (Supabase local real): concorrência entre conexões, owner das provas, 3 moradores.
- `tests/e2e/totem-flow.mjs` (navegador Edge + Supabase local): percurso completo de UI.
