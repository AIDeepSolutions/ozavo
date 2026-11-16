# Motor de voz em pipeline

O motor `deepgram-openrouter-cartesia` é descoberto por pasta. A borda do AudioSocket
continua PCM16 mono 8 kHz. Deepgram recebe esse áudio nativo; Cartesia gera μ-law 8 kHz,
decodificado para PCM16 na saída do motor. Não há Cartesia Ink nem registro central.

## Configurar

Em Configurações → Inteligência artificial, escolha o motor e salve no campo de chave
um JSON com `deepgram`, `cartesia` e `openrouter`, cada campo contendo a chave do respectivo
provedor. O JSON inteiro usa a cifra de segredos já existente. O teste de chave consulta
as três contas sem sintetizar fala nem gerar texto. Nunca envie esse JSON por mensagem.
No agente, escolha o motor e a voz Cartesia. O `voice_id` pertence ao agente da organização;
IDs de vozes próprias também são aceitos pela API de agentes. Não há variável nova de produto.

As ferramentas habilitadas do agente são passadas como JSON Schema, com o contrato já
existente. O motor não cria conectores: usa os que estiverem instalados e disponíveis.
O limite de geração visa 120–160 caracteres e aplica teto de 160; avisos explícitos de
`say` preservam o texto integral. Respostas naturalmente curtas não são preenchidas.

## Interrupção e secretária

VAD local contínuo detecta fala sustentada em 120 ms; texto parcial e SpeechStarted também
interrompem. O motor aborta a geração e cancela o contexto Cartesia. `interrupted` limpa
a fila da ponte com o caminho existente de `clearAudio`. Quadros tardios são descartados.
Endpointing espera mais em frases incompletas e ambiente barulhento.
AMD roda apenas em saída: frase típica, bipe ou saudação longa detectam máquina. Ausência
de resposta por cinco segundos de áudio gera `unknown`; a saída encerra. O motivo aparece
em `call_ended`, traduzido na linha do tempo. Os limiares são heurísticos; precisam de
validação com chamadas e ruído de linhas reais antes de uso operacional.

O consumo é incremental: áudio da STT a cada segundo enviado, caracteres ao enviar à síntese
e custo OpenRouter no extrato final. Interrupções sem extrato recebem estimativa conservadora
pelo preço de reserva; esse valor pode superar o custo real. A mesma medição alimenta o teto.

## Medir

Testes sem rede usam portas efêmeras, relógio injetado e áudio sintético:

```sh
pnpm vitest run --project unit packages/voice-engine apps/voice
pnpm verify
pnpm test:db
```

Para consumir os serviços reais com as suas chaves:

```sh
pnpm exec tsx scripts/medir-pipeline.ts --live
```

A bancada lê as chaves do ambiente: `CARTESIA_API_KEY` e `OPENROUTER_API_KEY` (por exemplo,
`node --env-file=arquivo.env --import tsx scripts/medir-pipeline.ts --live`). Escreve apenas métricas. Isso é
ferramenta de desenvolvimento: o motor de produção recebe credenciais por parâmetro.

Medição em 2026-11-16 nesta VPS, três falas Cartesia e um pedido OpenRouter:

| Medida | Resultado |
|---|---|
| Cartesia Sonic 3.6 TTFB | 267 / 265 / 266 ms |
| OpenRouter Gemini Flash, primeiro token | 617 ms |
| RTT completo com STT | Não medido; falta chave Deepgram |

As metas de TTFB <100 ms e RTT <500 ms não foram atingidas/comprovadas. O teste de
latência simulada mede 360 ms **após** o final da STT (120 endpointing local + 180 LLM +
60 TTS); não prova latência da rede nem do provedor. Em operação o endpointing Deepgram
soma pelo menos o prazo configurado de 100 ms (400 no ambiente barulhento), além do
processamento. Pausas abertas esperam de propósito mais que o orçamento de 500 ms.
