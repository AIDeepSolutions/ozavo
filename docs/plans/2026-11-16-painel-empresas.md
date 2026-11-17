# Área de plataforma no painel: empresas e FinOps consolidado

Pedido do dono em 16/11/2026: o painel não tem onde ver nem criar empresas. Hoje uma empresa só
nasce por `POST /api/v1/tenants/provision` ou pelo webhook do Asaas
([`asaas-nativo.md`](../guides/asaas-nativo.md)). Complemento do mesmo dia: o painel administrativo
de FinOps da especificação (consolidado e por empresa).

## Quem vê

Só a organização que administra a instalação (`organizations.platform = true`), e nela só dono ou
administrador: o mesmo critério de `handle({ platform: true })` (`apps/panel/src/server/context.ts`),
já usado em `finops/plan` e `finops/consolidated`. A coluna `platform` só muda pelo papel de sistema
(migration `20261116T211700_platform_so_pelo_sistema.sql`).

## Entrega em dois PRs

### PR 1: empresas (`feat/painel-empresas`)

1. **Núcleo** (`packages/core/src/platform-tenants.ts`). Toda leitura entre empresas passa por
   `withSystem`, dentro do core, e cada função confere de novo, na mesma transação, que quem pede é
   a plataforma (`platform_only`). Nenhuma rota do painel chama `withSystem`, então a lista de
   exceções da cerca não cresce.
   - `listPlatformTenants`: nome, plano, status, origem, franquia usada e total do ciclo
     (`getPeriodUsage` com a organização da empresa), criação e convite de dono pendente.
   - `getPlatformTenant`: o mesmo, mais o resumo de FinOps do ciclo (`getFinopsSummary`) e os
     últimos eventos da organização.
   - `createTenantFromPanel`: pede razão social, nome fantasia e CNPJ (os dados societários da especificação, seção 4; os dois últimos opcionais, como na API) e chama `provisionTenant` e `setPlanSubscription` na mesma transação de
     sistema. Origem `panel`; a chave de idempotência é um identificador que a tela gera por
     formulário, então clicar duas vezes devolve a mesma empresa. Plano Personalizado contrata preço,
     franquia e canais informados. "Suspensa até o pagamento" grava o status na mesma transação.
   - `setPlatformTenantStatus` (suspender e reativar) e `renewOwnerInvite` (convite novo para quem
     ainda não aceitou; revoga o anterior).
   - Status mostrado: `cancelled` quando a assinatura do Asaas ligada à empresa foi cancelada; senão
     o `tenant_profiles.status` (`active` ou `suspended`). Não há migration: a coluna já existe e
     "cancelada" já é registrada pelo Asaas.
2. **Eventos**: `tenant_status_changed` e `tenant_owner_invite_renewed` entram no vocabulário
   fechado. Gravados na empresa (sem autor, porque o autor é de outra organização; o id dele vai no
   corpo) e na plataforma (com autor).
3. **API** (`/api/v1/platform/tenants`, `/[id]`, `/[id]/status`, `/[id]/owner-invite`), todas com
   `handle({ platform: true })` e corpo validado com zod.
4. **Tela**: item "Empresas" na lateral só para a plataforma; lista; formulário "Nova empresa" com
   o link de convite mostrado uma vez; detalhe com plano, franquia, custo do ciclo, suspender e
   reativar com confirmação nomeando a empresa, renovar convite e histórico.
5. **i18n** pt-BR, en, es em `apps/panel/src/i18n/*/platform-tenants.ts` e a chave `nav.tenants`.
6. **Testes**: unidade (status mostrado e entrada do formulário); banco no core (lista, criação,
   idempotência, suspensão, convite, recusa a quem não é plataforma); banco no painel (rotas, 403 para
   empresa cliente e para operador da plataforma, e acesso cruzado negado: uma empresa cliente não lê
   outra, nem por id).

### PR 2: FinOps da plataforma (`feat/painel-finops-plataforma`, empilhado no PR 1)

Tela "FinOps da plataforma" dentro da área de plataforma: por empresa, minutos do ciclo e franquia,
custo variável estimado, receita e margem, e os alertas críticos (franquia em 80% e 100%, disjuntor
de chamadas curtas). Reaproveita `getFinopsSummary` por empresa, via papel de sistema no core, com a
cotação e o custo de telefonia da plataforma quando a empresa não informou os dela (quem paga os
provedores é a plataforma). Totais consolidados no topo.

## Fora do escopo (pendências)

- **Entrar como suporte.** O repositório não tem mecanismo seguro e auditado de acesso de suporte
  (sessão temporária na empresa, consentimento, registro dos dois lados). Não será inventado aqui.
- **Mudar o plano de uma empresa pelo detalhe.** O detalhe mostra; a troca segue pelo Asaas ou pela
  API. Pode entrar depois, reaproveitando `setPlanSubscription`.
- Suspender uma empresa ligada ao Asaas vale até o próximo evento do Asaas, que recalcula o status
  pela cobrança. A tela avisa.

## Migrations

Nenhuma.
