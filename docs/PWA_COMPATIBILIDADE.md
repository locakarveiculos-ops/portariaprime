# PWA: compatibilidade

## Implementado

- Manifest (`vite.config.ts`): `id: '/'`, `start_url: '/app'`, `scope: '/'`, `display: standalone`, ícones 192/512 + maskable, `lang pt-BR`. `apple-touch-icon` 180 e `apple-mobile-web-app-title` em `index.html`.
- Service worker (`src/sw.js`, injectManifest): precache só de estáticos versionados; sem cache de API, Storage, QR ou dados pessoais.
- Push: VAPID; `push` mostra texto discreto; `notificationclick` abre URL do mesmo domínio e reaproveita janela aberta.
- Permissão de push só por gesto (botão “Ativar avisos”), nunca automática.
- iOS: push só em 16.4+, com o app instalado na tela de início. Fora disso a tela explica e os avisos seguem na central e por e-mail.
- Câmera: `getUserMedia` com câmera traseira e `playsInline`; sem permissão ou câmera, envio de arquivo (`capture="environment"`).
- Atualização: aviso explícito, nunca recarrega sozinha; bloqueada enquanto há entrega com assinatura/foto aberta.
- Offline: nenhuma transação é confirmada sem servidor.

## Verificado

| Item | Evidência |
|---|---|
| Build gera SW + manifest | `npm run build` |
| Atualização preserva rascunho até o clique | `npm run test:pwa` (Edge) |
| Câmera indisponível → arquivo | `tests/e2e/totem-flow.mjs` usa o envio de arquivo |
| Layout 390×844 (comprovante) e 1024 (totem) | capturas em `tests/evidence/totem-*.png` (fora do Git) |

## Não verificado (exige aparelho/credencial)

- Instalação e push em iPhone (Safari 16.4+) e Android (Chrome) reais.
- Push real: VAPID não configurado na Vercel.
- Câmera física em tablet de portaria.

Não afirmamos “100% em todos os dispositivos” com base em build e emulação.
