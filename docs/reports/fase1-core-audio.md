# Handoff — Fase 1: core e áudio

Data: 2026-11-16. Implementação no ramo local `feat/fase1-core-audio`, commit
`ffd1685`, worktree `<pasta-de-trabalho>/ozavo-wt-core-audio`.
Base: `691e8ea`. Não houve push, PR, alteração de outro projeto ou cópia de credencial
para o repositório. O checkout principal foi preservado. Este relatório acompanha o ramo.

**Situação: implementação entregue para revisão; Fase 1 ainda não aceita nas metas de
latência e na verificação de banco.**

## O que ficou pronto

- Quarto motor descoberto por `load.ts`, sem registro central, com contratos STT/TTS/LLM
  exportados e a `VoiceSession` existente.
- Deepgram Nova-3 pt-BR em streaming, PCM16 mono 8 kHz, parciais/finais, Finalize,
  KeepAlive e reaproveitamento do construtor de URL já testado da bancada.
- Cartesia Sonic 3.6 WebSocket em `pcm_mulaw` 8 kHz nativo, decodificado na borda PCM16;
  seleção de voice_id no agente da organização, cancelamento, deadline de síntese.
- OpenRouter em SSE com JSON Schema das ferramentas existentes, argumentos em deltas,
  resultados de ferramentas pelo mesmo ID e continuação do diálogo. Não cria conectores
  novos de agenda: usa as ferramentas instaladas/habilitadas e disponíveis.
- Instrução de 120–160 caracteres e teto efetivo de 160 para respostas geradas, sem
  preencher respostas curtas; `say` preserva avisos completos e tem prioridade de áudio.
- Barge-in por VAD local contínuo, SpeechStarted e parcial da STT; aborta LLM, cancela
  TTS, descarta áudio tardio e usa o `interrupted`/`clearAudio` existente. Endpointing
  dinâmico preserva pausas de frases abertas.
- AMD em saída, com frase/bipe/saudação longa/ausência de resposta; encerramento conectado
  ao ciclo da chamada e motivos traduzidos na linha do tempo em pt-BR/en/es.
- Custo STT durante áudio, caracteres TTS e custo OpenRouter no medidor/teto existente.
  Resposta interrompida sem extrato final usa estimativa conservadora e pode superar o
  custo real. As três chaves são um JSON cifrado pelo caminho já existente de settings;
  os motores recebem a chave por parâmetro e não leem o ambiente.
- Testes unitários/de contrato/latência simulada/regressão; bancada real opt-in;
  documentação, contratos e fragmento de versão. Nenhuma migration necessária.

## O que falta

- **TTFB Cartesia <100 ms não atingido:** três pedidos reais deram 267, 265 e 266 ms.
- **RTT completo <500 ms não comprovado:** OpenRouter levou 617 ms até o primeiro token
  em um pedido real; falta a chave Deepgram para medir o caminho completo. Os arquivos
  indicados continham somente as chaves Cartesia/OpenRouter, sem Deepgram. Não se usou
  banco Supabase ou outros segredos presentes no arquivo.
- O teste de 360 ms usa tempos simulados e começa no final da STT, excluindo sua rede e
  processamento. Não confundir com uma medição de RTT completo. Endpointing Deepgram
  soma ao menos o prazo configurado de 100 ms; pausas abertas esperam mais de propósito.
- **Banco não verificado:** `pnpm test:db` foi executado, mas não iniciou o Postgres porque
  o usuário não tem acesso a `/var/run/docker.sock`. Os três testes novos de integração
  AMD com banco estão escritos e ainda precisam rodar em ambiente com Docker acessível.
- Falta escuta humana e chamada SIP real para qualidade pt-BR, eco, barge-in/ruído real,
  falsos positivos de AMD e ferramentas com provedores reais. AMD é heurístico.
- O acesso a modelos e as metas externas precisam de validação do operador/provedor;
  nenhum ajuste de código aqui prova que o Sonic entregue áudio antes de 100 ms.

## Verificação e saída dos comandos

`pnpm verify` — saída 0; lint e tipos passaram, cercas e unidades:

```text
> pnpm lint && pnpm typecheck && pnpm fences && pnpm test

 Test Files  29 passed (29)
      Tests  61 passed (61)

 Test Files  79 passed (79)
      Tests  878 passed (878)
   Duration  9.73s
```

[Saída integral de pnpm verify](fase1-verify.txt).

`pnpm test:db` — saída 1, falha de ambiente antes dos testes:

```text
> vitest run --project db
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
Error: Command failed: bash <pasta-de-trabalho>/ozavo-wt-core-audio/scripts/test-db.sh up
ELIFECYCLE Command failed with exit code 1.
```

[Saída integral de pnpm test:db](fase1-test-db.txt).

`pnpm exec tsx scripts/medir-pipeline.ts --live` — saída 0, credenciais lidas
somente do ambiente/arquivos locais autorizados:

```json
{
  "cartesiaTtfbMs": [267, 265, 266],
  "cartesiaTargetMs": 100,
  "openrouterFirstTokenMs": 617,
  "fullRttMeasured": false
}
```

[Saída integral da bancada](fase1-latencia.txt).

Revisão independente, sem contexto do implementador: outro agente executou
`pnpm vitest run --project unit packages/voice-engine apps/voice` (33 arquivos/404 testes)
e uma rodada direcionada após correções (21 arquivos/217 testes). Encontrou e conferiu
correções de custo em aborto, consumo STT contínuo, conflito de síntese com resultado
rápido de ferramenta, piso de ruído e consumo da saudação. Não atesta provedor real.
As últimas quatro regressões adicionadas depois estão nos 878 testes finais acima.

Prova por sabotagem, somente em cópia descartável: troquei o teto de caracteres de
160 para 1600. O teste `limita respostas geradas` reprovou exatamente como previsto:

```text
AssertionError: expected ... to have a length of 160 but got 990
 Test Files  1 failed (1)
      Tests  1 failed | 25 skipped (26)
```

[Saída integral da sabotagem](fase1-sabotagem.txt). O worktree de sabotagem foi removido.
O ramo de implementação preserva o teto correto.

## O que foi feito além do pedido e erros no caminho

Reaproveitei, por cópia, os arquivos parciais já existentes no worktree `ozavo-wt-fase1`,
sem alterar aquele trabalho. As extensões de medição de custo, traduções de motivos e
contratos foram necessárias para conectar o motor ao produto. Armei os hooks conforme
skill de contribuição: o pre-commit executou na gravação do commit e não detectou segredo.
Nenhum outro escopo de produto foi implementado.

A primeira execução de testes falhou por falta dos links de workspace na cópia nova;
`pnpm install --frozen-lockfile` resolveu. A revisão encontrou defeitos reais na base
parcial e uma regressão durante os ajustes (saudação emitia custo antes do registro dos
handlers); ambos foram corrigidos e testados. As duas limitações que permanecem são
latência externa acima da meta e falta de acesso ao Docker/chave Deepgram para os testes.

## Arquivos criados e alterados

`A` identifica arquivo criado; `M`, arquivo alterado no commit de implementação:

```text
A	.changes/motor-pipeline-deepgram-openrouter-cartesia.md
M	apps/panel/src/i18n/en/timeline.ts
M	apps/panel/src/i18n/es/timeline.ts
M	apps/panel/src/i18n/pt-BR/timeline.ts
M	apps/voice/src/call-session.db.test.ts
M	apps/voice/src/call-session.ts
M	docs/guides/adicionar-um-motor-de-voz.md
A	docs/guides/pipeline-de-voz.md
M	docs/plans/2026-11-10-fundacao.md
A	packages/voice-engine/src/engines/deepgram-openrouter-cartesia.test.ts
A	packages/voice-engine/src/engines/deepgram-openrouter-cartesia.ts
M	packages/voice-engine/src/index.ts
M	packages/voice-engine/src/load.test.ts
A	packages/voice-engine/src/pipeline/amd.test.ts
A	packages/voice-engine/src/pipeline/amd.ts
A	packages/voice-engine/src/pipeline/cartesia-tts.test.ts
A	packages/voice-engine/src/pipeline/cartesia-tts.ts
A	packages/voice-engine/src/pipeline/credentials.test.ts
A	packages/voice-engine/src/pipeline/credentials.ts
A	packages/voice-engine/src/pipeline/deepgram-stt.test.ts
A	packages/voice-engine/src/pipeline/deepgram-stt.ts
A	packages/voice-engine/src/pipeline/deepgram-url.ts
A	packages/voice-engine/src/pipeline/endpointing.test.ts
A	packages/voice-engine/src/pipeline/endpointing.ts
A	packages/voice-engine/src/pipeline/openrouter-llm.test.ts
A	packages/voice-engine/src/pipeline/openrouter-llm.ts
A	packages/voice-engine/src/pipeline/session.test.ts
A	packages/voice-engine/src/pipeline/session.ts
A	packages/voice-engine/src/pipeline/vad.test.ts
A	packages/voice-engine/src/pipeline/vad.ts
M	packages/voice-engine/src/pricing.ts
M	packages/voice-engine/src/provider-socket.ts
A	packages/voice-engine/src/testing/audio.ts
A	packages/voice-engine/src/testing/fake-pipeline.ts
M	packages/voice-engine/src/types.ts
M	scripts/bancada-de-voz/servicos/deepgram.ts
A	scripts/medir-pipeline.ts
```

Este handoff e os quatro arquivos de saída são acrescentados no commit de documentação.
[Guia de configuração e medição](../guides/pipeline-de-voz.md).
