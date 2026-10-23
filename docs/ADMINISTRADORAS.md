# Administradoras (organizações) com carteira

Migration: `supabase/migrations/20261023000410_organizations.sql` · Teste: `tests/db/organizations.test.mjs`

## Modelo

- `organizations` (nome, documento opcional, `active|suspended`).
- `organization_members` (`org_admin|org_viewer`, `active|revoked`, `invited_by`). Papéis próprios; **não** reutiliza `platform_admins`.
- `organization_invitations`: token aleatório devolvido uma vez, banco guarda só `sha256`; 7 dias; uso único; preso ao e-mail; revogado se quem convidou deixar de ser `org_admin`; novo convite para o mesmo e-mail revoga o anterior.
- `organization_tenants`: vínculo explícito org↔condomínio. Nasce `pending`; só vira `active` quando um admin do condomínio com permissão `settings` aprova (`authorized_by`/`authorized_at` obrigatórios no estado ativo). A plataforma (`organizations_manage`) pode criar ativo com justificativa auditada (`source = 'platform'`). Síndico vê e revoga qualquer vínculo; revogação vale na próxima chamada.

Sem grant de tabela para clientes; tudo por RPC.

## Autorização

- `app.org_can_view(tenant)`: membro ativo de organização ativa com vínculo ativo para o condomínio.
- `app.org_can_view_via(org, tenant)`: o mesmo, restrito à organização pedida (evita misturar carteiras).
- `public.dashboard_operation` **mantém** `app.require(app.is_admin(p_tenant))` e agora delega a `app.dashboard_operation_core` (mesma lógica, sem checagem, sem grant para `authenticated`). A administradora nunca chama `dashboard_operation`.
- Porteiro e morador do condomínio não ganham nada; não leem nem decidem vínculos.

## RPCs

Administradora: `org_create`, `my_orgs`, `org_detail`, `org_portfolio(p_org)`, `org_tenant_overview(p_org, p_tenant)`, `org_invite`, `org_invitation_preview` (anon), `org_accept_invitation`, `org_revoke_invitation`, `org_set_member_status` (protege o último `org_admin`; revogar membro revoga convites pendentes dele), `org_request_link(p_org, p_slug)`, `org_end_link`.

Condomínio: `tenant_org_links(p_tenant)`, `tenant_org_decide(p_link, 'approve'|'reject'|'revoke')`.

Plataforma: `org_platform_list` (`organizations`), `org_platform_link`, `org_platform_end_link`, `org_platform_set_status` (`organizations_manage`, justificativa ≥ 10 caracteres, auditoria).

## O que a carteira mostra (somente agregados)

Por condomínio: aguardando agora, acima de 72 h, recebidas/retiradas hoje, ocupação (usado/capacidade), sem local, falhas finais de aviso, falhas de comprovante, cadastros pendentes, locais próximos da lotação, situação comercial (`full|grace|restricted`). Drill-down acrescenta locais (código/capacidade/uso), pré-registros e unidades ativas. **Nunca**: lista de encomendas, unidades, moradores, transportadora, rastreio, fotos, assinaturas ou e-mails.

## O que medir

| Indicador | Como |
|---|---|
| Ativação | administradoras com ≥ 1 vínculo ativo / administradoras criadas; tempo entre `requested_at` e `authorized_at` |
| Taxa de aprovação | `active` vs `rejected` em `organization_tenants` |
| Retenção de vínculo | vínculos `revoked` por mês e quem revogou (`audit_logs`: `org.link_revoke`, `org.link_ended_by_org`, `platform.org_link_revoked`) |
| Falhas de envio | soma de `notification_failures` na carteira (o mesmo número da Visão geral do síndico) |
| Encomendas paradas | soma de `stale_now` (> 72 h) por carteira |
| Chamados por tema e tempo real de resposta | ver `docs/SUPORTE.md` |

## Pendências

- Convite gera link para envio manual (sem e-mail automático: não há vaga de função Vercel nem evento de outbox para isso).
- Administradora não abre chamado de suporte (o suporte é por condomínio).
- `org_portfolio` roda o núcleo do dashboard por condomínio; para carteiras grandes (> 100 condomínios) avaliar cache/materialização.
