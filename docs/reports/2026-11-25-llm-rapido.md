# LLM mais rápido para o Nico: medição de 25/11/2026

Tarefa de medição, sem mudar produção. Medido nesta VPS, pela chave do OpenRouter do cofre, com o prompt do Nico (clínica fictícia, ~1.500 tokens de sistema + 4 ferramentas, ~2.400 tokens de entrada) e 10 conversas curtas de atendimento. Gasto total da bancada: cerca de US$ 0,30 (teto: US$ 2).

## Resumo

- **O Haiku 5.5 não fica abaixo de 0,5 s com nenhum ajuste de provedor.** Aqui ele dá TTFT mediana de 0,58–0,60 s e 1ª frase em 0,73–0,76 s (menos que os 0,75–1,0 s dos logs reais, porque a bancada tem contexto curto e rede diferente). Os cinco provedores, `:nitro` e `sort` por latência ou vazão ficaram todos entre 0,59 e 0,68 s, exceto o Vertex (1,24 s).
- **(a) Existe modelo mais rápido?** Sim, e dois chegam a ≤ 0,5 s de modelo com qualidade aceitável: **DeepSeek V4.1 Flash pela Together (TTFT 0,28 s, 1ª frase 0,31 s)** e **gpt-oss-120b pela Cerebras (0,37 s)**. O nemotron-3.5-lightning é o mais rápido (0,20 s), mas erra mais.
- **(b) Anthropic direto?** O provedor "Anthropic" do OpenRouter foi igual ao AWS (0,59 contra 0,61 s) e o `p50` dele nos últimos 30 min é o segundo pior. Não há chave da Anthropic no cofre, então a API direta **não foi medida**; não há motivo para ela ganhar do que o OpenRouter já roteia para os mesmos servidores. Hipótese descartada.
- **Cache de prompt não acelera nada.** Funciona (a partir de ~2.300 tokens de entrada, prompt + ferramentas) e corta o custo em ~80%, mas o TTFT é o mesmo (590 contra 587 ms).
- **Nenhum modelo rápido iguala o Haiku em qualidade.** O Haiku acertou 30/30 ferramentas; o melhor rápido (DeepSeek) 29/30, com pt-BR um pouco menos natural. Por isso a recomendação é um perfil, testado ao vivo, e não troca do padrão.

## Tabela principal (3 passadas × 10 conversas = 30 amostras por linha)

TTFT: até o 1º token (texto ou chamada de ferramenta). 1ª frase: até a primeira frase completa pela regra do `splitPoint` (ou o fim da chamada da ferramenta, nos turnos com ferramenta). Qualidade: "Tool certa" = ferramenta esperada chamada (ou nenhuma, quando não devia); "Regras" = até 160 caracteres, sem markdown/emoji, conteúdo exigido presente; notas 1–5 do juiz (Claude Sonnet 5.5, esforço baixo) sobre a 1ª passada (10 respostas), em pt-BR natural, respeito ao prompt e ausência de invenção.

| Config | TTFT med/p90 (ms) | 1ª frase med/p90 (ms) | Tool certa | Regras | pt-BR | Prompt | Alucin. | Geral | US$/1k chamadas |
|---|---|---|---|---|---|---|---|---|---|
| haiku-B-padrao | 603 / 762 | 761 / 890 | 30/30 | 30/30 | 4.3 | 4.9 | 5.0 | 4.9 | 0.09 |
| haiku-prov-AWS | 583 / 649 | 728 / 847 | 30/30 | 30/30 | 4.3 | 4.5 | 4.9 | 4.5 | 0.09 |
| nemotron-3.5-lightning | 195 / 332 | 289 / 355 | 27/30 | 28/30 | 3.8 | 4.1 | 5.0 | 4.3 | 0.08 |
| deepseek-v4.1-flash@Together | 282 / 435 | 309 / 504 | 29/30 | 30/30 | 4.1 | 4.1 | 4.9 | 4.3 | 0.11 |
| gpt-oss-120b@Cerebras | 366 / 576 | 366 / 576 | 27/30 | 29/30 | 3.6 | 4.5 | 5.0 | 4.4 | 0.46 |
| gpt-oss-120b@Cer>Groq>Base | 358 / 448 | 358 / 448 | 27/30 | 30/30 | 3.6 | 4.3 | 4.8 | 4.2 | 0.46 |
| gpt-oss-120b@Groq | 426 / 949 | 459 / 973 | 27/30 | 28/30 | 3.8 | 4.0 | 5.0 | 4.0 | 0.15 |
| gpt-oss-20b@Groq | 438 / 567 | 443 / 578 | 27/30 | 29/30 | 3.6 | 3.8 | 5.0 | 3.9 | 0.09 |
| granite-4.2-8b@CoreWeave | 400 / 2451 | 858 / 2451 | 21/30 | 24/30 | 3.5 | 3.6 | 4.1 | 3.6 | 0.04 |
| gemini-2.5-flash(atual C) | 473 / 1293 | 570 / 1293 | 23/30 | 30/30 | 4.1 | 4.0 | 5.0 | 4.1 | 0.32 |
| glm-5.3-flash-low | 688 / 1420 | 801 / 1469 | 29/30 | 30/30 | 4.1 | 4.3 | 4.9 | 4.4 | 0.10 |
| sonnet-5.5-low | 722 / 1758 | 999 / 1895 | 30/30 | 30/30 | 4.4 | 4.8 | 5.0 | 4.9 | 1.39 |

Linhas `haiku-B-padrao` e `haiku-prov-AWS` são o mesmo modelo: a diferença de nota do juiz (4,9 contra 4,5) mostra o ruído do juiz, cerca de ±0,4. Diferenças menores que isso entre modelos não são conclusão.

Os provedores usados: Cerebras, Groq e BaseTen (gpt-oss), Together (DeepSeek), CoreWeave (granite), Cerebras/Groq conforme o roteamento. O custo por 1.000 chamadas é o `usage.cost` do próprio OpenRouter, com o prompt de ~2.400 tokens.

## Triagem (1 passada, 10 amostras) e provedores do Haiku

|---|---|---|
| haiku-B-padrao | 603 | 780 |
| haiku-prov-Anthropic | 590 | 726 |
| haiku-prov-AWS | 612 | 758 |
| haiku-prov-Vertex | 1241 | 1247 |
| haiku-prov-Azure | 678 | 853 |
| haiku-prov-Bedrock | 621 | 793 |
| haiku-nitro | 594 | 760 |
| haiku-sort-latency | 587 | 739 |
| haiku-sort-throughput | 587 | 775 |
| gemini-2.5-flash(atual C) | 455 | 560 |
| gemini-3.1-flash-lite | 1118 | 1138 |
| gpt-oss-120b@Groq | 582 | 600 |
| gpt-oss-120b@Cerebras | 373 | 394 |
| gpt-oss-120b@BaseTen | 465 | 606 |
| gpt-oss-120b@sort-latency | 538 | 665 |
| gpt-oss-20b@Groq | 450 | 458 |
| llama-3.3-70b@Groq | 509 | 537 |
| llama-3.3-70b@CoreWeave | 313 | 579 |
| gpt-4.1-mini | 851 | 986 |
| gpt-5.4-nano | 954 | 1055 |
| qwen3.8-flash | 990 | 1349 |
| mistral-small-2603 | 1014 | 1154 |
| deepseek-v4-flash | 840 | 850 |
| granite-4.2-8b | 313 | 656 |
| granite-4.2-8b@CoreWeave | 303 | 603 |
| granite-4.2-8b@DeepInfra | 397 | 573 |
| gemini-3.5-flash-lite-low | 1080 | 1160 |
| gemini-3.8-flash-low | 2777 | 3084 |
| glm-5.3-flash-low | 662 | 886 |
| sonnet-5.5-low | 754 | 1236 |
| gemini-2.5-flash-lite-ai | 369 | 421 |
| gpt-oss-120b@Cer>Groq>Base | 379 | 379 |
| nemotron-3.5-lightning | 279 | 356 |
| deepseek-v4.1-flash@Together | 276 | 321 |
| deepseek-v4.1-flash@Reka | 447 | 776 |
| ministral-8b | 761 | 762 |
| mistral-small-2603@Mistral | 830 | 957 |

Observações da triagem:
- Os Gemini 3.x (3.5-flash-lite, 3.8-flash) e o GLM 5.3 e o Sonnet 5.5 recusam raciocínio desligado; com esforço baixo ficaram em 1,1 s, 2,8 s, 0,66 s e 0,75 s.
- gemini-2.5-flash-lite (0,37 s) e llama-3.3-70b na Groq tomaram HTTP 429 do provedor em parte das chamadas; não entraram na rodada final.
- Granite 4.2 8B: existe (`ibm-granite/granite-4.2-8b`, 131.072 tokens de contexto, US$ 0,06/0,15 por milhão, `tools`, streaming e `reasoning` suportados, provedores CoreWeave e DeepInfra). TTFT 0,30–0,40 s, mas a **1ª frase só em 0,6 s** (63 tokens/s) e p90 de 2,45 s. Qualidade fraca: 21/30 chamadas certas (não chamou `agenda_horarios_livres` nem `transfer_to_human` quando devia), respostas de 226–315 caracteres (o limite é 160), markdown, e nota de invenção 4,1. **Não serve como modelo principal. Como "modelo de ponte" também não compensa:** a frase de ponte não precisa de modelo (ver abaixo), e para roteamento ele erra a decisão que importa (chamar ferramenta).
- O `p50` do OpenRouter (143 ms no Granite, 65 ms no nemotron) não bate com a VPS: a latência do OpenRouter não conta a rede nem a geração até a primeira frase.

## Prompt cache

- Nos logs reais: 0 token em cache com 351–1.800 tokens de entrada. O mínimo cacheável do Haiku está entre 1.800 e 2.372 tokens (provável 2.048, não isolado); abaixo disso `cache_control` é aceito e ignorado, sem erro.
- Medido com o prompt do Nico + ferramentas: 2.372 tokens → 2.281 lidos do cache na 2ª chamada; 3.176, 3.974, 4.776 e 5.976 também. 1ª chamada grava, as seguintes leem.
- Ganho: **custo**, não latência. Com 4.773 tokens: US$ 0,00011 por chamada com cache contra US$ 0,00053 sem; TTFT 590 contra 587 ms.
- Conclusão: não vale inflar o prompt para chegar ao mínimo. O Haiku a US$ 0,10/M de entrada custa ~US$ 0,24 por mil chamadas só de entrada num prompt de 2.400 tokens.

## Ganhos que não dependem do modelo (ordem de ganho esperado)

1. **Frase de ponte imediata, sem modelo.** Falar uma frase fixa pronta ("Um instante.", "Deixa eu ver.") assim que a pessoa termina, enquanto o modelo pensa, esconde 0,6–1,0 s sem tocar na qualidade. Só deve falar nos turnos em que o modelo vai chamar ferramenta ou demorar; a decisão pode vir da regra do último turno (pergunta de agenda). Já existe `ctx.say` nas ferramentas de agenda ("Um instante, estou marcando"). Não medido ao vivo.
2. **Geração especulativa durante a pausa do Deepgram.** Começar o modelo no `speech_final` provisório (ou no texto parcial estável) e cancelar se a pessoa continuar. Poupa o prazo de endpointing (100–400 ms) em boa parte dos turnos; custa chamadas desperdiçadas. Não implementado nem medido.
3. **Cortar o prompt de sistema e das ferramentas.** O Haiku não ficou mais rápido com 6.000 tokens do que com 2.400 (590–630 ms), então o efeito no TTFT é pequeno nesse tamanho; o ganho está em custo e em modelos de menor throughput.
4. **Iniciar a síntese na 1ª frase.** Já é o que o `splitPoint` faz (frase ≥ 10 caracteres, vírgula ≥ 24 no 1º trecho). A bancada confirma o efeito: a 1ª frase do Haiku sai ~0,15 s depois do TTFT; nos modelos de resposta mais enxuta (gpt-oss, DeepSeek) quase junto.
5. **`max_tokens`.** Já é 400. Não afeta TTFT; só limita corte e custo.
6. **Aquecer a conexão.** A 1ª chamada de cada config foi descartada como aquecimento; no telefone a conexão TLS ao OpenRouter pode ser mantida aberta entre os turnos (já é o padrão do `fetch`, mas vale conferir no servidor de produção).

## Recomendação

Meta: **≤ 0,5 s de modelo até a 1ª frase.**

1. Mantenha o Haiku 5.5 como padrão: nada de provedor ou cache o leva abaixo de ~0,6 s, e o melhor roteamento é o que já está (AWS). Não force "Anthropic".
2. Para chegar à meta, teste ao vivo dois perfis novos, que a Empresa Demo já terá lado a lado com o Nico (teste), Haiku perfil B:
   - **D: gpt-oss-120b (Cerebras > Groq > BaseTen, raciocínio baixo)**: 1ª frase 0,36 s, p90 0,45 s com reserva de provedor. Qualidade: 27/30 ferramentas (errou o `agenda_marcar` antes da confirmação, que a trava de autorização do código já recusa sem gravar), pt-BR 3,6 contra 4,3 do Haiku. Custo 5× o do Haiku com cache, pelo preço do Cerebras.
   - **E: DeepSeek V4.1 Flash pela Together (raciocínio desligado)**: 1ª frase 0,31 s, p90 0,50 s, 29/30 ferramentas, 30/30 regras, pt-BR 4,1. O melhor equilíbrio da bancada. É o que eu escolheria para virar padrão da telefonia se a chamada ao vivo confirmar.
3. Aplique a frase de ponte local e a geração especulativa antes de trocar de modelo: elas valem para qualquer um e não pioram a qualidade.
4. O que decide é a chamada ao vivo: 30 amostras em prompt curto e um juiz automático não substituem ouvir. Meça o `llm_call` da linha do tempo dos dois perfis nas mesmas conversas.

## O que não foi medido e o que falta para medir

- **Anthropic direta**: falta chave (`ANTHROPIC_API_KEY`). Ganho esperado: nenhum (o provedor "Anthropic" pelo OpenRouter já fica a 0,59 s; a API direta só tira um salto de rede de ~20–50 ms, a confirmar).
- **Groq e Cerebras diretos**: faltam chaves. Pelo OpenRouter o Cerebras já entrega 0,37 s; direto poderia tirar o salto do OpenRouter (estimativa de 50–100 ms, não medida). Sem ganho de qualidade.
- **Latência a partir do servidor de produção** (72.60.12.17, Coolify): a medição saiu desta VPS. A ordem entre os modelos deve se manter, os valores absolutos não.
- **Ligação real com áudio**: a bancada mede só o modelo. O total fim-da-fala→1º áudio soma endpointing do Deepgram e ~0,23 s da Cartesia.
- **Vieses**: um juiz de IA, 10 conversas, 1 prompt, 3 repetições por conversa; diferença de 0,4 ponto entre notas é ruído.

Dados brutos: `r1.jsonl` (triagem) e `r2.jsonl` (rodada final) no scratchpad da sessão, `bench.mjs`/`analyze.mjs` como harness. Os scripts leem a chave só do ambiente.
