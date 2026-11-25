---
impact: nothing_changes
section: fixed
title: O modelo do agente rápido deixa de ficar preso no provedor reserva depois de uma demora
---

Quando o provedor principal demora ou recusa o pedido, o pedido agora sai também para o próximo e vale o que responder primeiro, em vez de ser cortado e refeito. Um provedor que falha duas vezes seguidas fica de fora por 45 segundos e volta depois. Nada a configurar. Crédito: @AIDeepSolutions.
