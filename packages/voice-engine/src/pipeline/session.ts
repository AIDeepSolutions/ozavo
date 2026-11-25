import type { Clock } from "@ozavo/core";
import { SessionEmitter } from "../emitter";
import { instructionsWithVocabulary } from "../vocabulary";
import { CONTEXT_MAX_TOKENS, formatRetrievedContext } from "../knowledge-prompt";
import type { AnsweringMachineDetection, KnowledgeCallInfo, ToolSpec, TurnLatency, Usage, VoiceSession, VoiceSessionConfig } from "../types";
import { AnsweringMachineDetector, type AmdOptions } from "./amd";
import type { CartesiaTts, TtsHandlers } from "./cartesia-tts";
import type { DeepgramStt, SttHandlers } from "./deepgram-stt";
import { endpointDelayMs } from "./endpointing";
import { KnowledgeRetriever, SPECULATE_DEBOUNCE_MS, SPECULATE_MIN_WORDS, wordCount, type EmbeddingResult } from "./knowledge-retrieval";
import type { ChatMessage, ChatToolCall, LlmEvent } from "./openrouter-llm";
import { TURN_TARGET_MAX_CHARACTERS, createTurnLimiter } from "./turn-guard";
import { WRITE_FAILURE_RESPONSES, WRITE_TOOLS, WRITE_UNAVAILABLE, claimsDone, failureCovers, startsAtOfCall, writeKindOf, type WriteFailure } from "./write-guard";
import { EnergyVad, type VadOptions } from "./vad";

/**
 * A sessão do motor em pipeline: junta transcrição (STT), modelo de texto (LLM) e síntese (TTS)
 * numa `VoiceSession` só, com o mesmo contrato dos motores de voz direta.
 *
 * O caminho de um turno:
 *   áudio de quem ligou ─┬─► STT ─► fim de turno dinâmico ─► LLM (streaming) ─► frases ─► TTS ─► `audio`
 *                        ├─► VAD local ─► barge-in (corta LLM e TTS, emite `interrupted`)
 *                        └─► AMD (só nos primeiros segundos)
 *
 * A latência vem de não esperar: a primeira frase do modelo já vai para a síntese enquanto ele
 * escreve o resto, e a síntese entrega o áudio em pedaços.
 */

/** O que a sessão mede por turno. Vai para `onMetrics` e para o evento `turnMetrics` da sessão. */
export type TurnMetrics = TurnLatency;

export type SttPort = Pick<DeepgramStt, "sendAudio" | "finalize" | "drainSeconds" | "close">;
export type TtsPort = Pick<CartesiaTts, "speak" | "cancel" | "drainCharacters" | "close">;

export interface PipelineSessionDeps {
  config: VoiceSessionConfig;
  clock: Clock;
  openStt(handlers: SttHandlers): Promise<SttPort>;
  openTts(handlers: TtsHandlers): Promise<TtsPort>;
  chat(messages: readonly ChatMessage[], tools: readonly ToolSpec[], signal: AbortSignal): AsyncIterable<LlmEvent>;
  /** Agendador dos prazos (`setTimeout` por padrão). Devolve como cancelar. */
  schedule?: (fn: () => void, delayMs: number) => () => void;
  onMetrics?(metrics: TurnMetrics): void;
  vad?: VadOptions;
  /** Detector do barge-in por energia (padrão: `BARGE_IN_VAD`). */
  bargeInVad?: VadOptions;
  /** `false` desliga a detecção de caixa postal. */
  amd?: AmdOptions | false;
  /**
   * Embedding da pergunta (chave do OpenRouter da própria ligação), para a busca por similaridade na base de conhecimento.
   * Sem ele, a busca é só por palavras. Só vale com `config.knowledge.mode === "rag"` e `config.knowledge.search`.
   */
  embedQuestion?(text: string): Promise<EmbeddingResult>;
}

/** As mensagens do modelo neste turno: a mesma lista, com os trechos da base logo antes da última fala da pessoa. */
export function withKnowledgeContext(messages: readonly ChatMessage[], context: string | undefined): readonly ChatMessage[] {
  if (context === undefined) return messages;
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      index = i;
      break;
    }
  }
  if (index === -1) return messages;
  return [...messages.slice(0, index), { role: "system", content: context }, ...messages.slice(index)];
}

const APOLOGY: Record<string, string> = {
  pt: "Desculpe, tive um problema para responder. Pode repetir, por favor?",
  en: "Sorry, I had a problem answering. Could you repeat that, please?",
  es: "Disculpe, tuve un problema para responder. ¿Puede repetir, por favor?",
};

const LANGUAGE_RULE: Record<string, string> = {
  pt: "Responda sempre em português do Brasil.",
  en: "Always answer in English.",
  es: "Responde siempre en español.",
};

export const MAX_TURN_CHARACTERS = TURN_TARGET_MAX_CHARACTERS;

const PHONE_STYLE =
  "This is a phone call: answer in short sentences, one idea at a time, with no lists, markdown or emojis. " +
  "Speak like a person: natural contractions, no stiff call-center phrases, and write numbers, money and abbreviations the way they are said aloud. " +
  "Your name is the one in your instructions; it is simply your name, so never comment on it. " +
  "Never mention noise or a bad line unless the person said so. " +
  "Aim for 120 to 160 characters per turn; shorter answers are allowed. Never exceed 160 characters: anything longer is cut off before it is spoken. " +
  "When a tool is needed, call it instead of describing it.";

/** Bytes por milissegundo do PCM16 mono 8 kHz. */
const BYTES_PER_MS = 16;

/**
 * Barge-in por energia: bem mais exigente que o VAD de atividade (280 ms seguidos, 15 dB acima do
 * fundo). Eco da própria fala do agente e estalo de linha não duram isso nem passam dessa margem;
 * quem realmente interrompe, sim.
 */
const BARGE_IN_VAD: VadOptions = { startFrames: 14, marginDb: 15 };

const normalizeWords = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

/** Texto parecido com o que o agente acabou de falar: é o eco dele voltando pelo microfone. */
export function isEchoOf(heard: string, agentText: string): boolean {
  const words = normalizeWords(heard);
  if (words.length === 0) return true;
  const spoken = new Set(normalizeWords(agentText));
  return words.every((word) => spoken.has(word));
}

/**
 * O texto do modelo como a voz deve ler: sem marcação, sem emoji, com símbolo e abreviação por
 * extenso. A transcrição guarda o texto original; só a síntese recebe este.
 */
export function speakable(text: string): string {
  return text
    .replace(/[*_`#>~|]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\bR\$\s?(\d+(?:\.\d{3})*)(?:,(\d{1,2}))?/g, (_m, reais: string, cents?: string) => `${reais.replace(/\./g, "")} reais${cents && Number(cents) > 0 ? ` e ${Number(cents)} centavos` : ""}`)
    .replace(/(\d)\s?%/g, "$1 por cento")
    .replace(/\bSr\.(?=\s|$)/g, "senhor")
    .replace(/\bSra\.(?=\s|$)/g, "senhora")
    .replace(/\bDra\.(?=\s|$)/g, "doutora")
    .replace(/\bDr\.(?=\s|$)/g, "doutor")
    .replace(/\s*[()[\]]\s*/g, ", ")
    .replace(/\s+—\s+|\s+-\s+/g, ", ")
    .replace(/,\s*([.!?,;:])/g, "$1")
    .replace(/^\s*,\s*/, "")
    .replace(/\s{2,}/g, " ");
}

/**
 * Onde cortar o texto do modelo para mandar à síntese: fim de frase, ou vírgula num trecho já
 * longo. O primeiro trecho do turno corta mais cedo, que é o que derruba o TTFB percebido.
 */
export function splitPoint(text: string, first: boolean): number {
  const strong = /[.!?…](\s|$)/g;
  for (let match = strong.exec(text); match; match = strong.exec(text)) {
    const end = match.index + 1;
    if (end >= (first ? 10 : 12)) return end;
  }
  const weakMin = first ? 24 : 80;
  const weak = /[,;:](\s)/g;
  for (let match = weak.exec(text); match; match = weak.exec(text)) {
    const end = match.index + 1;
    if (end >= weakMin) return end;
  }
  if (text.length >= MAX_TURN_CHARACTERS) {
    const space = text.lastIndexOf(" ", MAX_TURN_CHARACTERS);
    return space >= 80 ? space : MAX_TURN_CHARACTERS;
  }
  return -1;
}

const scheduleTimeout = (fn: () => void, delayMs: number): (() => void) => {
  const handle = setTimeout(fn, delayMs);
  return () => clearTimeout(handle);
};

interface AgentTurn {
  id: number;
  contextId: string;
  abort: AbortController;
  /** Fim da fala de quem ligou que abriu o turno; ausente quando o turno veio de um resultado de ferramenta. */
  userEndedAt?: number;
  endpointDelayMs: number;
  firstTokenAt?: number;
  ttsStartedAt?: number;
  ttfbMs?: number;
  measured: boolean;
  /** Texto já mandado à síntese. */
  spoken: string;
  /** O modelo terminou de escrever. */
  written: boolean;
  /** O contexto de síntese tem texto pendente (ainda não chegou `done`). */
  synthesizing: boolean;
  /** A fala deste turno já entrou no histórico. */
  recorded: boolean;
}

export async function createPipelineSession(deps: PipelineSessionDeps): Promise<VoiceSession> {
  const { config, clock } = deps;
  const schedule = deps.schedule ?? scheduleTimeout;
  const emitter = new SessionEmitter();
  const now = (): number => clock.now().getTime();
  const lang = config.language.split("-")[0]?.toLowerCase() ?? "pt";

  const history: ChatMessage[] = [
    {
      role: "system",
      content: `${instructionsWithVocabulary(config.instructions, config.vocabulary)}\n\n${LANGUAGE_RULE[lang] ?? `Always answer in ${config.language}.`} ${PHONE_STYLE}`,
    },
  ];
  const vad = new EnergyVad(deps.vad);
  const bargeVad = new EnergyVad(deps.bargeInVad ?? BARGE_IN_VAD);
  /** O que o agente falou há pouco (turno e falas avulsas), para reconhecer o próprio eco. */
  let recentAgentText = "";
  const rememberAgentText = (text: string): void => {
    recentAgentText = `${recentAgentText} ${text}`.slice(-600);
  };
  const amd =
    deps.amd === false || config.direction !== "outbound"
      ? undefined
      : new AnsweringMachineDetector((detection: AnsweringMachineDetection) => emitter.emit("answeringMachine", detection), deps.amd);

  let finished = false;
  let opening = true;
  let openingFailure: Error | undefined;
  let closing: Promise<void> | undefined;
  const activeResponses = new Set<Promise<void>>();
  let turnSeq = 0;
  let saySeq = 0;
  let turn: AgentTurn | undefined;
  let afterSynthesis: (() => void) | undefined;
  /** Até quando a ponte ainda está tocando a fala do agente (estimado pelo áudio entregue). */
  let playhead = 0;
  /** Falas pedidas por `say`, pelo contexto: a transcrição sai quando a síntese termina ou é cortada. */
  const sayContexts = new Map<string, string>();
  const recordSay = (contextId: string): void => {
    const text = sayContexts.get(contextId);
    sayContexts.delete(contextId);
    if (text) emitter.emit("transcript", { speaker: "agent", text });
  };
  let finals: string[] = [];
  let partial = "";
  let lastFinalAt = 0;
  let cancelEndpoint: (() => void) | undefined;
  const awaitingTools = new Map<string, ChatToolCall>();
  let toolResults: ChatMessage[] = [];
  let queuedUser: { text: string; endedAt: number; delay: number }[] = [];
  /** O agente só segura "pronto, marcado" se tem ferramenta de escrita nesta ligação. */
  const hasWriteTools = config.tools.some((tool) => WRITE_TOOLS.has(tool.name));
  /**
   * A última escrita que não deu certo (falhou ou foi recusada). Segura só a confirmação do MESMO tipo, que não cite outro horário,
   * e só pelas próximas `WRITE_FAILURE_RESPONSES` respostas: não é permanente. Uma escrita bem-sucedida do mesmo tipo a levanta.
   */
  let writeFailure: WriteFailure | undefined;

  const flushUsage = (llm?: Partial<Usage>): void => {
    const seconds = stt?.drainSeconds() ?? 0;
    const characters = tts?.drainCharacters() ?? 0;
    if (!llm && seconds === 0 && characters === 0) return;
    emitter.emit("usage", { seconds, characters, ...llm });
  };

  const knowledge = config.knowledge;
  const retriever =
    knowledge?.mode === "rag" && knowledge.search
      ? new KnowledgeRetriever({
          search: knowledge.search,
          embed: deps.embedQuestion ?? (() => Promise.reject(new Error("no embedding"))),
          now,
          schedule,
          topK: knowledge.topK,
          budgetMs: knowledge.budgetMs,
          // O embedding da pergunta é gasto da ligação: entra no extrato como o do modelo (custo declarado pelo provedor, em centavos).
          onEmbedded: ({ costMicrocents }) => flushUsage({ providerCostCents: costMicrocents / 1_000_000 }),
        })
      : undefined;
  /** Os trechos do último turno de quem ligou: valem também para a continuação do turno depois de uma ferramenta. */
  let knowledgeContext: string | undefined;
  let cancelSpeculation: (() => void) | undefined;
  /** A busca especulativa: o texto de quem ligou até agora (finais + parcial), depois de um tempo sem mudar. */
  const speculate = (delayMs: number): void => {
    if (!retriever) return;
    cancelSpeculation?.();
    cancelSpeculation = undefined;
    const text = [...finals, ...(partial ? [partial] : [])].join(" ").trim();
    if (wordCount(text) < SPECULATE_MIN_WORDS) return;
    if (delayMs <= 0) return retriever.speculate(text, true);
    cancelSpeculation = schedule(() => {
      cancelSpeculation = undefined;
      retriever.speculate(text);
    }, delayMs);
  };

  const agentAudible = (): boolean => now() < playhead || (turn?.synthesizing ?? false) || sayContexts.size > 0;

  const recordAgent = (current: AgentTurn): void => {
    if (current.recorded) return;
    current.recorded = true;
    const text = current.spoken.trim();
    if (text === "") return;
    emitter.emit("transcript", { speaker: "agent", text });
  };

  /** Encerra o turno do agente que estiver em curso. `bargeIn`: foi a pessoa que falou por cima. */
  const stopTurn = (bargeIn: boolean): void => {
    afterSynthesis = undefined;
    const current = turn;
    if (current) {
      turn = undefined;
      current.abort.abort();
      tts?.cancel(current.contextId);
      recordAgent(current);
      // O que foi falado (até onde se sabe) fica no histórico, para o modelo não repetir.
      if (current.spoken.trim() !== "" && !current.written) history.push({ role: "assistant", content: current.spoken.trim() });
    }
    if (bargeIn) {
      for (const contextId of [...sayContexts.keys()]) {
        tts?.cancel(contextId);
        recordSay(contextId);
      }
      playhead = now();
      emitter.emit("interrupted");
    }
  };

  const bargeIn = (): void => {
    if (!agentAudible()) return;
    stopTurn(true);
  };

  const speakApology = (): void => {
    const text = APOLOGY[lang] ?? APOLOGY.en ?? "";
    session.say(text);
  };

  const respond = async (userEndedAt: number | undefined, endpointDelay: number, question?: string): Promise<void> => {
    const current: AgentTurn = {
      id: ++turnSeq,
      contextId: `turn-${turnSeq}`,
      abort: new AbortController(),
      userEndedAt,
      endpointDelayMs: endpointDelay,
      measured: false,
      spoken: "",
      written: false,
      synthesizing: false,
      recorded: false,
    };
    turn = current;
    // Os trechos da base para esta fala (modo de busca): a busca é especulativa e tem orçamento, então a espera é curta e nunca falha.
    let knowledgeInfo: KnowledgeCallInfo | undefined = knowledge?.mode === "full" ? { mode: "full", hits: [], retrievalMs: 0, speculative: false, usedVector: false, embeddingTokens: 0 } : undefined;
    if (retriever && question !== undefined) {
      const retrieved = await retriever.forTurn(question);
      if (turn !== current || current.abort.signal.aborted) return;
      knowledgeContext = formatRetrievedContext(retrieved.hits, { language: config.language, only: knowledge?.only === true, maxTokens: CONTEXT_MAX_TOKENS }).text;
      knowledgeInfo = retrieved.info;
    }
    let text = "";
    let pending = "";
    // O limitador suave do turno: o que passa do alvo de caracteres não chega à síntese.
    const limiter = createTurnLimiter();
    const calls: ChatToolCall[] = [];
    // Frases de confirmação seguradas até o fim do turno (ver write-guard.ts). Depois da primeira, o resto do turno espera junto, na ordem.
    // Vale pelas próximas respostas depois da falha (inclusive com um turno só de consulta no meio), só para o mesmo tipo e alvo.
    const failure = writeFailure !== undefined && writeFailure.responsesLeft > 0 ? writeFailure : undefined;
    // Cada resposta depois da falha gasta uma das que a retenção ainda vale, já ao começar (uma resposta cortada por barge-in também conta).
    if (failure) failure.responsesLeft -= 1;
    const held: string[] = [];
    let heldAny = false;
    let heldCoveredByFailure = false;
    const emit = (piece: string, final: boolean): void => {
      if (piece.trim() === "" && !final) return;
      if (current.ttsStartedAt === undefined && piece.trim() !== "") current.ttsStartedAt = now();
      if (piece.trim() !== "") current.synthesizing = true;
      current.spoken += piece;
      if (piece.trim() !== "") rememberAgentText(piece);
      tts?.speak(current.contextId, speakable(piece), final);
      flushUsage();
    };
    const send = (piece: string, final: boolean): void => {
      if (hasWriteTools && (heldAny || (piece.trim() !== "" && claimsDone(piece, lang)))) {
        heldAny = true;
        if (failure && piece.trim() !== "" && claimsDone(piece, lang) && failureCovers(piece, failure)) heldCoveredByFailure = true;
        if (piece.trim() !== "") held.push(piece);
        return;
      }
      emit(piece, final);
    };
    try {
      for await (const event of deps.chat(withKnowledgeContext(history, knowledgeContext), config.tools, current.abort.signal)) {
        if (event.type === "fallback") {
          emitter.emit("llmCall", { promptTokens: 0, cachedTokens: 0, completionTokens: 0, fallback: true, fallbackStatus: event.status });
          continue;
        }
        if (event.type === "usage") {
          const { promptTokens, cachedTokens, completionTokens, costCents } = event.usage;
          emitter.emit("llmCall", {
            model: event.usage.model,
            provider: event.usage.provider,
            finishReason: event.usage.finishReason,
            reasoningTokens: event.usage.reasoningTokens,
            promptTokens,
            cachedTokens,
            cacheWriteTokens: event.usage.cacheWriteTokens,
            completionTokens,
            ...(knowledgeInfo && { knowledge: knowledgeInfo }),
          });
          knowledgeInfo = undefined;
          flushUsage({ textInputTokens: Math.max(0, promptTokens - cachedTokens), cachedInputTokens: cachedTokens, textOutputTokens: completionTokens, providerCostCents: costCents });
          continue;
        }
        if (turn !== current) continue;
        if (event.type === "text") {
          current.firstTokenAt ??= now();
          const delta = limiter.push(event.delta);
          text += delta;
          pending += delta;
          for (let cut = splitPoint(pending, current.spoken === ""); cut !== -1; cut = splitPoint(pending, current.spoken === "")) {
            send(pending.slice(0, cut), false);
            pending = pending.slice(cut);
          }
        } else if (event.type === "tool_call") {
          calls.push(event.call);
        }
      }
    } catch (cause) {
      if (turn !== current || current.abort.signal.aborted) return;
      tts?.cancel(current.contextId);
      recordAgent(current);
      turn = undefined;
      emitter.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
      // Nunca muda: quem ligou ouve uma desculpa e pode repetir.
      speakApology();
      return;
    }
    if (turn !== current) return;
    const tail = limiter.flush();
    text += tail;
    pending += tail;
    current.written = true;
    if (current.spoken !== "" || pending.trim() !== "") send(pending, true);
    let kept = text;
    if (heldAny) {
      const writes = calls.some((call) => WRITE_TOOLS.has(call.function.name));
      if (writes || heldCoveredByFailure) {
        // Confirmação antes do resultado (ou depois de uma falha): não é falada, nem fica no histórico como dita.
        for (const piece of held) kept = kept.replace(piece, "");
        if (current.spoken !== "") emit("", true);
        if (!writes && current.spoken === "") {
          const apology = WRITE_UNAVAILABLE[lang] ?? WRITE_UNAVAILABLE.en ?? "";
          kept = apology;
          emit(apology, true);
        }
      } else {
        for (const piece of held) emit(piece, false);
        emit("", true);
      }
    }
    history.push({ role: "assistant", content: kept.trim() === "" ? null : kept.trim(), ...(calls.length > 0 && { tool_calls: calls }) });
    if (calls.length > 0) {
      recordAgent(current);
      for (const call of calls) awaitingTools.set(call.id, call);
      for (const call of calls) emitter.emit("toolCall", { id: call.id, name: call.function.name, args: parseArguments(call.function.arguments) });
    }
    if (!current.synthesizing) {
      recordAgent(current);
      if (turn === current) turn = undefined;
    }
  };

  const startResponse = (endedAt: number | undefined, delay: number, question?: string): void => {
    const pending = respond(endedAt, delay, question);
    activeResponses.add(pending);
    void pending.finally(() => activeResponses.delete(pending));
  };

  const endCallerTurn = (): void => {
    cancelEndpoint?.();
    cancelEndpoint = undefined;
    cancelSpeculation?.();
    cancelSpeculation = undefined;
    const text = [...finals, ...(finals.length === 0 && partial ? [partial] : [])].join(" ").trim();
    finals = [];
    partial = "";
    if (text === "" || finished) return;
    const endedAt = lastFinalAt || now();
    const delay = turnDelay;
    emitter.emit("transcript", { speaker: "user", text });
    flushUsage();
    if (awaitingTools.size > 0) {
      queuedUser.push({ text, endedAt, delay });
      return;
    }
    // O modelo ainda pensava no turno anterior: recomeça com tudo o que a pessoa disse.
    if (turn) stopTurn(false);
    history.push({ role: "user", content: text });
    startResponse(endedAt, delay, text);
  };

  let turnDelay = 0;
  const sttHandlers: SttHandlers = {
    partial(text) {
      if (finished) return;
      partial = text;
      // A pessoa continua falando: o fim de turno marcado não vale mais.
      cancelEndpoint?.();
      cancelEndpoint = undefined;
      emitter.emit("callerActivity", { words: true });
      amd?.pushTranscript(text);
      // Palavra que o agente acabou de dizer é eco do microfone, não pessoa interrompendo.
      if (!isEchoOf(text, recentAgentText)) {
        bargeIn();
        speculate(SPECULATE_DEBOUNCE_MS);
      }
    },
    final(text, speechFinal) {
      if (finished) return;
      if (text !== "") {
        finals.push(text);
        partial = "";
        lastFinalAt = now();
        emitter.emit("callerActivity", { words: true });
        amd?.pushTranscript(text);
        // O trecho final é definitivo: a busca sai já, e o prazo de fim de turno que vem a seguir é o que ela usa para chegar.
        speculate(0);
      }
      if (!speechFinal || finals.length === 0) return;
      cancelEndpoint?.();
      turnDelay = endpointDelayMs(finals.join(" "), config.listeningEnvironment);
      cancelEndpoint = schedule(endCallerTurn, turnDelay);
    },
    speechStarted() {
      if (finished) return;
      cancelEndpoint?.();
      cancelEndpoint = undefined;
      // Só sinaliza: o provedor também "vê fala" no eco e no ruído. Quem corta o agente é a
      // transcrição (que não seja eco) ou o detector de energia sustentado.
      emitter.emit("callerActivity", { words: false });
    },
    utteranceEnd() {
      if (finished || finals.length === 0) return;
      turnDelay = 0;
      endCallerTurn();
    },
    failed: (error) => {
      if (opening) openingFailure ??= error;
      else void fail(error);
    },
  };

  const ttsHandlers: TtsHandlers = {
    audio(contextId, pcm16) {
      if (finished || (!sayContexts.has(contextId) && turn?.contextId !== contextId)) return;
      const at = now();
      const current = turn;
      if (current && contextId === current.contextId && !current.measured && current.ttsStartedAt !== undefined) {
        current.measured = true;
        if (current.userEndedAt !== undefined) {
          const metrics: TurnMetrics = {
            turn: current.id,
            endpointDelayMs: current.endpointDelayMs,
            llmFirstTokenMs: (current.firstTokenAt ?? at) - current.userEndedAt,
            ttfbMs: current.ttfbMs ?? at - current.ttsStartedAt,
            rttMs: at - current.userEndedAt,
          };
          deps.onMetrics?.(metrics);
          emitter.emit("turnMetrics", metrics);
        }
      }
      playhead = Math.max(playhead, at) + pcm16.length / BYTES_PER_MS;
      emitter.emit("audio", pcm16);
    },
    firstAudio(contextId, ttfbMs) {
      if (turn && turn.contextId === contextId) turn.ttfbMs = ttfbMs;
    },
    done(contextId) {
      if (sayContexts.has(contextId)) {
        recordSay(contextId);
        flushUsage();
        return;
      }
      const current = turn;
      if (!current || current.contextId !== contextId) return;
      current.synthesizing = false;
      flushUsage();
      if (current.written) {
        recordAgent(current);
        turn = undefined;
        const next = afterSynthesis;
        afterSynthesis = undefined;
        next?.();
      }
    },
    error: (error) => {
      if (opening) openingFailure ??= error;
      else void fail(error);
    },
    failed: (error) => {
      if (opening) openingFailure ??= error;
      else void fail(error);
    },
  };

  let stt: SttPort | undefined;
  let tts: TtsPort | undefined;
  const opened = await Promise.allSettled([deps.openStt(sttHandlers), deps.openTts(ttsHandlers)]);
  const [sttOpen, ttsOpen] = opened;
  if (sttOpen?.status === "fulfilled") stt = sttOpen.value;
  if (ttsOpen?.status === "fulfilled") tts = ttsOpen.value;
  const refused = opened.find((result): result is PromiseRejectedResult => result.status === "rejected");
  opening = false;
  if (refused || openingFailure) {
    // Uma das pontas não abriu: a outra fecha, e o `connect` rejeita com o motivo de quem falhou.
    finished = true;
    await Promise.allSettled([stt?.close(), tts?.close()]);
    const cause: unknown = openingFailure ?? refused?.reason;
    throw cause instanceof Error ? cause : new Error(String(cause));
  }

  const shutdown = async (reason: string): Promise<void> => {
    finished = true;
    cancelEndpoint?.();
    if (turn) recordAgent(turn);
    turn?.abort.abort();
    turn = undefined;
    for (const contextId of [...sayContexts.keys()]) recordSay(contextId);
    await Promise.allSettled([...activeResponses]);
    flushUsage();
    await Promise.allSettled([stt?.close(), tts?.close()]);
    emitter.emit("closed", reason);
  };

  const fail = async (error: Error): Promise<void> => {
    if (closing) return;
    emitter.emit("error", error);
    closing = shutdown("socket_closed");
    await closing;
  };

  let audioBytesSinceUsage = 0;
  const session: VoiceSession = {
    on: (event, handler) => emitter.on(event, handler),
    sendAudio(pcm16_8k) {
      if (finished) return;
      stt?.sendAudio(pcm16_8k);
      audioBytesSinceUsage += pcm16_8k.length;
      if (audioBytesSinceUsage >= 16000) {
        audioBytesSinceUsage %= 16000;
        flushUsage();
      }
      amd?.pushAudio(pcm16_8k);
      for (const event of vad.push(pcm16_8k)) {
        if (event.type !== "speech_start") continue;
        cancelEndpoint?.();
        cancelEndpoint = undefined;
        emitter.emit("callerActivity", { words: false });
      }
      for (const event of bargeVad.push(pcm16_8k)) if (event.type === "speech_start") bargeIn();
    },
    sendToolResult(id, result) {
      if (finished) return;
      const call = awaitingTools.get(id);
      if (!awaitingTools.delete(id)) return;
      if (call && WRITE_TOOLS.has(call.function.name) && result && typeof result === "object") {
        const kind = writeKindOf(call.function.name);
        if ((result as { ok?: unknown }).ok !== true) writeFailure = { kind, startsAt: startsAtOfCall(call.function.arguments), responsesLeft: WRITE_FAILURE_RESPONSES };
        else if (writeFailure?.kind === kind) writeFailure = undefined;
      }
      toolResults.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result ?? null) });
      if (awaitingTools.size > 0) return;
      history.push(...toolResults);
      toolResults = [];
      const waiting = queuedUser;
      queuedUser = [];
      for (const item of waiting) history.push({ role: "user", content: item.text });
      const last = waiting.at(-1);
      const question = waiting.length > 0 ? waiting.map((item) => item.text).join(" ") : undefined;
      const next = () => startResponse(last?.endedAt, last?.delay ?? 0, question);
      if (turn?.synthesizing) afterSynthesis = next;
      else next();
    },
    say(text) {
      if (finished || text.trim() === "") return;
      if (turn || agentAudible()) stopTurn(true);
      const contextId = `say-${++saySeq}`;
      sayContexts.set(contextId, text);
      rememberAgentText(text);
      tts?.speak(contextId, speakable(text), true);
      history.push({ role: "assistant", content: text });
    },
    closeCallerTurn() {
      if (finished) return;
      if (finals.length > 0 || partial !== "") {
        turnDelay = 0;
        endCallerTurn();
        return;
      }
      stt?.finalize();
    },
    close() {
      closing ??= shutdown("client");
      return closing;
    },
  };

  if (config.greeting) session.say(config.greeting);
  return session;
}

/** Argumento de função do modelo em JSON; texto que não é JSON vai como está, e a ferramenta valida. */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
