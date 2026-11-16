---
impact: new_capability
section: added
title: Motor de voz em pipeline com Deepgram, OpenRouter e Cartesia
---

Um quarto motor de voz aparece na escolha do agente: a Deepgram (Nova-3) ouve em português, um modelo do OpenRouter responde e usa as ferramentas do agente, e a Cartesia (Sonic 3.6) fala, com uma das vozes em português dela escolhida no agente. Quem liga pode falar por cima do agente, que para na hora; o agente espera mais quando a frase ficou no meio e responde logo quando ela fechou; e o motor reconhece caixa postal nos primeiros segundos. O custo de cada parte entra no custo da chamada e no teto. A chave do motor é um texto com as três chaves (`{"deepgram": "...", "cartesia": "...", "openrouter": "..."}`), guardado cifrado como as outras. Nada muda em instalações existentes: os motores atuais continuam como estão. A voz ainda não foi testada numa ligação real. Crédito: @AIDeepSolutions.
