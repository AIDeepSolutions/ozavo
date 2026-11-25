---
impact: nothing_changes
section: changed
title: Exceção temporária de SIP por UDP restrita a um servidor de operadora na produção
---

O preparo de produção aceita `temporaryUdpHost`: só a linha desse servidor pode ficar sem TLS,
e a porta 5060/udp só é publicada com ele. Sem o campo, a produção segue só TLS. Quem já instalou
não precisa fazer nada.
Crédito: @AIDeepSolutions.
