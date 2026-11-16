---
impact: operator_action
section: added
title: Produção Supabase com SIP protegido e prazo próprio do áudio
---

A composição de produção reúne painel, voz, rotinas, Asterisk, Caddy e armazenamento MinIO/S3
com banco Supabase. Novas gravações são cifradas antes da escrita; o áudio tem prazo próprio de
90 dias, ajustável pela tela, e expurgo automático. A Linha passa a cadastrar o nome RCD e a
converter o logo para homologação. Crédito: @AIDeepSolutions.

## Requer atenção

Aplique a migration do ramo somente após revisão. A composição Supabase não executa migrations
na partida e exige conexão de sessão para a fila. Conserve a chave de cifragem da instalação e
prove a restauração do banco e dos áudios. Converta linhas legadas para TLS/SRTP antes de usar
essa composição e homologue PAI/RCD com a operadora. O perfil MinIO referencia um espelho não
oficial fixado por digest; sua procedência e manutenção precisam ser avaliadas na liberação.
O roteiro completo está em docs/guides/producao-fase4.md. Não houve implantação desta mudança.
