---
impact: nothing_changes
section: fixed
title: Gravação que não pôde ser lida na limpeza agora aparece como falha
---

Na manutenção das gravações, qualquer erro ao consultar um arquivo (permissão negada, falha de disco) era tratado como se o arquivo não existisse, e ele ficava sem ser apagado e sem aviso. Agora só o arquivo que já sumiu é ignorado; os demais erros entram na lista de falhas da rotina, o arquivo não conta como removido e volta à fila para nova tentativa. Crédito: @AIDeepSolutions.
