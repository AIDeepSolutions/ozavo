# Preparar e conferir a produção da Fase 4

Este roteiro prepara uma VPS dedicada. Não substitui a implantação Coolify que já existe, nem deve
ser executado contra ela durante a revisão. O Compose usa 80/443; a integração com um proxy já
instalado exige conferir redes e portas antes de liberar o deploy. Não houve deploy nesta entrega.

## Preparo reproduzível

Na raiz do ramo, passe JSON pela entrada padrão para:

```sh
node --import tsx scripts/prepare-production.ts /caminho/absoluto/novo
```

Campos obrigatórios: `databaseUrl`, `systemDatabaseUrl`, `migrationDatabaseUrl`, `publicUrl`
(HTTPS), `publicIp`, `tlsCertificate`, `tlsPrivateKey` (dois caminhos absolutos). As URLs Supabase
precisam de `sslmode=verify-full`; as três URLs precisam da conexão de sessão, incluindo `DATABASE_URL`, usada por LISTEN. Use usuários
`ozavo_app` e `ozavo_system` já provisionados. Para uma atualização forneça também `secretKey`
(hexadecimal de 32 bytes), a mesma chave da instalação. Não passe segredos em argumentos nem
salve esse JSON no repositório. Não use credenciais de produção em testes.

Sem `s3`, o preparo gera credenciais e habilita o perfil MinIO interno. Com `s3`, informe `endpoint`
HTTPS, `bucket`, `region`, `accessKeyId`, `secretAccessKey`; o MinIO fica fora da composição ativa.
Credenciais S3 externas devem permitir apenas o bucket do Ozavo. Não habilite versionamento ou
retenção imutável sem um mecanismo que também apague versões antigas no prazo e a pedido do titular.
O aplicativo não remove versões anteriores nem remove backups fora desse bucket.

O preparo recusa sobrescrever diretório existente, confere certificado/chave/hostname e gera
`app.env`, `migrate.env`, `archive.env`, `minio.env`, `.env`, configurações do Asterisk e Compose.
O diretório e arquivos de segredos ficam 0700/0600. A chave SIP é legível no bind mount para o usuário
do Asterisk; o diretório pai fechado protege seu acesso no host. Nenhum comando de banco, rede ou
Docker é executado pelo preparo. O build aponta para o checkout do ramo para incluir esta mudança.

Depois da revisão e da autorização de implantação, o responsável constrói as imagens, inicializa
o bucket com o serviço administrativo `storage-init` e aplica as migrations com `migrate`.
Os dois estão no perfil `admin` e nunca são executados por `up`. O banco deve estar migrado antes
de iniciar as aplicações. Não use as imagens de uma versão anterior para testar a Fase 4.

## Condições para liberar tráfego

- [ ] Revisão independente e adversária do diff; `pnpm verify`, tipos do painel e `pnpm test:db`.
- [ ] Construir e subir a composição em ambiente descartável; validar saúde de todos os serviços.
- [ ] Supabase com backups/PITR habilitados conforme o plano contratado; restauração provada em
  projeto de teste. Conferir RLS entre duas organizações e separar os três papéis.
- [ ] Liberar 5061/TCP e a faixa SRTP 10000–10200/UDP no provedor; ARI 8088, AudioSocket, painel,
  rotinas e MinIO sem portas públicas. A composição Supabase não publica 5060.
- [ ] Certificado SIP com cadeia válida, hostname correspondente e renovação monitorada. Agendar
  reinício controlado do Asterisk após renovar (transporte sem recarga), sem chamadas em curso.
- [ ] Linhas legadas convertidas para TLS/SRTP pela tela. Não basta mudar a porta no host.
- [ ] Homologar uma chamada recebida, uma originada e uma transferência: INVITE em TLS, SDP com
  SRTP obrigatório, PAI com DID E.164 da organização na B-leg e sem identidade de outra organização.
  Capturas de SIP contêm dados e chaves SDES: guardar só em bancada, com acesso restrito e descarte.
- [ ] Operadora homologou DID/CNPJ e RCD. PAI sozinho não garante atestação A nem exibição no aparelho.
- [ ] Cadastro RCD rejeita nome com acentos ou acima de 32 caracteres; exporta PNG RGBA 256×256 até
  300 KB. RGB tem 24 bits mais alfa de 8 bits (RGBA 32): “alfa de 24 bits” não é um modo de PNG.
  O conversor preserva o alfa existente e cria margem transparente; não remove fundo de logo opaco.
- [ ] Aviso de gravação e hipótese de tratamento definidos pela organização, acesso por função,
  gravação desligada por padrão; áudio cifrado em disco/MinIO, prazo próprio confirmado na tela.
- [ ] Provar expurgo de uma gravação vencida e preservação de uma recente/de outra organização,
  tanto em disco quanto S3; provar apagamento do titular e falha/reexecução da fila.
- [ ] Nenhum voiceprint, embedding biométrico ou reconhecimento de voz do interlocutor. TTS com
  voz escolhida pelo cliente não autoriza coletar biometria de quem ligou.

## Saúde, métricas e alertas

```sh
node --import tsx scripts/production-healthcheck.ts https://instalacao.example
```

A checagem lê o relatório de saúde, não só HTTP 200. Sai 0 em `ok`, 1 em `warn`, 2 em falha, com
um estado por peça e sem configuração/segredos. O relatório mede banco, voz, Asterisk e a fila
(listener/atraso). O healthcheck do contêiner é de disponibilidade do processo; não substitui isto.

Configurar o monitor externo e um destinatário antes da liberação. Não foram criados monitores nem
enviados alertas externos nesta tarefa. Registrar em operação o destinatário e provar a entrega.
Como ponto de partida a calibrar na bancada:

| Sinal | Alerta e ação |
|---|---|
| Estado essencial `fail` | Duas sondagens consecutivas: acionar plantão; ler a peça e o motivo |
| Fila sem listener ou tarefa vencida há mais de 2 min | Conferir rotinas e conexão de sessão Supabase |
| Tarefa `maintain_recordings` ou `erase_recordings` falhou | Prioridade alta; conferir bucket/permissões e reexecutar após corrigir |
| Disco abaixo de 1 GiB ou 15% livre | Liberar espaço sem apagar acervo dentro do prazo; gravação já tem piso de 1 GiB |
| TLS vence em menos de 14 dias | Renovar e provar a cadeia antes do reinício controlado |
| `recording_failed`, erro S3 ou perda de conexão Supabase | Conferir log estruturado; não gravar payload de áudio nem segredo no coletor |
| Latência/custo/concorrência | Usar as métricas das Fases 1 e 3 após integrar os ramos |

Logs têm rotação 10 MB × 5 arquivos por serviço. O acervo de áudio não é log. Medir CPU, RSS,
espaço de disco, atraso/fracassos da fila e idade da cópia de áudio; anexar valores da bancada ao
registro da liberação. Ainda não existem números de capacidade para esta composição.

## Backup e recuperação de desastre

- [ ] Backup diário do Supabase e recuperação de ponto no tempo, conforme recursos realmente
  contratados. Conexões do backup não devem usar o pooler transacional.
- [ ] Cópia cifrada diária de áudio em bucket privado, mais cópia fora da VPS se o MinIO estiver
  na mesma máquina. MinIO na mesma VPS protege contra perda do volume de gravações, não da VPS.
- [ ] Guardar `OZAVO_SECRET_KEY` e configurações cifradas em cofre separado do banco/áudio; testar
  a recuperação da chave. Trocar essa chave torna segredos e áudio anteriores ilegíveis.
- [ ] Medir e acordar RPO/RTO. O arquivamento implementado roda diariamente: RPO de áudio até
  24 horas, sem promessa de cópia imediata. Prazo de restauração depende do tamanho medido.
- [ ] Restaurar o banco em outro projeto de teste, conferir migrations e contagens por organização.
  Restaurar os objetos cifrados para `/recordings/<organizationId>/<callId>.wav` removendo somente
  o sufixo `.enc` da chave S3. Nenhum áudio precisa ser decifrado para restaurar.
- [ ] Antes de liberar acesso ao banco restaurado, reaplicar pedidos de exclusão e expurgo desde
  o backup; cópias antigas não podem reintroduzir dados já apagados. Descartar backups vencidos.
- [ ] Repor certificados, segredos e configurações; validar o relatório de saúde, reproduzir um
  WAV e conferir seu SHA-256 com a linha do tempo. Provar isolamento e fazer chamada com consentimento.
- [ ] Registrar duração real, contagens e diferenças. Declarar recuperação concluída só depois
  dessas comparações. Não usar `install/backup.sh` do banco local para este Compose Supabase.
