---
impact: nothing_changes
section: fixed
title: O apagamento a pedido do titular tira também o contexto do lead que a API de saída gravou
---

Quando um sistema de fora pede uma ligação pela API, os dados do lead e do motivo ficam guardados na chamada para o agente usar. O apagamento a pedido do titular limpava o resumo, a transcrição e os telefones, mas deixava esse contexto, que pode ter nome, e-mail ou documento da pessoa. Agora ele sai junto, e a exportação dos dados do titular passa a incluí-lo enquanto existir. Crédito: @AIDeepSolutions.
