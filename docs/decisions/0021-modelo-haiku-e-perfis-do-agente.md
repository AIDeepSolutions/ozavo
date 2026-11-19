# 0021: Claude Haiku 5.5 como modelo padrão do pipeline e perfil do modelo por agente

- **Estado:** aceita
- **Data:** 2026-11-19
- **Quem decidiu:** o dono do projeto, em 18/11/2026, sobre a recomendação do benchmark R2 (ramo
  `feat/benchmark-llm-2`, pasta `docs/benchmark-llm-r2/`, que não entra na `main`: os números abaixo vêm de lá).
- **Estado do produto:** o Ozavo não está em produção. Nada aqui foi validado em ligação real.

## Contexto

O benchmark R2 mediu, em bancada simulada (pessoa, STT, TTS e agenda simulados), 30 cenários de agenda × 3
repetições. O Gemini 2.5 Flash, que era o padrão do motor em pipeline, concluiu 74 a 77% dos atendimentos. O Claude
Haiku 5.5 (`anthropic/claude-haiku-5.5`) concluiu 96,7 a 100%, sem erro crítico depois das correções de código da
agenda. Com cache do prompt de sistema ele custa menos que o Flash sem cache; sem cache, mais. A latência do Haiku só
fica adequada ao telefone (mediana composta ~1,4 s) com o raciocínio desligado e a lista de horários agrupada por dia.

## Decisão

1. **O modelo padrão do pipeline passa a ser o Haiku 5.5**, no perfil A, escolhido **por agente** na tela do agente
   (convenção 7 do `AGENTS.md`: configuração de operador tem tela; não é variável de ambiente). Coluna
   `agents.llm_profile` (migration `20261119T120000_agents_llm_profile.sql`), padrão `a`.

   | Perfil | O que envia ao OpenRouter | Quando |
   |---|---|---|
   | **A** (padrão) | `anthropic/claude-haiku-5.5`, `cache_control` no prompt de sistema, `max_tokens` 1024, raciocínio do modelo ligado | qualidade primeiro; resposta em ~2 s |
   | **B** (telefonia) | o mesmo, com `reasoning: { enabled: false }`, `max_tokens` 400 e a lista de horários livres **agrupada por dia** | ligação ao vivo; 87/90 concluídos na bancada, ~1,4 s |
   | **C** (Flash) | `google/gemini-2.5-flash`, sem cache, `max_tokens` 400, como antes | voltar ao comportamento anterior ou priorizar o custo do modelo |

2. **`cache_control` só vai a modelo que o aceita** (`acceptsCacheControl`: hoje, `anthropic/*`).
3. **`max_tokens` 1024 enquanto o raciocínio estiver ligado.** O teto de 400 foi consumido pelo raciocínio e cortou 9 de
   552 chamadas do Haiku padrão.
4. **O agrupamento por dia (`groupByDay`) só liga junto do perfil B.** Ele só foi validado com o raciocínio desligado.
   Chega à ferramenta `agenda_horarios_livres` por `ToolContext.presentation.groupSlotsByDay`, preenchido pela sessão a
   partir do perfil do agente.
5. **Observabilidade por chamada ao modelo** (convenção 8): o evento `llm_call` na linha do tempo, com modelo, provedor,
   `finish_reason` (`length` é corte pelo teto), tokens de entrada, de saída, de raciocínio e de cache (lidos e gravados).
   Nunca grava texto da conversa.
6. **Compromissos da pessoa (opção (b) do dono).** Cancelar e remarcar só valem para o id criado **nesta ligação**
   (`rememberAppointment`) ou informado pelo operador em `request_context.appointmentIds` (até 50 textos). **Nega por
   padrão.** O ponto de extensão para a opção (a), consultar o conector da agenda pelo telefone de quem ligou, é
   `CallerAppointmentsSource` / `CallSessionDeps.callerAppointments`: não implementado.
7. **Correções de código da agenda do benchmark R2**, trazidas sem a bancada: janela de horários válida e erro de consulta
   explícito; trava de autorização (sim afirmativo, leitura do horário com minuto, dia e fuso, última leitura, compromisso da
   própria pessoa); retenção da fala "pronto, marcado" até a escrita dar certo.

Os preços dos planos e a configuração comercial não mudam.

## Limitações conhecidas

- **"Quero remarcar/cancelar a minha consulta" numa ligação recebida deixa de funcionar** por conta própria: não há id
  conhecido, e a ferramenta recusa e orienta oferecer `create_task` ou `transfer_to_human`. Funciona na ligação de saída
  quando o pedido informa `request_context.appointmentIds`, e para o que o agente marcou na mesma ligação. A opção (a)
  resolve; está por fazer.
- **Quem já tinha agentes no pipeline passa a usar o Haiku (perfil A)** ao atualizar: o padrão da coluna é `a`. Para manter o
  Flash, escolher o perfil C em cada agente.
- **Validado só em bancada simulada.** Latência de STT/TTS e endpointing reais, a mistura de frases e a naturalidade
  dependem da primeira ligação real (aguarda o número).
- **A latência do perfil A (~2 s, ~3 s com ferramenta) é inadequada para conversa ao telefone.** O B existe para isso, mas
  concluiu 87/90 (a diferença de 1 a 3 pontos entre configurações está dentro do ruído da bancada, ±6 pontos).
- A trava de autorização é heurística (regex em português). As correções posteriores à revisão não foram medidas em bateria
  nova de LLM, só por teste de unidade e replay sem custo.
- O teto de reserva de custo quando a chamada é abortada sem extrato passa a ser o `max_tokens` do perfil (1024 no A): mais
  conservador para o teto de gasto, e nunca menor que antes.
- O roteamento de provedor segue o padrão do OpenRouter; o provedor de cada chamada agora é registrado em `llm_call`.

## Como reverter

- **Um agente:** na tela do agente, "Modelo de texto" → "Gemini 2.5 Flash (o de antes)". Ou `update agents set llm_profile =
  'c' where id = ...`. O perfil C não manda `reasoning` nem `cache_control` e usa `max_tokens` 400.
- **Todos os agentes:** trocar `DEFAULT_LLM_PROFILE` para `"c"` em `packages/voice-engine/src/pipeline/llm-profile.ts` e
  `default 'c'` numa migration nova (migration publicada nunca é editada) que também faça `update agents set llm_profile =
  'c'`.
- **Compromissos:** para voltar a aceitar qualquer id (sem a proteção), reverter o commit da opção (b); não recomendado.
- **Correções da agenda:** `git revert` dos commits da trava (`packages/tools/src/authorization.ts`) e da retenção
  (`packages/voice-engine/src/pipeline/write-guard.ts`).
- O evento `llm_call` pode ficar: só observa.

## Como o operador usa

Em Agentes, no agente com o motor Deepgram + OpenRouter + Cartesia, o campo **Modelo de texto** escolhe o perfil. Para a
ligação de saída que pode remarcar ou cancelar, informe no pedido `request_context: { "appointmentIds": ["..."] }`.
