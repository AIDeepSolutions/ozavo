# Ozavo: status

Atualizado em 17/11/2026, depois do merge da onda 2. Quem mantém o estado em dia é quem mexe: ao mergear um PR que muda
produção, atualize este arquivo no mesmo PR ou no seguinte.

## Estado atual

- **Produção:** o painel e as rotinas rodam no Coolify, publicados pela `main`. A `main` está em
  `b14556a` (PR #22). Em 17/11, às 19:06 UTC, os PRs #17, #18 e #19 foram mergeados (onda 1); às 22:54 UTC, os PRs #20, #21 e #22 (onda 2). A saúde mostra painel, banco e rotinas ok. Voz e Asterisk não sobem sem o
  número, então a saúde segue com `voice_down` e a rota `?strict=1` responde 503. Guia:
  [producao-coolify.md](docs/guides/producao-coolify.md).
- **Banco:** 37 migrations aplicadas no Supabase de produção contra 39 arquivos em `db/migrations`
  na `main`: faltam 2 (seção "Migrations pendentes em produção"). A contagem aplicada vem do registro
  do dono, de 17/11, de que `schema_migrations` foi de 35 a 37 depois dos PRs #15 e #16. A conexão usa `ozavo_app` e `ozavo_system` com `sslmode=verify-full`.
- **O deploy não aplica migrations.** O Dockerfile das rotinas só sobe o serviço; o serviço `migrate`
  existe apenas nos compose de `deploy/`, que o Coolify não usa. Migration nova se aplica à mão, com
  backup antes, e antes do merge do PR cujo código depende dela. Pede o OK do dono.
- **Vigia:** um monitor na VPS lê a saúde estrita a cada 5 minutos e avisa o dono no Telegram quando o
  conjunto de falhas muda.
- **Área de plataforma** (`/platform`): empresas (lista, cadastro, detalhe, convite do dono),
  FinOps por empresa e consolidado, plano por empresa com fonte única (`plan_subscriptions`),
  suspensão manual que vale sobre o Asaas e alertas críticos das empresas na plataforma.
  Plano: [painel-empresas.md](docs/plans/2026-11-16-painel-empresas.md).
- **Auditoria de 16/11:** os itens de arquitetura (A1 a A23), de qualidade (C) e de marca (B) estão
  feitos, salvo o que aparece nas seções abaixo.

## Migrations pendentes em produção

O código do #21 e do #22 já está no ar, e as duas migrations **não estão aplicadas** (o deploy não
as aplica). Aplicá-las depende do OK do dono; sem resposta, o padrão é não aplicar.

| Migration | O que faz | Efeito de faltar em produção |
|---|---|---|
| `20261117T200000_tenant_rcd_identity.sql` (#21) | Acrescenta `rcd_display_name`, `rcd_logo_png` e `rcd_logo_bmp` a `tenant_profiles`, com limites de tamanho e de caracteres. | Dão erro 500 o detalhe da empresa em `/platform` (`getPlatformTenant`), as rotas de nome e logo RCD da empresa e **toda criação de empresa** (tela de cadastro e `POST /api/v1/tenants/provision`), porque o cadastro grava as colunas novas. Também quebraria a voz (`trunks.ts`, `outbound.ts`, `asterisk-transport.ts` leem `rcd_display_name`) no dia em que ela subir. A lista de empresas e o FinOps não são afetados. |
| `20261117T201000_webhook_subscriptions.sql` (#22) | Cria `webhook_subscriptions` (com RLS forçada e permissões aos papéis do app) e abre o escopo `hooks:inbound` no check de `api_keys.scopes`. | Dão erro 500 as rotas `/api/v1/webhook-subscriptions*`, o painel de webhooks em Configurações > Integrações e a criação de chave com o escopo `hooks:inbound`. O fim de chamada e os alertas **não** quebram: o enfileiramento confere `to_regclass` antes e devolve zero entregas. |

Ordem: as duas juntas, a partir da `main`, com backup antes e conferência depois. O plano passo a
passo e a reversão ficam com o dono do projeto, fora do repositório.

## Bloqueado pelo número

Depende do número (DID e tronco SIP da BRDID) que ainda não chegou:

- ligação real de ponta a ponta e medida de TTFB e latência;
- homologação de SIP TLS 5061, SRTP, PAI e RCD com a operadora (Fase 4, C7);
- voz e Asterisk no Coolify;
- agente e linha cadastrados em produção;
- conta master de DID e alocação de DID por empresa (MT-06);
- envio do RCD à operadora/ABR (parte de MT-07).

## Bloqueado por chave ou decisão do dono

- **Asaas em produção:** faltam a chave, o token e a URL do webhook (código pronto no PR #10, guia
  [asaas-nativo.md](docs/guides/asaas-nativo.md)). Também trava MT-09, o excedente virar cobrança.
- **Variáveis no painel do Coolify** que nenhum código lê (`MIGRATION_DATABASE_URL`, chaves do
  Supabase e dos provedores de voz, que vão para a tela do motor): apagar pede o OK do dono.
- **Brand kit não versionado** (`brand/_brandkit` e o zip): decidir o destino.
- **Empresa de teste de ciclo** em produção: a limpeza está preparada e não foi executada.
- **Pedidos de decisão** de [pedidos-de-decisao-da-auditoria.md](docs/plans/2026-11-16-pedidos-de-decisao-da-auditoria.md):
  valem os padrões que o documento traz se ninguém responder em 14 dias.
- **Fora do que o CI prova:** backup agendado do Supabase conferido, ensaio de restauração do áudio
  (não há bucket nem gravação em produção) e cofre da `OZAVO_SECRET_KEY`.
  Ver [producao-fase4.md](docs/guides/producao-fase4.md).

## Próximos itens sem o número

Cada item vira um PR pequeno, com `pnpm verify` e `pnpm test:db`; migration só vai à produção com OK.

1. **Onda 1 (feita, mergeada em 17/11 às 19:06 UTC):** este STATUS (PR #17), a robustez da
   varredura de gravações órfãs (PR #18: um erro local não interrompe os órfãos seguintes nem a
   contagem de auditoria, em `packages/core/src/recordings.ts`) e MT-10 (PR #19: lista de prontidão
   da empresa, na lista e no detalhe em `/platform`). Sobra um ajuste pequeno no mesmo arquivo: só
   ENOENT no `stat` da limpeza é ignorado, e os demais erros entram nas falhas.
2. **Onda 2 (feita, mergeada em 17/11 às 22:54 UTC, `main` em `b14556a`):** o ajuste do `stat` de gravações e
   este STATUS (PR #20), MT-07 (PR #21: nome RCD e logo no cadastro da empresa, em caixa alta ASCII e
   BMP; o envio à operadora fica bloqueado) e MT-12 (PR #22: webhooks universais por empresa, entrada e
   saída, com assinatura HMAC). As migrations dos dois PRs seguem pendentes em produção (ver acima).
3. **Onda 3 (aguarda aval):** MT-11 (trilha de ações da plataforma), MT-15 (papéis de plataforma), MT-16 (LGPD por
   empresa e cerca contra biometria de voz) e a parte local de MT-09 (cálculo do excedente com Asaas
   falso, sem ligar a chave).

## Decisões do dono

- **Sem n8n.** O Ozavo usa a stack própria e a integração nativa com o Asaas. Os webhooks
  universais seguem como recurso do produto, sem fluxo interno que dependa de n8n.
- **Asaas nativo** na cobrança e na assinatura (PR #10).
- **Fora de escopo, por não estar na especificação:** entrar como suporte (impersonação),
  white-label e domínio por empresa, e usuário em várias empresas (um e-mail, uma empresa).
- **Supabase** como banco de produção, com o caminho de Postgres local mantido para quem instala.
- **OpenRouter** para o LLM do motor em pipeline.
- **Suspensão manual vence o Asaas** até a plataforma reativar.
- **Configuração tem tela:** o pacing de ligações é configurado na tela, não por `.env`.

## Histórico

- Fase 1 (áudio em pipeline: Deepgram, OpenRouter e Cartesia, identidade visual): commit direto na `main`, sem PR.
  São 5 commits até `c077dfd`: a importação inicial da VPS e 4 da fase.
- Fase 2 (multi-tenant e API de provisionamento): PR #3.
- Fase 3 (planos, FinOps e regulatório): PR #5.
- Fase 4 (produção e conformidade: TLS/SRTP, RCD, gravações cifradas, checklist): PR #6.
- P0 (papéis de banco sem BYPASSRLS, plano e teto só pela plataforma): PR #7.
- P2 (itens menores da auditoria): PR #8.
- P1 (concorrência da Cartesia, AMD, disjuntor Anatel, alertas de franquia): PR #9.
- Asaas nativo, sem n8n: PR #10.
- Resto da auditoria sem número (chave do pipeline na tela, saúde acusa banco sem TLS, Google Agenda,
  varredura de órfãos, ensaio de restauração): PR #11.
- Área de plataforma: empresas (PR #12), FinOps (PR #13), alertas (PR #14), plano por empresa
  (PR #15) e suspensão manual (PR #16).
- Onda 1 (STATUS, órfãos de gravações, prontidão da empresa): PRs #17, #18 e #19.
- Onda 2 (ajuste do `stat`, RCD por empresa, webhooks por empresa): PRs #20, #21 e #22.
