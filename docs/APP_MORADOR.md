# App do morador

Experiência própria do morador, separada do painel da equipe (`ResidentShell`).
Celular: barra inferior; tablet (≥ 768 px): trilho; desktop (≥ 1024 px): barra lateral recolhível.
Cabeçalho: logo e nome do condomínio, unidade (ou seletor, se houver mais de uma), ajuda contextual e sino.
O sino e o item "Notificações" usam a mesma contagem (`my_notifications.unread`).

## Rotas

| Rota | Tela |
|---|---|
| `/c/{slug}/inicio` | Início: resumo, encomendas aguardando (mais antigas primeiro), recentes |
| `/c/{slug}/encomenda?p={id}` | Detalhe: situação, QR, linha do tempo, comprovante |
| `/c/{slug}/historico` | Histórico com busca (transportadora, rastreio, nº) e filtros |
| `/c/{slug}/notificacoes` | Notificações com ação pelo estado atual da encomenda |
| `/c/{slug}/conta` | Perfil, unidade e contatos, notificações, instalar, ajuda, sair |
| `/c/{slug}/ajuda` | Ajuda do morador |

Rotas antigas redirecionadas (inclusive links de mensagens já enviadas):

| Antiga | Nova |
|---|---|
| `/morador` | `/inicio` |
| `/avisos` | `/notificacoes` |
| `/aplicativo` | `/conta#notificacoes` |
| `/comprovante?p={id}` | `/encomenda?p={id}` |
| `/painel`, `/portaria` (morador) | `/inicio` |

Sem sessão, links do morador levam ao login com a marca do portal e voltam ao destino.
Sem vínculo ativo, as rotas do morador mostram a situação do cadastro: pendente, recusado ou encerrado.
Novos avisos de chegada apontam para `/encomenda?p={id}`. Se a encomenda já foi retirada,
a tela mostra o comprovante, nunca um QR inválido.

## Onde foi parar cada função

| Antes | Agora |
|---|---|
| Minhas encomendas › Para retirar | Início (cartões com "Mostrar QR de retirada" e "Ver detalhes") |
| Histórico resumido em linhas | Histórico (busca, filtros, "Carregar mais") e Recentes no Início |
| Comprovante em modal | Detalhe › "Ver comprovante" (PDF original por URL temporária) |
| Ativar avisos no topo | Minha conta › Notificações (convite discreto só se não houver canal) |
| Quem recebe os avisos da unidade | Minha conta › Minha unidade |
| Avisos | Notificações |
| Aplicativo e notificações (tabela técnica) | Minha conta › Notificações + Instalar (diagnóstico recolhido) |
| E-mail e Sair na barra lateral | Minha conta |

## Servidor (migration `20261023000100_resident_app.sql`)

- `resident_home`, `resident_history`, `resident_package` e `resident_profile` exigem papel de morador ativo
  e limitam o acesso às unidades com vínculo ativo do usuário.
- Pré-registro nunca aparece para o morador. O local interno de guarda (estante, prateleira) também não é exposto.
- O comprovante segue a mesma regra do PDF: só vê quem já estava na unidade na emissão.
- A linha do tempo mostra só fatos registrados: chegada, guarda (quando separada), retirada e exceção.
  Não informa que um aviso foi entregue ou lido.
- Contatos: o morador lê e edita o próprio contato e os de familiares sem conta da unidade.
  Dos outros moradores, vê só o primeiro nome e quais canais estão ativos.
  Antes, a política RLS permitia ler e alterar o telefone e o e-mail deles.
- `my_access_request` devolve `revoked` quando o acesso foi aprovado e depois encerrado.
- `my_notifications` traz o estado atual da encomenda (`package_status`), revalidado a cada consulta.

## Notificações e instalação

- "Notificações ativadas" só aparece com permissão concedida **e** inscrição registrada para o usuário e o condomínio.
- Estados mostrados: ativar, ativadas, bloqueadas (com orientação), indisponível neste navegador e
  iPhone fora da Tela de Início.
- A permissão só é pedida depois do toque do morador. O diagnóstico técnico fica recolhido em "Precisa de ajuda?".
- Sair remove a inscrição de push deste aparelho e não afeta outros aparelhos.
  O service worker continua sem cache de dados privados.
- Instalação: usa o prompt nativo quando existe; instruções para iPhone e para outros navegadores.
  Detecta o modo instalado e, quando não dá para saber, não afirma que o app não está instalado.

## QR

- O token fica só em memória e a validade vem do servidor. "Gerar novo código" revoga o anterior.
- Com o QR aberto, a tela confere a encomenda pelo Realtime e a cada 5 s. Se outra pessoa retirar, o QR some.
- Sem conexão, a tela informa que não foi possível confirmar se o código ainda vale.
- O texto deixa claro que a retirada só termina com a confirmação da portaria.

## Testes

- `tests/db/resident-app.test.mjs`: isolamento entre unidades e condomínios, papel, pré-registro, ordem,
  campos expostos, retirada por outro morador, linha do tempo, comprovante em processamento,
  morador que entrou depois, busca por identificador, contatos minimizados e protegidos,
  familiar sem conta, revogação e `revoked`.
- `tests/e2e/resident-app.mjs` (stack local, dados sintéticos):
  - Início vazio e com duas encomendas, QR legível, retirada simultânea fechando o QR.
  - Detalhe e comprovante em processamento e pronto, histórico com busca e filtros.
  - Notificação antiga com estado atual, leitura individual, conta com contatos minimizados.
  - Links antigos, encomenda inexistente, pendente e encerrado.
  - Negação por API e storage, sair.
  - Larguras 320, 360, 390, 430, 768, 820, 1024, 1280, 1440 e 1920, mais 844×390 em paisagem:
    sem rolagem horizontal e sem conteúdo encoberto pela barra.
- Regressão: `journey.mjs`, `totem-flow.mjs` e `admin-ux.mjs` passam.

## Limitações conhecidas

- Push, instalação e câmera foram testados só em navegador emulado (Edge headless), não em aparelhos físicos.
- A stack local não tem Realtime. A atualização automática foi testada pelo fallback de consulta periódica.
- Zoom de 200% e leitor de tela não foram automatizados. Os rótulos acessíveis e o foco seguem os componentes compartilhados.
- Não há troca de e-mail nem edição da unidade pelo morador; as duas continuam pela administração.
