---
impact: nothing_changes
section: changed
title: O agente em pipeline responde bem mais rápido: fim de turno pela pausa, aquecimento, frase de ponte e provedores com nova tentativa
---

No motor Deepgram + OpenRouter + Cartesia, o fim do turno de quem ligou passa a ser decidido pela pausa vista no áudio, com o texto pedido à Deepgram na hora (cerca de 0,3 s depois do fim da fala, em vez de 0,6 s ou mais), e frase que termina em artigo, preposição ou possessivo ("E quais são suas...") não fecha o turno. O pedido ao modelo pode sair um instante antes de o turno fechar, e é descartado se a pessoa continuar. Quando a ligação abre, o modelo é aquecido com o mesmo prefixo, e se ele demora para o primeiro texto o agente diz uma frase curta, pré-gravada com a voz dele ("Certo.", "Um instante."), que nunca toca antes de uma confirmação de agenda. A ordem de provedores dos perfis rápidos, que o motor não chegava a enviar, passa a valer, com nova tentativa no provedor seguinte se o primeiro não responde em 800 ms. A linha do tempo mostra o aquecimento e a latência de cada turno por etapa, contada do fim real da fala. Crédito: @AIDeepSolutions.
