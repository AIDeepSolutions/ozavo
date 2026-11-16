# Produção Supabase e proteção das gravações

Decisão do operador em 16/11/2026, registrada em STATUS e reiterada na tarefa da Fase 4.

Esta instalação usa Supabase. `deploy/docker-compose.supabase.yml` é uma composição independente,
sem serviço ou volume Postgres e sem migration na partida. O Compose comunitário conserva o banco
local para quem instala o projeto original. Isto é a exceção autorizada ao antipadrão 6.
A mudança não aplica nada no banco remoto nem implanta a composição.

As conexões de aplicação, sistema e migration continuam distintas. O papel de aplicação tem RLS;
o de sistema atravessa organizações nos caminhos já auditados. LISTEN usa a conexão de aplicação (`DATABASE_URL`): ela também requer conexão direta ou
pooler em modo sessão (5432), nunca o pooler transacional (6543). Todas as URLs geradas exigem
`sslmode=verify-full`. Não se deve usar o papel de dono do banco para a aplicação.

No Asterisk 20 o equivalente a `export` do FreeSWITCH é a herança com prefixo `__`, seguida de um
handler na perna discada. `Set` de `CALLERID` nessa perna é necessário para PJSIP gerar PAI; não é
uma variável local usada para tentar transportar a identidade. Não se usa uma aplicação `Export`,
que não existe nessa pilha. A identidade vem da linha da organização, não do PAI recebido.
Fontes técnicas consultadas em 16/11/2026:
[herança](https://docs.asterisk.org/Configuration/Dialplan/Variables/Channel-Variables/Variable-Inheritance/),
[handler de pré-discagem](https://docs.asterisk.org/Configuration/Dialplan/Subroutines/Pre-Dial-Handlers/).

Linhas novas usam TLS/SRTP. A migration preserva UDP nas linhas já instaladas, evitando trocar o
protocolo de uma operadora sem homologação. A composição Supabase só contém o transporte TLS:
converter as linhas legadas pela tela é condição para colocá-la em produção. Não há fallback UDP
nessa composição. O instalador comunitário conserva ambos os transportes.

O prazo do áudio passa a ser independente do texto, de 90 a 3650 dias, com padrão de 90. A tela
confirma a redução nomeando o acervo e o prazo. O expurgo é diário via fila; não usa polling.
A base legal e o aviso aos titulares são responsabilidade da organização controladora; esta entrega
implementa a política de retenção solicitada, sem declarar homologação regulatória.

Áudio novo é cifrado antes da primeira escrita, em blocos AES-256-GCM autenticados, com chave
derivada por organização/chamada. O WAV só existe em memória durante a gravação e ao reproduzir.
O hash público continua sendo do WAV exportado, não do envelope cifrado. A rotina converte WAVs
legados progressivamente sem temporário em claro e preserva a idade do arquivo. A leitura em fluxo
preserva chamadas longas sem carregar o áudio inteiro; transcrição continua sujeita ao limite do
provedor antes de ler o arquivo completo.

O disco cifrado é a fonte para reprodução; S3/MinIO recebe uma cópia cifrada diária, por organização
e chamada. Perda do disco exige restauração dessa cópia antes da reprodução (RPO de até 24 horas).
Não é armazenamento ativo com leitura remota transparente. Exclusão do titular também apaga a
cópia; gravação legada nunca é enviada em claro. Backups externos não são expurgados pelo aplicativo.
Nenhuma impressão vocal, embedding biométrico ou identificação do interlocutor pela voz é permitido.

O perfil MinIO local usa um espelho não oficial fixado por digest (ver CREDITS), pois os repositórios
oficiais recusaram leitura pública em 16/11/2026. Ele fica sem portas públicas. A liberação de produção
precisa avaliar a procedência e a manutenção desse binário ou selecionar S3 mantido. As credenciais
de armazenamento chegam só às rotinas e ao inicializador administrativo, nunca ao painel/voz.
