---
impact: nothing_changes
section: fixed
title: O agente responde mais cedo quando a linha tem ruído e entende melhor quando a frase ainda não acabou
---

Em ligação com ruído de linha, o fim de turno por silêncio de palavras esperava até 1,1 s; agora pede o texto pendente junto com a espera e fecha pelo prazo da classe da frase (frase completa em ~0,6 s, frase aberta em ~0,85 s). O classificador passou a reconhecer "Eu gostaria de fazer", "automatizar alguma" e "no meu" como frases abertas, e "arroba e-mail ponto com" como e-mail completo (antes esperava como frase aberta). A linha do tempo ganhou a classe da frase que fechou o turno e, quando a pessoa volta a falar logo depois, o tempo que ela levou. Nada a configurar. Crédito: @AIDeepSolutions.
