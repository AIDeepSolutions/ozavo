---
impact: nothing_changes
section: fixed
title: "Falar com o agente" conecta na instalação pelo Coolify
---

No Compose da voz para o Coolify, o caminho `/voice-ws` do domínio do painel passa a chegar à voz (porta 8091). Antes o painel respondia 404 ao WebSocket e a tela ficava em "Conectando" até a chamada fechar sozinha. Crédito: @AIDeepSolutions.
