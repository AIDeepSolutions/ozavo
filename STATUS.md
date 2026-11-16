# OZAVO — STATUS DE EXECUÇÃO

> Atualizado sempre que algo muda. Quem lê: o agente (sempre) e o Macgyver (quando quiser).
> Última atualização: 16/11/2026 ~23h50 UTC (16/11 20h50 BRT), depois dos PRs #7 a #10 e do ramo
> `feat/auditoria-restante`.

## Estado atual (vale sobre as seções abaixo, que ficam como histórico)

- Fases 1, 2, 3 e 4 estão na `main` (PRs #3, #5 e #6). Correções da auditoria: P0 no PR #7, P2 no
  PR #8, P1 no PR #9, Asaas nativo no PR #10. O ramo `feat/auditoria-restante` fecha o que sobrou sem
  número e sem Asaas: chave do motor pipeline em três campos na tela (onboarding), saúde acusa banco
  remoto sem TLS verificado, Google Agenda por conta de serviço, varredura semanal de cópias órfãs no
  bucket, ensaio de restauração registrado e metadados/manifesto da marca.
- Banco (Supabase): 29 migrations aplicadas; a conexão usa `ozavo_app` e `ozavo_system` com
  `sslmode=verify-full`. **Seis migrations da `main` ainda não aplicadas**: `20261116T211700`,
  `20261116T212500`, `20261116T213500`, `20261116T220000`, `20261116T221000` e `20261116T230000`.
  Elas entraram sem erro numa cópia restaurada do backup de produção (ensaio em
  [docs/guides/producao-fase4.md](docs/guides/producao-fase4.md)). Aplicar pede o OK do dono.
- Coolify: painel e **rotinas** no ar; a saúde mostra `routines_ok`. Voz e Asterisk **não** sobem sem
  o número (tronco) homologado, e por isso a saúde segue com `voice_down` (a rota `?strict=1` responde
  503). As variáveis do painel deixaram de ir para o build em 16/11 ~23h45 UTC (só execução). Ver
  [docs/guides/producao-coolify.md](docs/guides/producao-coolify.md).
- Monitor: um vigia na VPS lê a saúde estrita a cada 5 minutos e avisa o dono no Telegram quando o
  conjunto de falhas muda (fora do repositório, na área de estado do agente).
- Bloqueado pelo número: ligação real, homologação de TLS/SRTP, PAI e RCD com a operadora, voz e
  Asterisk no Coolify, agente cadastrado com linha.
- Bloqueado pelo Asaas: chave, token e URL do webhook (PR #10 pronto).
- Esperando decisão do dono: tirar do painel no Coolify as variáveis que nenhum código lê
  (`MIGRATION_DATABASE_URL`, chaves do Supabase e dos provedores de voz, que vão para a tela do
  motor), o destino do brand kit não versionado (`brand/_brandkit`, zip) e os pedidos de
  [docs/plans/2026-11-16-pedidos-de-decisao-da-auditoria.md](docs/plans/2026-11-16-pedidos-de-decisao-da-auditoria.md).
- Os bloqueios antigos das seções "BLOQUEIOS / PENDÊNCIAS" e "A FAZER" abaixo estão resolvidos,
  salvo o que está nesta seção.

## ✅ FEITO
- Supabase: conexão testada + **25 tabelas, 23 migrations aplicadas** (16/11 04h00)
- Coolify: projeto "Ozavo" (id 28, env production) + app `ozavo:main-micr58ufexh0gzn8ttzzxz2l` (repo AIDeepSolutions/ozavo, branch main, build_pack dockerfile, porta 3000, domínio https://ozavo.aideepsolutions.io)
- Spec técnica completa em PDF recebida e CONFERIDA (4 páginas) — tudo coberto no plano em 4 fases. Único ponto divergente: pacing por .env (spec) x tela (AGENTS.md) — aprovado usar tela.
- Manual da marca lido (3 páginas) — regras repassadas ao pane-6 (assinatura "Ozavo — Uma solução AI Deep Solutions", persona Nico, paleta, tipografia Inter, usos proibidos)
- Credenciais guardadas no cofre de credenciais da VPS (fora do repositório) (600): Supabase (URL/chaves/connection string) + Cartesia
- Brand kit extraído em brand/_brandkit/ (logos, ícones, favicon, RCD ABR, KVs)
- Inspecionado repositório (estrutura, banco, testes, deploy) — 791 testes unitários + 61 fences verdes
- GitHub: repo github.com/AIDeepSolutions/ozavo criado, branch main rastreando, push feito
- Brand kit salvo em `brand/` (logos, ícones, RCD ABR, KVs de redes sociais)
- Spec técnica do Ozavo recebida e consolidada (identidade, áudio, telefonia, multi-tenant, planos, regulatório)
- Plano Arquitetural em 4 Fases apresentado — **APROVADO pelo Macgyver em 16/11 03h40**

## ✅ INVENTÁRIO DO REPO ENTREGUE (16/11 ~04h45 BRT)
- Relatório técnico completo (módulos, stack, 23 migrations, ARI/AudioSocket, voz, rotas REST, deploy, testes) entregue no handoff h-4
- Conclusão: multi-tenant já existe por `organization_id`+RLS (não renomear para tenant_id); voz é só speech-to-speech (sem pipeline Cartesia/Deepgram/OpenRouter); sem TLS/SRTP, sem API key, sem /tenants/provision, sem planos, sem circuit breaker Anatel, sem AMD; LGPD tem retenção configurável mas sem padrão 90 dias
- Texto completo também em /tmp/claude-1000/-home-dev-workspaces/0b8790fe-9cb4-485e-90a8-57f0dd58a52c/scratchpad/inventario-ozavo.md (apagável; conteúdo no handoff h-4)

## 🔄 EM ANDAMENTO
- pane-4: inventário detalhado do repositório — **ENTREGUE (h-4)**
- pane-7 (antes pane-5): Fase 1 (Cartesia/Deepgram/OpenRouter/barge-in) — **REABERTO em 16/11 ~05h00 BRT (codex) e rodando**
- pane-6: identidade visual (tokens.css, logos, favicons, tipografia) — **REABERTO em 16/11 ~05h00 BRT e rodando**
- ⚠️ 16/11 ~04h50 BRT: queda de sessão + troca para MiMo flash zerou os panes (pane_list vazio). Nenhum worker órfão, mas pane-5 e pane-6 precisam ser reabertos
- Fase 1: integração Cartesia/Deepgram/OpenRouter + barge-in — **delegada ao pane-5** (16/11 03h45)
- Inventário detalhado do repo — **delegado ao pane-4** (16/11 03h35)

## ⏳ A FAZER (ordem de prioridade)

### Fase 1 — Core + Áudio (latência < 500 ms)
> Delegado ao pane-5 em 16/11 03h45
- [ ] 1.1 Interface unificada TTS/STT/LLM em `packages/voice-engine`
- [x] ~~1.2 Cartesia~~ (em execução no pane-5) Cartesia Sonic 3.6 via WebSocket — `pcm_mulaw` 8 kHz nativo, TTFB < 100 ms, `voice_id` por tenant
- [x] ~~1.3 Deepgram~~ (em execução no pane-5) Deepgram Nova-2/3 streaming pt-BR (NÃO usar Cartesia Ink-2: sem pt streaming)
- [x] ~~1.4 OpenRouter~~ (em execução no pane-5) LLM via **OpenRouter** (function calling: agenda, reagenda, cancela, webhooks)
- [x] ~~1.5 barge-in/endpointing/AMD~~ (em execução no pane-5) Barge-in (VAD contínuo, corta TTS e reabre escuta) + endpointing dinâmico + AMD
- [ ] 1.6 Testes locais de latência (TTFB, RTT, barge-in sem engasgo)

### Fase 2 — Multi-tenant + White-label + APIs
> Aguardando conexão do Supabase para parte do schema
- [ ] 2.1 `tenant_id` estrito em todas as tabelas + voice_id/persona/prompt/credenciais por tenant
- [x] ~~2.2 White-label~~ (em execução no pane-6) White-label Ozavo (navy `#071D3A`, cyber `#0052CC`, teal `#00B4D8`, branco/gelo; SEM gradiente, SEM roxo; Inter; caixa baixa `ozavo`)
- [ ] 2.3 Conectores MVP: Google Calendar (OAuth), Cal.com (API key), Webhooks universais
- [ ] 2.4 `POST /api/v1/calls/outbound` (Bearer, fila prioritária < 5 s)
- [ ] 2.5 `POST /api/v1/tenants/provision` (stack própria + Asaas nativo → tenant com convite de dono)

### Fase 3 — Planos + FinOps + Regulatório
- [ ] 3.1 Motor de planos: Starter 300min R$497 · Pro 750min R$997 · Growth 1.500min R$1.497 · Scale 2.500min R$1.997 · Personalizado
- [ ] 3.2 Metering em tempo real (expandir `usage_ledger`) + alertas 80%/100% + regra de excedente por tenant
- [ ] 3.3 Concurrency pacing (semáforo global/tenant, limite Cartesia via `.env`)
- [ ] 3.4 Guardrails TTS: turnos de 120–160 caracteres
- [ ] 3.5 Circuit breaker Anatel: 75% de ligações < 6 s em > 1.000/dia → reduz cadência + alerta
- [ ] 3.6 Dashboard FinOps (minutos, caracteres TTS, custo variável vs MRR, margem bruta)

### Fase 4 — Produção + Conformidade
- [x] Deploy no Coolify funcionando (painel no ar)
- [ ] 4.1 Docker Compose (voice, panel, routines, **Supabase**, MinIO/S3, Asterisk, Caddy)
- [ ] 4.2 SIP TLS 5061 + SRTP + PAI E.164 + `export` (nunca `set local`) entre A-leg/B-leg
- [ ] 4.3 RCD ABR: `caller_display_name` 32 ASCII + conversor logo 256×256 alfa ≤ 300 KB
- [ ] 4.4 LGPD: gravações criptografadas 90 dias + expurgo automático configurável
- [ ] 4.5 Checklist produção (backup, métricas, healthcheck, alertas, DR)
- [x] 4.6 Subdomínio `ozavo.aideepsolutions.io` + certificado (aplicado no Coolify, certificado automático)

## 📌 DECISÕES DO MACGYVER
- **Banco: Supabase** (gerenciado, separa responsabilidades) — ele cria e me passa a connection string. Enquanto não chega, seguir com as demais prioridades.
- **LLM: OpenRouter** (não Gemini/GPT-4o-mini direto)
- **Deploy: automático via main no Coolify** — ele configura o projeto lá; eu NÃO faço deploy manual. Token no arquivo `coolify.env` do cofre de credenciais da VPS (fora do repositório) (nunca em mensagens/git).
- **Etapas: delegar a panes** (funcionários), eu orquestro e reporto.
- **Nada de código antes da aprovação do plano** — aprovado em 16/11 03h40.

## ✅ NO AR (16/11 04h12)
- Usuário de acesso criado (16/11 04h20): organização "AI Deep Solutions" (owner), e-mail da conta de operação, senha inicial gerada e entregue por Telegram (testada via /api/v1/auth/login, HTTP 200). Pedir que ele troque a senha em Configurações > Conta.
- **Painel Ozavo respondendo em https://ozavo.aideepsolutions.io/login (HTTP 200, título "Ozavo")**. /calls redireciona para /login (comportamento correto). Deploy automático pela main funcionando.

## 🐛 INCIDENTE 04h05 (resolvido)
- Deploy subiu mas /calls dava 500 com "Invalid configuration" — faltavam env vars: OZAVO_SECRET_KEY, PUBLIC_URL, ARI_PASSWORD. Gerei valores e adicionei no Coolify (public_url=https://ozavo.aideepsolutions.io). Restart concluído — painel voltou normal (16/11 04h12).
- Lição: antes do próximo deploy, conferir TODAS as variáveis do config.ts do app.
- Inventário de env vars do app (packages/core/src/config.ts): ARI_APP (padrão ozavo), ARI_PASSWORD (definida), ARI_URL (padrão http://asterisk:8088), ARI_USERNAME (padrão ozavo), AUDIOSOCKET_PORT (9092), DATABASE_URL (Supabase), MIGRATION_DATABASE_URL (Supabase), OZAVO_SECRET_KEY (gerada), PANEL_PORT (3000), PUBLIC_URL (definida), SYSTEM_DATABASE_URL (Supabase). Só faltam as do Asterisk quando houver tronco real.

## ⚠️ BLOQUEIOS / PENDÊNCIAS
- Coolify: domínio RESOLVIDO — campo correto é `domains` (o `fqdn` é rejeitado no PATCH). Aplicado `https://ozavo.aideepsolutions.io` + restart disparado.
- Supabase: URL + chaves publishable/secret RECEBIDAS em 16/11 03h50 (guardadas no arquivo `supabase.env` do cofre de credenciais da VPS (fora do repositório), 600, nunca em mensagens/git). Falta a connection string do Postgres (postgres://...pooler...) para migrations diretas — pedir se precisar.
- Push na main: preciso confirmar com ele (regra antiga: "nunca push na main"; deploy é automático pela main).
- 3 conflitos AGENTS.md x spec: APROVADOS pelo Macgyver em 16/11 03h50 ("os 3 pontos tá beleza"). Marcar para REALINHAR se precisar no futuro: (1) Supabase x Postgres-local, (2) pacing por tela em vez de .env, (3) /calls/outbound com checkOutboundAllowed.


## 📕 REGRAS DO AGENTS.md (obrigatórias — ler antes de codar)
- Schema: SÓ `db/migrations` com carimbo `<AAAAMMDDTHHMMSS>_<slug>.sql`; migration publicada nunca é editada
- Toda tabela tem `organization_id uuid not null` (exceto `organizations` e `schema_migrations`)
- Todo acesso a dado por `withOrg`; SQL cru fora de `packages/core` reprova
- Um ponto de escrita por entidade: `recordEvent`, `enqueueTask`
- Fila por notificação (`listenTasks`/`claimTask`), sem polling curto
- **Configuração de operador TEM TELA** — recurso que se liga por `.env` não entra
- Texto visível só em `apps/panel/src/i18n/` (pt-BR, en, es)
- Teste recebe `Clock`, porta `0`; sem `new Date()` em produto
- Segredo cifrado com `encryptSecret` (chaves Cartesia/Deepgram/OpenRouter)
- Telefone em E.164 (`toE164`)
- **Ligações de saída nascem desligadas** + `checkOutboundAllowed` (impacta /calls/outbound)
- Identificadores em inglês; docs/tela pt-BR; Commits Conventional (pt-BR)
- Entrada externa validada com zod
- Cor só em `apps/panel/src/design/tokens.css` (white-label vai pra lá)
- Fontes versionadas no repo (não `next/font/google`)
- Worktree descartável, não checkout principal; caminho absoluto
- Rodar `pnpm verify` antes de entregar; skills em `.agents/skills/` (ozavo-doutrina, ozavo-motor-de-voz, ozavo-ferramenta)

## ⚠️ CONFLITOS A CONFIRMAR COM O MACGYVER
1. **Supabase x Antipadrão 6** do AGENTS.md: "Depender de serviço de nuvem para o sistema subir" é proibido — o projeto regra Postgres NA VPS. Macgyver escolheu Supabase. Resolução: seguir o dono, mas registrar em `docs/decisions/` e manter caminho de Postgres local funcionando para quem instala.
2. **Concurrency pacing por `.env`** x regra 7 ("recurso que se liga por `.env` não entra"): precisa de TELA no painel (config por tenant), não variável.
3. **API /calls/outbound** precisa passar por `checkOutboundAllowed` + `do_not_call` (não pode ser atalho de disparo em massa — Antipadrão 16).

## 🎯 METAS
- Latência: TTFB < 100 ms · RTT < 500 ms · barge-in sem engasgo
- Custo variável: < R$ 0,28/min (operacional R$ 0,215/min)
- Provisionamento de tenant em minutos
## 📌 MATERIAIS RECEBIDOS (16/11)
- PDFs: a caixa de entrada da VPS: 462531606-Manual_da_Marca…pdf e 462531608-Especifica_o_T_cnica…pdf
- Brand kit: brand/ (extraído)
- Chaves: o cofre de credenciais da VPS (fora do repositório) (supabase.env = Supabase URL/chaves/connection string + CARTESIA_API_KEY; openrouter.env = OPENROUTER_API_KEY; coolify.env = URL + token)

## 🛑 PARADO EM 16/11 ~09h20 BRT (religada pedida pelo Macgyver)
- Inventário do repositório: ENTREGUE (ver seção acima).
- pane-7 (codex) da Fase 1: aberto às ~07h58 UTC, sem entregar nada em ~4h → REFAZER com outro worker.
- Worker de identidade visual: nunca chegou a abrir → REFAZER.
- Substitutos lançados como subagentes nativos: morrem com a religada → REFAZER na sessão nova.
- Regra do Macgyver: o orquestrador DELEGA e não executa; update a cada ~1h30 mesmo sem mudança.

## ✅ PUBLICADO (16/11 ~11h15 BRT)
- main em c077dfd (4 commits: pipeline de áudio, identidade visual, docs). pnpm verify verde (61 cercas + 878 testes). Push feito com autorização do Macgyver; deploy automático confirmado; painel no ar com a identidade oficial (print enviado).
- Sem migration nova (nada a aplicar no banco).
- Pendências: chave Deepgram; TTFB Cartesia ~305 ms (meta <100 ms); test:db por permissão do Docker; Inter não versionada.
- Deepgram: chave RECEBIDA 16/11 (testada, API 200), no arquivo `deepgram.env` do cofre de credenciais da VPS (fora do repositório) (600). PDFs/spec copiados para docs/referencias/ (sem commit).
- Fase 2 INICIADA 16/11 (OK do Macgyver): pane-10 ozavo-fase2-api, ramo feat/fase2-multitenant-api (worktree ../ozavo-wt-fase2), sem push/migration em prod.


## Fase 4 — implementação local (16/11/2026, 15h15 UTC)

Ramo `feat/fase4-producao-conformidade`, worktree `../ozavo-wt-fase4`, base `main` c077dfd.
Sem push, sem deploy, sem conexão nem migration no Supabase de produção.

- [x] 4.1 Compose independente `deploy/docker-compose.supabase.yml`: voice, panel, routines,
  Asterisk, Caddy e MinIO opcional/S3 externo, sem Postgres local. Preparo gera arquivos privados,
  separa credenciais, valida TLS/roles e não executa migrations nem serviços. Compose validado.
- [x] 4.2 Configuração de produção só TLS 5061/SRTP, sem fallback UDP. PAI da linha E.164,
  herança `__` e handler na B-leg (equivalente Asterisk ao `export` da spec). Linhas existentes
  preservam o protocolo no instalador comunitário e precisam ser convertidas pela tela para produção.
- [x] 4.3 Nome RCD até 32 ASCII seguros no cadastro da Linha e conversão Pillow na tela.
  Logo do kit: PNG RGBA 256×256, 13.164 bytes, com download para homologação.
- [x] 4.4 Áudio novo cifrado em blocos AES-256-GCM antes da escrita, chave por organização/chamada,
  reprodução em fluxo, hash do WAV exportado, conversão progressiva do legado, cópia S3 cifrada.
  Retenção de áudio própria, padrão/piso 90 dias, ajuste pela tela até 3650, confirmação ao reduzir,
  expurgo diário por fila e exclusão do titular também na cópia. Sem voiceprint/biometria.
- [x] 4.5 Checklist e roteiro de backup, métricas, alertas e DR em `docs/guides/producao-fase4.md`.
  Checagem de saúde recusa relatório falho mesmo com HTTP 200.

### Verificação desta etapa

- `pnpm verify`: verde (61 cercas e 888 testes unitários).
- `pnpm --filter @ozavo/panel typecheck`: verde; build Next concluído.
- `pnpm test:db` com banco novo descartável: 888 testes, 69 arquivos, todos verdes.
  O Docker foi recusado por permissão; foi usado Postgres 17.11 nativo em `/tmp`, porta de loopback
  escolhida pelo SO. Sem Supabase. Testes focados de manutenção/API repetidos após ajustar NOTIFY.
- `docker compose config --quiet`: verde, nenhum serviço iniciado.
- Navegador Chromium contra painel construído + banco de bancada: prazo 180→90 com confirmação,
  cadastro RCD e upload/conversão/download do kit; zero erros de página. Capturas em
  `/tmp/ozavo-fase4-privacy.png` e `/tmp/ozavo-fase4-line.png`.
- Shell do instalador: checagem de saúde passou (104 verificações) ao remover PYTHONHOME herdado
  do ambiente do app. A suíte completa expôs uma expectativa de ordenação já existente no main
  em `install/test/02-env-and-templates.sh`; não foi alterada nesta tarefa.
- Prova por sabotagem: desativada a cifra somente em worktree descartável do commit e35863b;
  o único teste executado reprovou no cabeçalho em claro, como previsto. Cópia descartável removida.
- Revisão independente/adversária realizada (h-d, h-g, h-h); ver o fechamento e a pendência residual abaixo.

### Migration e integração

- `db/migrations/20261116T180401_trunk_rcd_identity.sql`: nome/logo RCD e `sip_tls` em trunks.
  Aplicada somente nos bancos locais descartáveis de teste. Não aplicada no Supabase de produção.
- Sobreposição mínima necessária com a Fase 3: `apps/voice/src/outbound.ts` apenas lê o nome RCD,
  recusa origem sem E.164 e entrega caller ID com nome. Preservar a chamada a `checkOutboundAllowed`
  ao integrar. Também conciliar exports, vocabulário, lockfile, shapes/tipos e STATUS entre os ramos.
- Novos eventos de organização: `recording_retention_changed`, `recordings_purged`.
  Novo setting: `recordings.retention_days`. Nova rotina: `maintain_recordings`.

### Pendências para liberar produção

- Revisão independente do ramo, construção/execução real das imagens e prova de chamada TLS/SRTP,
  PAI na B-leg e homologação RCD/atestação com operadora. PAI sozinho não garante atestação A.
- Certificado SIP de cadeia confiável e renovação; converter linhas legadas para TLS pela tela.
- Validar procedência/manutenção do espelho MinIO não oficial fixado por digest ou usar S3 mantido.
  Imagens oficiais MinIO recusaram pull público (401), e o espelho foi identificado em CREDITS.
- S3 é cópia diária; reprodução usa disco. RPO de áudio até 24h. Recuperação repõe os objetos
  cifrados no volume. MinIO na mesma VPS não protege contra perda da VPS.
- Bucket sem versionamento/retenção imutável, política de backups externos compatível com expurgo,
  cofre da chave, destinatário real dos alertas e ensaio de DR com contagens/hash e duração medidos.
- Adequação da composição à rede/portas do Coolify existente antes de qualquer deploy autorizado.


Commit de implementação da Fase 4: `e35863b` (local). Em 16/11 às 15h15 UTC o `main` já estava
em `d371971`, atualizado por outro trabalho durante esta etapa. Este ramo conserva sua base
`c077dfd`; a Fase 4 não alterou nem integrou o main. Comparar o diff com essa base ao revisar.


### Revisão independente e correções (16/11/2026, 15h30 UTC)

A revisão do pane-14 (handoff h-d) reprovou a liberação com três reproduções válidas, apesar de
verify/tipos e 888 testes de banco terem passado no cluster novo do revisor:

- P1: mtime restaurado mantinha áudio vencido no disco. Corrigido para usar `ended_at`/`erased_at`
  do banco em disco e S3. mtime agora só é fallback de arquivo órfão. O teste cobre vencido com
  mtime novo, recente com mtime antigo e chamada apagada ainda presente no disco.
- P1: `DATABASE_URL` transacional era aceito, mas LISTEN usa esse pool. Corrigido para rejeitar
  6543 em todas as três URLs, preservando o pool/contagem de listeners existente. Documentação alinhada.
- P2: umask 077 gerava arquivos ilegíveis ao UID do Asterisk. Corrigido com chmod explícito:
  configurações/certificado/chave 0644, diretório TLS montado 0755, pai do acervo gerado 0700.

Após as correções: `pnpm verify` saída 0, 61 cercas/889 testes unitários; tipos do painel saída 0;
dois testes de banco de manutenção passaram, incluindo as regressões. Nenhuma migration nova
foi necessária. Nova conferência independente das correções está pendente.


### Segunda revisão e expurgo sob falha remota (16/11/2026, 15h40 UTC)

O pane-15 (handoff h-g) confirmou a resolução dos três achados anteriores e mediu verify/tipos
mais 889 testes de banco verdes em cluster novo. Encontrou um novo P1 reproduzido: a primeira
falha S3 interrompia as exclusões locais restantes e repetia o bloqueio no retry.

A rotina foi separada em fases: conclui todas as exclusões locais antes de qualquer operação S3;
também isola erros por item, tenta os demais objetos e só depois devolve um AggregateError para a
fila reexecutar. A próxima passagem diária e a auditoria do que saiu continuam preservadas.
Novos testes injetam falha tanto em remove quanto em put, com duas gravações vencidas e uma
recente, conferem o disco antes de toda operação remota e repetem a tentativa. Os quatro testes
de manutenção passaram no Postgres local. Nenhuma migration adicional, sem ação em produção.


### Fechamento local da Fase 4 (16/11/2026)

O pane-16 aprovou a correção específica do P1 de falha S3 (handoff h-h), sem encontrar regressão
nova no delta `7f84f69..4b0bf7c`. Conferiu independentemente: verify saída 0 (61 cercas e 889
unitários), tipos do painel/e2e saída 0, 37 testes de banco afetados e a suíte completa com
**891 testes de banco verdes**, todos em cluster novo de loopback. Também comparou o código
anterior e o atual, com falhas remove/put, erro local de .part, cifragem inválida e recuperação real
na terceira tentativa da fila. Recentes e outra organização ficaram preservadas.

**P2 herdado ainda aberto:** `packages/core/src/recordings.ts`, no fallback de arquivos órfãos
(sem chamada no banco), interrompe os órfãos seguintes quando um item dá erro local; exclusões
parciais anteriores a esse erro não entram na contagem de auditoria. Reproduzido em h-h também
no código anterior ao último conserto. Não afeta a resolução do P1 das chamadas conhecidas, mas
é pendência de robustez/conformidade para a liberação. A revisão não aprovou universalmente todos
os caminhos de falha nem atestou produção real.

Sem trabalho fora do escopo: não houve push, merge no main, deploy, envio de mensagens externas
ou acesso ao Supabase de produção. As alterações de TLS do instalador comunitário preservam
linhas legadas; a composição Supabase continua sem Postgres local e sem transporte UDP.
Erros encontrados durante a implementação estão registrados nas três revisões acima e foram
corrigidos nos commits locais, exceto o P2 herdado explicitado neste fechamento.

Migration continua sendo apenas `db/migrations/20261116T180401_trunk_rcd_identity.sql`, aplicada
somente em bancos descartáveis. Pendências operacionais continuam: build/boot Docker, chamada
TLS/SRTP e PAI na B-leg com operadora, homologação RCD, certificado/renovação, armazenamento real,
procedência da imagem MinIO ou S3 mantido, alertas entregues e ensaio de backup/DR. Nenhuma delas
foi declarada provada por testes locais. Integrar este ramo às Fases 2/3 exige conciliar os arquivos
compartilhados listados acima; a base permanece c077dfd.

Painel de bancada e Postgres descartável do implementador foram encerrados. Logs e capturas
ficaram em `/tmp`; os revisores também encerraram seus clusters e não alteraram o worktree.
