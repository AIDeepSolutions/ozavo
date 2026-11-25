# 0023: Latência de resposta do agente em pipeline

- **Estado:** aceita (em andamento: cada marco entra num PR, e esta página cresce com eles)
- **Data:** 2026-11-25
- **Quem decidiu:** o dono do projeto, em 25/11/2026: "tudo que for melhorar a latência de resposta do agente pode aplicar".
- **Medidas:** [`docs/reports/2026-11-25-latencia-de-resposta.md`](../reports/2026-11-25-latencia-de-resposta.md) e `scripts/bancada-latencia/` (a bancada que as produz).

## Contexto

Na chamada de teste do dono com o agente "Nico (deepseek)", o registro de latência dizia 0,74 a 0,82 s do fim da fala ao primeiro
áudio nos turnos quentes e 1,7 s nos dois primeiros. A bancada deste ADR mediu outra coisa: contado do **fim real da fala** (o
último quadro com voz), o primeiro som saía em ~1,5 s com o mesmo perfil. O registro contava a partir da chegada do último texto
da Deepgram, que vem de 0,3 a 0,6 s depois de a pessoa parar.

## Decisões

### Marco 1: medir o que importa e esquentar a partida a frio

1. **O fim da fala é o da pausa vista no áudio.** Um detector de pausa local (5 quadros de 20 ms de silêncio) marca o fim real; o
   `turn_latency` passa a contar dele (`rttMs`) e traz as etapas (`endpointMs`, `modelMs`, `firstSentenceMs`, `ttfbMs`), o provedor
   que respondeu e, nos marcos seguintes, se houve ponte, especulação ou nova tentativa. Eventos antigos seguem legíveis.
2. **Aquecimento na abertura.** Uma chamada ao modelo com o mesmo prefixo da conversa (instrução + ferramentas) e `max_tokens` 4,
   feita enquanto o aviso de gravação e a saudação tocam. O custo entra na conta da ligação (`usage`) e aparece na linha do tempo
   como `llm_call` com `purpose: "warmup"`. Falha de aquecimento não afeta a ligação.
3. **Prefixo estável.** A instrução, o vocabulário, a regra de idioma e o estilo de telefone vêm primeiro; o contexto do pedido de
   saída (que varia por ligação) vai por último. As ferramentas seguem a mesma ordem em todos os turnos.

Os WebSockets da Deepgram e da Cartesia já são abertos na conexão, antes de o agente falar; a Deepgram recebe `KeepAlive` a cada 4 s. A Cartesia não recebe ping: a conexão fica aberta enquanto o provedor a mantiver, e o tempo de inatividade que ele tolera não foi medido. Por isso não há o que pré-abrir aqui.

### Marco 2: o fim de turno pela pausa e o pedido adiantado ao modelo

4. **Fim de turno pela pausa (`fastEndpoint`).** O detector local de pausa (100 ms de silêncio) manda um `Finalize` à Deepgram: o texto
   do que foi dito volta ~0,3 s depois do fim da fala, em vez de ~0,6 s do `speech_final` natural (e sem a cauda de segundos que o
   `speech_final` tem com siglas como "ERP e CRM"). O prazo de fechar o turno passa a ser **silêncio total desde o fim real da fala**,
   por classe do texto (`assessTurnEnd`, em `pipeline/endpointing.ts`): frase fechada 350 ms, resposta curta 300 ms, sem pontuação
   500 ms, frase aberta 1 s (termina em artigo, preposição, conjunção, possessivo, vírgula ou reticência, **mesmo com `?`**, que a
   Deepgram põe sozinha), dado ditado pela metade (telefone, CPF, CEP) 0,9 s e hesitação ("hum, deixa eu pensar.") 1,2 s. Ambiente
   barulhento soma 200 ms. O piso de 300 a 350 ms vem da bancada: com 150 ms, a pausa entre duas frases seguidas já fechava o turno no
   meio. Regressão: "E quais são suas" / "empreitadas aí nessa empresa?" é um turno só.
5. **Pedido adiantado ao modelo (`speculation`).** Quando a pausa já foi vista e a frase parece fechada (ou sem pontuação), mas o prazo
   de segurança ainda não acabou, o pedido ao modelo sai já, sem nada ir à síntese, e a resposta é aproveitada se o turno fecha com o
   mesmo texto e o mesmo histórico. Se a pessoa continua, o pedido é cortado (`llm_call` com `purpose: "speculative"`; o custo é
   estimado pelo da última chamada completa). Nunca com frase aberta, hesitação ou dado ditado pela metade, e nunca sem a pausa
   confirmada pelo áudio.

### Marco 3: a frase de ponte

6. **Ponte (`bridge`).** Frases curtas pré-sintetizadas com a voz do agente (uma de cada vez, só com a voz livre, e guardadas no
   processo por voz e idioma) tocam se o primeiro texto do modelo não chegou `bridgeAfterMs` (100 ms) depois do pedido; o silêncio das pontas do áudio é aparado. Faixa curta primeiro; se
   o texto ainda não veio quando ela acaba, uma mais longa; nunca no turno que responde a uma pergunta de confirmação de agenda
   (ferramenta que grava), nunca no turno que continua um resultado de ferramenta, nunca repete a frase das duas últimas. O áudio vai
   à fila de saída: o texto do modelo, quando chega, toca depois dela, sem cortá-la. Não entra na transcrição nem no histórico do modelo.

### Marco 4: provedores

7. **A ordem de provedores do perfil nunca chegou ao pedido.** O motor sempre mandava o modelo explícito, e o código só juntava
   `provider` quando o modelo não vinha explícito. Os perfis D e E rodavam com o roteamento padrão do OpenRouter (provedores de 0,6 a
   4 s). Corrigido: o modelo do próprio perfil herda a ordem; um modelo trocado à mão (teste) não.
8. **Tempo limite no primeiro conteúdo.** Perfis D e E: se o provedor da vez não entrega nada em 800 ms, o pedido é cortado e refeito
   no próximo da ordem (DeepSeek: Together, Wafer, Reka; gpt-oss: Cerebras, Groq, BaseTen); o último não tem limite. O pedido cortado
   aparece como `llm_call` com `purpose: "retry"` e conta no custo (estimado). A conexão da Cartesia recebe um ping a cada 20 s.

### Números (detalhe e limites no [relatório](../reports/2026-11-25-latencia-de-resposta.md))

Perfil E, voz real, do fim real da fala ao primeiro som: **p50 1,52 s e p90 1,93 s antes, p50 0,39 s e p90 0,43 s depois**. O texto da resposta (sem a espera da
ponte) sai em p50 0,88 s. Fim de turno pela pausa: −0,46 s no p50 e some a cauda de 5 a 6 s. Aquecimento e especulação valem pouco (≈ 0 a 0,2 s e ≈ 0,03 s).

## Consequências e como desligar

- **Ligados por padrão.** Aquecimento, fim de turno pela pausa, especulação e ponte nascem ligados para todo agente em pipeline. O operador desliga a ponte e a
  especulação por agente na tela (seção abaixo). O fim de turno pela pausa e o aquecimento não têm chave na tela.
- **Risco do prazo curto:** quem faz pausa longa entre duas orações pode ser cortado; o prazo por classe (`TURN_END_SILENCE_MS`) é o que se ajusta.
- **Custo:** o aquecimento custa ~US$ 0,0003 por ligação; um pedido adiantado descartado ou refeito por demora custa uma chamada (estimada pela última completa). As frases de ponte custam
  ~US$ 0,004 por voz e por processo.
- **Reverter:** `latency: { fastEndpoint: false, speculation: false, bridge: false, warmup: false }` na configuração da sessão devolve o comportamento anterior; a correção da ordem de
  provedores e o ping da Cartesia ficam.

### Configuração por agente (a tela)

Em Agentes, no motor em pipeline, duas chaves, **ligadas por padrão**: "Frase curta enquanto o modelo pensa" (`agents.latency_bridge`) e "Adiantar o pedido ao modelo"
(`agents.latency_speculation`), migration `20261125T190000_agents_latency_toggles.sql`. A sessão da chamada passa `latency: { bridge, speculation }` ao motor. O aquecimento e o fim de turno
pela pausa não têm chave: desligá-los é a configuração de sessão `latency` (ver acima). Reverter a migration: migration nova que remove as colunas, depois de reverter o deploy.
