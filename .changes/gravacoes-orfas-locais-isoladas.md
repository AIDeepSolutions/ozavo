---
impact: nothing_changes
section: fixed
title: Um arquivo de gravação órfão com erro não interrompe a limpeza dos demais
---

Na manutenção das gravações, quando um arquivo local sem chamada no banco não podia ser apagado, os órfãos seguintes ficavam sem ser tentados e os que já tinham saído não entravam na contagem do registro de privacidade. Agora cada arquivo é tentado, o que saiu é contado e auditado, e a falha volta à fila para nova tentativa no fim. Crédito: @AIDeepSolutions.
