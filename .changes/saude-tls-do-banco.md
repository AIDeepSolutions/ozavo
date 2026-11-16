---
impact: nothing_changes
section: added
title: A saúde acusa banco fora do servidor sem TLS verificado
---

A linha do banco na saúde do sistema agora lê como o painel chega ao banco. Banco na mesma máquina ou na rede privada (o Postgres do Compose) segue como antes. Banco em outro servidor sem TLS vira falha, porque senha e dados de cliente atravessam a rede em texto puro; com TLS mas sem `sslmode=verify-full` (ou `verify-ca`), vira aviso. A conferência vale para a conexão de aplicação e para a de sistema. Crédito: @AIDeepSolutions.
