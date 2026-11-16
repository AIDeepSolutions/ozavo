---
impact: nothing_changes
section: added
title: A rota de saúde responde 503 quando uma peça falha, para monitores que só olham o código HTTP
---

A saúde do sistema sempre respondia 200 e dizia a falha só no corpo, então um monitor de uptime via a central no ar mesmo sem o processo de voz. Com `?strict=1` no endereço `/api/v1/system/health`, qualquer peça em falha faz a resposta sair com 503, e o corpo continua o mesmo relatório. Sem o parâmetro, nada muda. Aponte o monitor externo para o endereço com `?strict=1`. Crédito: @AIDeepSolutions.
