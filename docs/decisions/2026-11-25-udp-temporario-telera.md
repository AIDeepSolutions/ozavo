# UDP sem cifra, temporário, só para a linha da Telera

Data: 25/11/2026. Decisor: Macgyver. Estado: **temporária** — revisar até 2026-12-31.

## Contexto

A Telera (tronco do número (11) 5198-1261) responde só SIP por UDP/5060 (medido em 25/11/2026 a
partir da VPS: TCP 5060 e TLS 5061 fechados; REGISTER por UDP com digest: 401, depois 200 OK). A
produção só tinha o transporte TLS. Decisão: aceitar UDP puro **por enquanto**, só para testar a
voz, e tratar o TLS depois.

## O que vale

- `scripts/prepare-production.ts` ganhou `temporaryUdpHost` (um nome de servidor). Só com ele:
  (a) o `pjsip.conf` de produção recebe `deploy/asterisk/pjsip.production.udp-temporario.part`
  (`transport-udp`), (b) o Compose publica `5060/udp` no Asterisk, (c) o `app.env` grava
  `OZAVO_UDP_ONLY_HOSTS=<servidor>`. Sem ele, nada muda: só TLS, e `OZAVO_UDP_ONLY_HOSTS=''`.
- O processo de voz (`renderTrunksConf`) só escreve uma linha com `sip_tls = false` se o servidor
  dela estiver em `OZAVO_UDP_ONLY_HOSTS`. Qualquer outra linha sem TLS é deixada de fora, com o motivo
  na tela da linha. Linhas com TLS não mudam. Instalação comunitária (variável ausente): sem restrição.
- A linha da Telera se cadastra pela tela da linha, **sem** marcar "Proteger sinalização e áudio"
  (modo registro, usuário e senha; credenciais fora do git).

## Risco aceito

Sinalização e áudio (RTP) em claro entre a VPS e a Telera; as credenciais do registro seguem em digest.
Mitigação: limite 5060/udp à origem da Telera no firewall do provedor da VPS (o Compose não filtra por
origem); uma linha só; sem outras exceções.

## Como reverter

1. Refazer o preparo de produção sem `temporaryUdpHost` e reimplantar. Isso tira o `transport-udp`, a
   porta 5060/udp e zera `OZAVO_UDP_ONLY_HOSTS`.
2. Na tela da linha, marcar TLS (ou apagar a linha).
3. Fechar 5060/udp no firewall do provedor.

## Para voltar ao TLS de verdade

A Telera precisa oferecer SIP/TLS (5061 ou outra porta) e SRTP, ou o tráfego passa por um proxy SIP
com TLS na ponta da Telera (por exemplo, um Kamailio/stunnel só com a Telera por UDP numa rede privada).
Pendente com a Telera: TLS/SRTP, IPs de origem, limite de canais e CPS, PAI/RCD em E.164.
