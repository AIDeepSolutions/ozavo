---
impact: nothing_changes
section: fixed
title: O agente rápido deixa de cair no provedor reserva depois da primeira consulta de agenda
---

A frase que a ferramenta fala enquanto consulta (por exemplo, "Um instante, estou conferindo a agenda.") entrava no histórico da conversa entre a chamada da ferramenta e o resultado dela. O provedor principal recusava esse formato, e dali em diante cada resposta do agente esperava a recusa e saía do provedor reserva, cerca de 0,9 segundo mais lenta. A frase agora fica junto da mensagem da chamada, e uma rede de segurança reordena qualquer histórico fora de ordem antes de enviá-lo. Nada a configurar. Crédito: @AIDeepSolutions.
