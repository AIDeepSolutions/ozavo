# Produção no Coolify: painel, rotinas, voz e Asterisk

O [roteiro da Fase 4](producao-fase4.md) prepara uma VPS dedicada com a composição
[`deploy/docker-compose.supabase.yml`](../../deploy/docker-compose.supabase.yml). Este guia é para
quem já roda o painel como aplicação do Coolify (Dockerfile da raiz, banco no Supabase) e precisa
subir as outras peças. Sem elas, a saúde acusa o que falta: `routines_not_listening` sem rotinas e
`voice_down` sem o processo de voz.

## O que cada peça faz e do que depende

| Peça | Alvo do `Dockerfile` | Porta pública | Depende de número (tronco)? |
|---|---|---|---|
| Painel | `panel` | 443, pelo proxy do Coolify | Não |
| Rotinas | `routines` | Nenhuma | Não. Sem elas param a fila, o expurgo de 90 dias, os avisos, o vencimento das aprovações e o disjuntor de chamadas curtas |
| Voz | `voice` | Nenhuma (8090 e 9092 só na rede interna) | Sim, para ligar de verdade |
| Asterisk | imagem `andrius/asterisk` fixada por resumo | 5061/TCP e a faixa RTP/UDP | Sim |

## Ordem obrigatória do deploy: migration antes do código

O deploy do Coolify **não aplica migrations** (o Dockerfile só sobe o processo; o serviço `migrate` existe só nos Compose de
`deploy/`). O código do PR #24 lê `agents.llm_profile` na consulta do agente e na API de agentes: **deploy antes da coluna
derruba a API de agentes e toda ligação**. O código antigo convive com a coluna nova (padrão `'a'`), então a ordem segura é sempre
**migration → deploy**.

1. Backup, com a conexão do dono do schema (a URL vem do cofre, nunca colada no terminal compartilhado nem em log):
   `pg_dump "$MIGRATION_DATABASE_URL" --format=custom --file=ozavo-antes-llm-profile.dump`
2. Aplicar a migration `db/migrations/20261119T120000_agents_llm_profile.sql` no worktree da `main` já com o PR, com TLS verificado (`sslmode=verify-full` e
   `sslrootcert` no fim da URL; `require` falha com certificado próprio do Supabase):
   `MIGRATION_DATABASE_URL="..." APP_DB_PASSWORD= SYSTEM_DB_PASSWORD= pnpm --filter @ozavo/routines run migrate`
3. Conferir que foi registrada e que a coluna existe:
   `select name from schema_migrations where name like '%agents_llm_profile%';` e
   `select llm_profile, count(*) from agents group by 1;` (todo agente antigo sai com `a`).
4. Só então o deploy do painel e das rotinas.
5. Reversão: o código novo exige a coluna; o código antigo não liga para ela. Para voltar o comportamento, uma **migration nova**
   (migration publicada nunca é editada) com `alter table agents drop column llm_profile` (só depois de reverter o deploy) ou
   `update agents set llm_profile = 'c'` para voltar ao Flash sem remover a coluna.

## Rotinas: segunda aplicação, mesmo repositório

As rotinas não dependem de tronco e devem subir junto com o painel.

1. Nova aplicação no mesmo projeto e ambiente do painel, do mesmo repositório e ramo, build pack
   Dockerfile, `Dockerfile` da raiz, **alvo de build `routines`**, sem domínio e com o health check
   do Coolify desligado (o processo não tem HTTP; quem mede a fila é a saúde do painel).
2. Variáveis só de execução (não de build): `DATABASE_URL`, `SYSTEM_DATABASE_URL`,
   `OZAVO_SECRET_KEY`, `PUBLIC_URL` e `ARI_PASSWORD`, com os mesmos valores do painel. As URLs
   usam a conexão de sessão do Supabase (o `LISTEN` da fila não funciona no modo de transação) e
   `sslmode=verify-full`. Se a URL aponta `sslrootcert` para um arquivo, monte o mesmo arquivo nesta
   aplicação. **Não** passe `MIGRATION_DATABASE_URL` nem chaves do Supabase: as rotinas não usam.
3. Com gravação em S3, acrescente `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` e
   `S3_SECRET_ACCESS_KEY`. Sem eles, a manutenção só cuida do disco.
4. Deploy. A conferência é a saúde: a linha `routines` passa a `routines_ok`, e no banco aparece uma
   conexão do papel `ozavo_app` com a consulta `listen tasks`.

Para desfazer, apague a aplicação de rotinas. Nada no banco muda: as tarefas ficam na fila,
`queued`, até um processo de rotinas voltar.

## Voz e Asterisk: preparado, só sobe com o tronco

Voz e Asterisk compartilham o volume `asterisk-generated` (o processo de voz escreve as linhas e o
Asterisk as lê) e conversam por ARI e AudioSocket na rede interna. Por isso sobem juntos, como um
recurso **Docker Compose** do Coolify a partir dos serviços `voice` e `asterisk` de
`deploy/docker-compose.supabase.yml`, e não como duas aplicações de Dockerfile soltas.

Antes de subir, com o número homologado em mãos:

- [ ] Gerar `app.env`, `archive.env` e os arquivos do Asterisk com `scripts/prepare-production.ts`
  (ver o [roteiro da Fase 4](producao-fase4.md)), sem colar segredo em argumento.
- [ ] Publicar no host 5061/TCP e a faixa RTP (padrão 10000–10200/UDP), e liberar as mesmas portas no
  firewall do provedor. Nenhuma porta de ARI (8088), AudioSocket (9092) ou interna (8090) fica pública.
- [ ] Ligar o recurso Compose à rede do Coolify em que o painel está, para o painel alcançar o
  processo de voz. No painel, `VOICE_INTERNAL_URL` passa a apontar para o nome do serviço de voz
  nessa rede, porta 8090, e `INTERNAL_TOKEN` é o mesmo valor nos dois.
- [ ] Certificado SIP com cadeia válida e renovação monitorada; chave privada legível só pelo Asterisk.
- [ ] Deploy, e conferir na saúde: `voice_ok`, `telephony_ok` e `trunk_ok`. Só então uma
  ligação de teste recebida e uma originada.

Sem tronco, subir voz e Asterisk só troca `voice_down` por `trunk_none` e abre portas na internet
sem uso. Por isso a ordem é: rotinas agora, voz e Asterisk quando o número estiver homologado.

## Voz e Asterisk sem acesso ao disco do servidor (Compose do Coolify)

Quando só há a API do Coolify (sem SSH), use [`deploy/docker-compose.coolify-voz.yml`](../../deploy/docker-compose.coolify-voz.yml):
recurso Docker Compose, mesmo repositório e ramo, arquivo de Compose `/deploy/docker-compose.coolify-voz.yml`.
O pacote de configuração do Asterisk vai numa variável (`ASTERISK_CONF_B64`), sem arquivo no host:

1. Rode `scripts/prepare-production.ts` num diretório novo, fora do repositório (com
   `temporaryUdpHost` só se a exceção da Telera estiver valendo), reaproveitando `OZAVO_SECRET_KEY` e
   as URLs do painel.
2. `tar czf` de `extensions.conf http.conf ari.conf rtp.conf pjsip.conf tls` (de `asterisk/generated`)
   e `base64 -w0` vira `ASTERISK_CONF_B64`. A CA do Supabase vira `SUPABASE_CA_B64`.
3. Variáveis: `DATABASE_URL`, `SYSTEM_DATABASE_URL`, `OZAVO_SECRET_KEY`, `PUBLIC_URL`, `ARI_PASSWORD` (a
   mesma do `ari.conf`), `INTERNAL_TOKEN`, `PUBLIC_IP`, `OZAVO_UDP_ONLY_HOSTS`. No painel:
   `VOICE_INTERNAL_URL=http://ozavo-voice:8090` e o mesmo `INTERNAL_TOKEN`.
4. Com a exceção de UDP da Telera, acrescente ao `pjsip.conf` uma `type=acl` que só permite o IP da
   Telera (`deny=0.0.0.0/0.0.0.0` + `permit=<IP>/255.255.255.255`): a 5060/udp do Compose não filtra por
   origem. Esse bloco é da exceção temporária e sai junto com ela.
