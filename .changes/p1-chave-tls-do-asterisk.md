---
impact: nothing_changes
section: fixed
title: A chave privada do SIP sobre TLS deixa de ser legível por outros usuários da VPS, e o certificado se renova sozinho
---

O instalador gravava a chave do certificado do SIP sobre TLS com leitura para qualquer usuário da máquina. Agora ela fica só para o Asterisk, e a próxima atualização fecha a chave de quem já instalou. O certificado de 365 dias é trocado pela instalação ou pela atualização quando faltam menos de 30 dias, e a checagem de saúde ganha a linha "Certificado TLS", que avisa antes do vencimento. Se o instalador não conseguir passar a chave ao usuário do Asterisk, ele avisa com o comando exato. Crédito: @AIDeepSolutions.
