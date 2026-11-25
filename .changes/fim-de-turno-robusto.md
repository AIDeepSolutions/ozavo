---
impact: nothing_changes
section: fixed
title: O agente fecha o turno de quem ligou mais cedo quando a linha tem ruído
---

Em uma ligação real, 7 de 23 turnos esperaram cerca de 1,25 segundo para o agente responder porque um sinal que não é palavra (o aviso de início de fala do provedor de transcrição, que o ruído da linha dispara logo depois do texto final) cancelava o fim de turno já decidido. Agora esse aviso não cancela uma pausa confirmada pelo áudio, e uma rede de segurança fecha o turno quando as palavras param de chegar. "Tem como?" e perguntas curtas parecidas passam a contar como frase completa. A linha do tempo mostra o que fechou cada turno. Nada a configurar. Crédito: @AIDeepSolutions.
