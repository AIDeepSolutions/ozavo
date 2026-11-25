---
impact: new_capability
section: added
title: O agente de voz usa a base de conhecimento na ligação
---

O agente que tem bases prontas passa a respondê-las na ligação. Com a base pequena (modo automático), ela vai inteira numa seção fixa do prompt, idêntica entre turnos e entre ligações, para o cache do provedor acertar. Com a base maior, o motor em pipeline busca, a cada fala de quem ligou, os 4 trechos mais próximos (palavras e vetor), já enquanto a pessoa fala, e só espera a busca até 100 ms; se o vetor atrasar ou falhar, segue só com as palavras, e se a busca falhar, responde sem os trechos, sempre com o motivo na linha do tempo. Falas curtas (ok, sim, tchau, números) não pedem busca, e "responder só pela base" manda dizer que não tem a informação e oferecer recado ou transferência. A linha do tempo mostra o modo carregado e, em cada resposta, fonte, seção e pontuação dos trechos usados, sem o texto; o embedding da pergunta entra no custo da ligação. Agente sem base não muda em nada. Crédito: @AIDeepSolutions.
