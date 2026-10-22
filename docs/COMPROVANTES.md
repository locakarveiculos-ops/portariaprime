# Comprovantes de retirada

## Registro

`receipts` é append-only (trigger bloqueia update/delete), um por encomenda. Criado dentro de `deliver_package` → `confirm_pickup`, na mesma transação da baixa. `snapshot`: rastreio, transportadora, unidade, datas do servidor, quem retirou, relação (morador/autorizado), local de retirada (portaria › estante › prateleira), operador, método (QR/manual + justificativa), caminhos da assinatura e da foto do item. Protocolo `PP-AAAAMMDD-XXXXXXXX`.

## Acesso

- Equipe: Portaria › Buscar › Comprovante.
- Moradores da unidade (todos os ativos): Minhas encomendas › Histórico, ou link estável `/c/:slug/comprovante?p=<packageId>` enviado nas mensagens. Exige login; RLS `receipts_select` libera só equipe ou membro ativo da unidade. Revogado perde acesso.
- Imagens: bucket privado `tenant-private`, URL assinada de 5 min gerada a cada abertura. Nunca bucket público, nunca URL assinada em mensagem.

## PDF

Página e PDF saem do **mesmo snapshot**: “Baixar PDF / imprimir” usa a impressão do navegador (“Salvar como PDF”), sem dependência nova.

Não implementado: PDF gerado no servidor por job assíncrono e anexado em e-mail/WhatsApp. Motivo: exigiria biblioteca de PDF no servidor e armazenamento de arquivo derivado; o link autenticado já entrega o mesmo conteúdo sem expor dados. Adicionar quando houver requisito de anexo (ex.: e-mail sem login).

## Testes

`tests/db/totem.test.mjs` (3 moradores veem o mesmo protocolo e a foto do item; outra unidade não; retry não cria segundo comprovante) e `tests/e2e/totem-flow.mjs` (morador abre o link, é levado ao login e volta ao comprovante com assinatura e foto).
