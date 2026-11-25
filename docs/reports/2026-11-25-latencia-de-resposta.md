# Latência de resposta do agente em pipeline: medidas de 25/11/2026

Medido na VPS de desenvolvimento (não no servidor de produção), pela bancada `scripts/bancada-latencia/`: uma ligação inteira de teste pelo motor do produto
(`connectPipeline`: Deepgram, OpenRouter e Cartesia reais), sem telefone e sem ligar para ninguém. Quem liga é áudio sintético (Cartesia, voz
Rafael) enviado em tempo real, em quadros de 20 ms. Agente: perfil E (DeepSeek V4.1 Flash), voz Felipe, prompt da AI Deep Solutions com a base
real (~7,2 mil tokens no DeepSeek) e 2 ferramentas. 18 falas (12 na rodada final com voz real), incluindo os casos de frase cortada.
**"Percebido" = do fim real da fala (último quadro com voz enviado) ao primeiro som do agente.** Gasto total dos testes: ≈ US$ 1,23 (teto 1,50),
estimado por componente (o saldo do OpenRouter não serve: outras sessões gastam na mesma chave).

## Resumo

- **O número que o registro mostrava estava errado.** O `turn_latency` contava a partir da chegada do último texto da Deepgram, que vem 0,3 a
  0,6 s depois de a pessoa parar. Do fim real da fala, o agente "Nico (deepseek)" levava **~1,3 a 1,5 s** (p50 1,52 s, p90 1,93 s, medido na `main`
  antes destes PRs, voz real), e não 0,75 a 0,9 s. Hoje o registro conta do fim real e traz as etapas.
- **Tempo percebido: 1,52 s → 0,39 s (p50), p90 1,93 s → 0,43 s**, com tudo ligado e voz real (meta ≤ 0,5 s: **atingida com a ponte**).
- **Total honesto sem a ponte (o texto da resposta de verdade): 0,88 s (p50), 1,05 s (p90).** A meta de 0,5 s **não** é atingível sem a ponte
  com este desenho: 0,35 s de fim de turno + 0,2 s de modelo + 0,26 s de voz já somam ~0,82 s. A ponte esconde o intervalo, não o elimina.
- O ganho grande vem do **fim de turno pela pausa**: −0,46 s no p50 e some a cauda de 5 a 6 s. A especulação e o aquecimento valem pouco; a
  ponte é o que leva o percebido abaixo de 0,5 s.

## Tabela antes/depois por técnica

Rodadas simultâneas (mesmas condições de rede), TTS simulado a 265 ms (o TTFB medido da Cartesia real) para custar centavos; cada linha acrescenta
a técnica à anterior. Em ms.

| Configuração | Percebido p50 | p90 | média | Resposta (sem ponte) p50 / p90 | Frases cortadas |
|---|---|---|---|---|---|
| Antes (fim de turno só pelo `speech_final`, sem especulação nem ponte) | 1.315 | 5.535 | 2.113 | 1.354 / 5.614 | 2 (os casos "E quais são suas…" e "Hum, deixa eu pensar…") |
| + fim de turno pela pausa e `Finalize` | **851** | 1.008 | 834 | 892 / 981 | 2 (outros: "Tá bom, obrigado, até logo", pausa de ~400 ms no meio) |
| + pedido adiantado ao modelo | 822 | 1.021 | 888 | 870 / 1.079 | 1 |
| + frase de ponte e aquecimento (tudo), voz real | **392** | 433 | 422 | 878 / 1.052 | 0 (12 falas) |

Voz real de ponta a ponta, antes e depois: `main` antes dos PRs, 18 falas: p50 1.515 / p90 1.926 (2 falas de 6,6 s). Tudo ligado, 12 falas: p50 392 / p90 433.

### O que cada técnica fez

1. **Fim de turno pela pausa (4).** A Deepgram entrega o `speech_final` 525 a 660 ms depois do fim da fala; um `Finalize` mandado 100 a 120 ms
   depois do silêncio devolve o texto em 323 a 385 ms. Etapa "fim de turno" (do fim real da fala ao pedido ao modelo): **~720 ms → ~350 ms**. Tira
   também a cauda: com siglas ("ERP e CRM", dado ditado) o `speech_final` levava **5,4 a 5,6 s** em 3 de 18 falas; com o `Finalize` nenhuma passou de 1 s.
   O prazo agora é silêncio total desde o fim real, por classe do texto (fechada 350 ms, curta 300, sem pontuação 500, aberta 1.000, dado ditado
   900, hesitação 1.200). Frase terminada em artigo, preposição, conjunção ou possessivo fica aberta **mesmo com "?"** (a Deepgram pontua sozinha:
   "E quais são suas?"). Com 150 ms de piso a pausa entre duas frases seguidas já fechava o turno; 300 a 350 ms foi o piso que a bancada aceitou.
2. **Especulação (3).** O pedido ao modelo sai quando a pausa foi vista e a frase parece fechada, antes do prazo de segurança; aproveitado se o
   texto e o histórico não mudam. Acertos: **18 de 18** (ablação) e 11 de 12 (final); descartes: 0 e 1. O ganho é de ~30 ms no p50 (o prazo de segurança
   que sobra depois do `Finalize` é de ~40 ms), e o desperdício foi uma chamada em 30. **Os parciais da Deepgram não servem para adiantar mais:** o último
   parcial chega 130 a 600 ms antes do fim da fala e sem as últimas palavras (nenhum bateu com o final), então só o texto do `Finalize` é confiável.
3. **Ponte (2).** Frases curtas pré-sintetizadas com a voz do agente (Certo., Tá bom., Ok.; faixa longa: Um instante., Deixa eu ver., Só um instante.), uma
   por vez, guardadas no processo por voz e idioma (~60 caracteres por voz, US$ 0,004, uma vez). O silêncio das pontas do áudio (100 a 180 ms antes,
   ~100 ms depois) é aparado: sem isso a ponte tocava 160 ms depois de emitida e o texto da resposta esperava atrás dela (+0,5 s). Com 100 ms de espera
   por padrão (`bridgeAfterMs`), ela toca em quase todo turno com o DeepSeek (primeiro texto em ~0,2 s, depois do pedido). A espera de 350 ms que o pedido
   sugeria quase nunca dispararia com o DeepSeek e deixaria o percebido em ~0,85 s: foi trocada por 100 ms para cumprir a meta de 0,5 s. Com o Haiku (primeiro
   texto em 0,6 s) o disparo é adaptativo de fato. Nunca toca depois de pergunta de confirmação de agenda nem no turno que continua um resultado de ferramenta.
4. **Aquecimento (1).** Uma chamada mínima (`max_tokens` 4) com o mesmo prefixo ao abrir a ligação. **Efeito pequeno nesta bancada:** DeepSeek, primeiros
   dois turnos 1.114 / 1.487 → 1.045 / 1.617 ms (sem ganho; o provedor já faz cache de prefixo sozinho); Haiku (perfil B, base de ~11 mil tokens) 1.809 / 1.824
   → 1.630 / 1.752 ms (−180 / −70 ms; modelo no 1º turno 677 → 616 ms). Custo: ~US$ 0,0003 por ligação. Fica ligado por ser barato, mas não é onde está o ganho.
   Deepgram e Cartesia já abrem os WebSockets na conexão, antes de o agente falar (a Deepgram recebe `KeepAlive` a cada 4 s; a Cartesia ganhou um ping a cada 20 s).
5. **Prefixo estável (5).** Instrução, vocabulário, idioma e estilo de telefone vêm primeiro; o contexto do pedido de saída (varia por ligação) vai por
   último; ferramentas na mesma ordem. `cache_control` já ia ao Haiku (`acceptsCacheControl`); o DeepSeek faz cache de prefixo sozinho.
6. **Provedores (6): achado de bug.** O motor sempre mandava o modelo explícito, e `chatBody` só juntava `provider.order` quando o modelo não vinha explícito:
   **a ordem dos perfis D e E nunca chegou ao OpenRouter**, e "Nico (deepseek)" rodava no roteamento padrão (provedores como Relace, InferenceNet, DigitalOcean). Sonda
   de 6 chamadas por configuração, prompt de 7,2 mil tokens: padrão (sem ordem) p50 643 ms, **máx 3.955 ms**; `order: together` p50 356 / máx 588; só Together 302 / 436; só Wafer
   428 / 505; só Reka 422 / 825; só InferenceNet 485 / 835. Corrigido; ordem DeepSeek: Together, Wafer, Reka; gpt-oss: Cerebras, Groq, BaseTen. Novo: se o provedor da vez não
   entrega nada em 800 ms, o pedido é cortado e refeito no próximo (o último não tem limite). Na rodada final, 11 de 12 turnos vieram do Together.
7. **Síntese (7).** A primeira frase vai à Cartesia assim que fecha: mediana de **33 a 42 ms** depois do primeiro texto (p90 47 a 84 ms). Não há o que ganhar encurtando a primeira
   frase (teto de ~35 ms, com risco de prosódia picada); mantido como está. A Cartesia segue em fluxo (`continue`) na mesma conexão.

## Linha do tempo (8)

`turn_latency` traz `rttMs` (primeiro som, ponte inclusa), `answerMs` (texto da resposta, sem a espera da ponte), `endpointMs`, `modelMs`, `firstSentenceMs`, `ttfbMs`, `provider`, `bridge`,
`speculation` (`hit`/`miss`) e `retries`. `llm_call` ganhou `purpose` (`warmup`, `speculative`, `retry`) e `firstTokenMs`. Eventos antigos continuam legíveis.

## Limites do que foi medido

- Uma VPS, um prompt, uma voz sintética de quem liga, DeepSeek; pausa e prosódia de gente de verdade são mais variadas que o áudio sintético. Uma frase de duas orações com pausa
  ~400 ms ("Tá bom, obrigado, até logo") ainda corta com piso de 350 ms: é o preço do prazo curto, e quem fala devagar pode ser cortado; o prazo é o que se ajusta se a ligação real
  mostrar isso.
- As rodadas de ablação usam TTS simulado (265 ms); só a final usa a Cartesia real. A qualidade do áudio das frases de ponte **não foi ouvida**: precisa do ouvido do dono.
- O TTFB da Cartesia (~255 a 375 ms) e o fim de turno (~350 ms) são o piso: sem a ponte o total honesto fica perto de 0,85 s.
- Não medido: servidor de produção (Hostinger), Anthropic/Cerebras/Groq direto, carga simultânea. Ligação real pelo SIP continua bloqueada (causa de a chamada cair em 2 s aberta).

## Como reproduzir

`DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY` e `CARTESIA_API_KEY` no ambiente; `pnpm tsx scripts/bancada-latencia/run.ts --label x --profile e --base-file <base de conhecimento em JSON [{name,text}]> --flags '{"bridge":false}' [--fake-tts] [--turns 12]`. A base de conhecimento e os resultados brutos ficam fora do repositório. `sondar-stt.ts` mede quando cada parcial e final da Deepgram chega.
