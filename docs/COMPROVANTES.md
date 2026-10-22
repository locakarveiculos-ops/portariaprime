# Comprovantes de entrega (PDF)

## Configuração

**Configurações › Identidade e comprovantes** (administrador com permissão “settings”; porteiro e morador não veem nem alteram — validado no banco por `save_receipt_layout`).

- Logo: PNG, JPEG ou WebP até 5 MB. O navegador redesenha a imagem no canvas (arquivo que não é imagem real falha; EXIF removido; transparência e proporção preservadas) e o Storage limita tipo e tamanho. SVG não é aceito. Cada envio gera arquivo novo; o anterior não é apagado (histórico).
- Modelos: **Clássico** (linha de destaque, tabela zebrada), **Moderno** (faixa na cor primária com logo em caixa branca), **Compacto** (fonte menor, linhas finas).
- Cores primária/destaque (alerta de contraste), posição (esquerda/centro/direita) e tamanho do logo, título (80), mensagem (300), rodapé (200), endereço, contato e CNPJ/CPF cadastrado (opcional). Sem HTML/CSS livre.
- Prévia em PDF com dados fictícios (`/api/receipts/preview`): não grava, não envia.
- Cada salvamento incrementa `receipt_layouts.version` e gera `audit_logs` (`receipt_layout.saved`, antes/depois).

Vale para **novos** comprovantes: a retirada grava em `receipts.layout` o snapshot do layout e do caminho do logo vigentes.

## Emissão

1. `deliver_package` confirma a retirada (provas obrigatórias, idempotente) e cria o comprovante com snapshot — uma transação.
2. Push e central saem na hora. **E-mail e WhatsApp ficam `hold`** até o PDF existir.
3. Worker (`/api/jobs/tick`, chamado a cada minuto pelo `pg_cron`) reserva com lease (`claim_receipt_pdfs`), gera o PDF A4 com `pdf-lib`, grava em `tenant-receipts` (bucket privado, só `application/pdf`, 10 MB), registra sha256/tamanho/versão (`complete_receipt_pdf`) e libera os canais.
4. E-mail: Resend com o PDF anexado (`comprovante-entrega-PROTOCOLO.pdf`) e link autenticado. WhatsApp: Evolution v2 `POST /message/sendMedia/{instance}` com `mediatype: document`, base64 (contrato conferido no código-fonte da 2.3.7). Nenhuma URL do Storage é exposta.

Falha do PDF não desfaz a retirada; o app mostra “comprovante em processamento”. Após 5 falhas o síndico é alertado e pode **Gerar novamente** (mesmo snapshot). PDF pronto é imutável (trigger); reenvios usam o mesmo arquivo.

## Acesso

`/api/receipts/download` revalida no banco (`receipt_pdf_access`) a cada clique e devolve URL assinada nova de 5 min. Acesso: equipe do condomínio ou morador **ativo** da unidade cujo vínculo já existia na data da entrega (quem entrou depois não vê comprovantes antigos). Outro condomínio: negado.

## Testes

| Caso | Onde | Status |
|---|---|---|
| 3 modelos, logo horizontal/vertical/ausente, nome e rodapé longos, emoji fora da fonte, imagem inválida | `tests/api/receipt-pdf.test.mjs` + inspeção visual dos PDFs | testado |
| Permissão (porteiro, morador, outro condomínio), template inválido, auditoria | `tests/db/receipt-pdf.test.mjs` | testado |
| Retry da retirada = 1 comprovante; snapshot imutável após troca de layout | idem | testado |
| Canais retidos até o PDF; dois workers não geram duas vezes; conclusão única | idem | testado |
| Falha do PDF não desfaz retirada; alerta e reprocesso pelo síndico | idem | testado |
| Ocupante novo não acessa comprovante antigo | idem | testado |
| Worker grava PDF real e só conclui após upload | `tests/api/receipt-worker.test.mjs` | testado |
| Anexo Resend e documento Evolution (payload) | idem (provedores simulados) | testado |
| PDF gerado em produção para a retirada real de 22/10 (117 KB, assinatura e foto corretas) | produção | homologado |
| WhatsApp com PDF recebido no celular | produção | pendente de nova retirada de teste |
| E-mail com anexo | produção | bloqueado: Resend não configurado |
