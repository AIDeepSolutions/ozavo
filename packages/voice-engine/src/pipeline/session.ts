import type { Clock } from "@ozavo/core";
import { SessionEmitter } from "../emitter";
import { instructionsWithVocabulary } from "../vocabulary";
import type { AnsweringMachineDetection, ToolSpec, TurnLatency, Usage, VoiceSession, VoiceSessionConfig } from "../types";
import { AnsweringMachineDetector, type AmdOptions } from "./amd";
import type { CartesiaTts, TtsHandlers } from "./cartesia-tts";
import type { DeepgramStt, SttHandlers } from "./deepgram-stt";
import { endpointDelayMs } from "./endpointing";
import type { ChatMessage, ChatToolCall, LlmEvent } from "./openrouter-llm";
import { TURN_TARGET_MAX_CHARACTERS, createTurnLimiter } from "./turn-guard";
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
  /** `false` desliga a detecção de caixa postal. */
  amd?: AmdOptions | false;
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
  "Aim for 120 to 160 characters per turn; shorter answers are allowed. Never exceed 160 characters: anything longer is cut off before it is spoken. " +
  "When a tool is needed, call it instead of describing it.";

/** Bytes por milissegundo do PCM16 mono 8 kHz. */
const BYTES_PER_MS = 16;

/**
 * Onde cortar o texto do modelo para mandar à síntese: fim de frase, ou vírgula num trecho já
 * longo. O primeiro trecho do turno corta mais cedo, que é o que derruba o TTFB percebido.
 */
export function splitPoint(text: string, first: boolean): number {
  const strong = /[.!?…](\s|$)/g;
  for (let match = strong.exec(text); match; match = strong.exec(text)) {
    const end = match.index + 1;
    if (end >= (first ? 4 : 12)) return end;
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

  const flushUsage = (llm?: Partial<Usage>): void => {
    const seconds = stt?.drainSeconds() ?? 0;
    const characters = tts?.drainCharacters() ?? 0;
    if (!llm && seconds === 0 && characters === 0) return;
    emitter.emit("usage", { seconds, characters, ...llm });
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

  const respond = async (userEndedAt: number | undefined, endpointDelay: number): Promise<void> => {
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
    let text = "";
    let pending = "";
    // O limitador suave do turno: o que passa do alvo de caracteres não chega à síntese.
    const limiter = createTurnLimiter();
    const calls: ChatToolCall[] = [];
    const send = (piece: string, final: boolean): void => {
      if (piece.trim() === "" && !final) return;
      if (current.ttsStartedAt === undefined && piece.trim() !== "") current.ttsStartedAt = now();
      if (piece.trim() !== "") current.synthesizing = true;
      current.spoken += piece;
      tts?.speak(current.contextId, piece, final);
      flushUsage();
    };
    try {
      for await (const event of deps.chat(history, config.tools, current.abort.signal)) {
        if (event.type === "usage") {
          const { promptTokens, cachedTokens, completionTokens, costCents } = event.usage;
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
    history.push({ role: "assistant", content: text.trim() === "" ? null : text.trim(), ...(calls.length > 0 && { tool_calls: calls }) });
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

  const startResponse = (endedAt: number | undefined, delay: number): void => {
    const pending = respond(endedAt, delay);
    activeResponses.add(pending);
    void pending.finally(() => activeResponses.delete(pending));
  };

  const endCallerTurn = (): void => {
    cancelEndpoint?.();
    cancelEndpoint = undefined;
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
    startResponse(endedAt, delay);
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
      bargeIn();
    },
    final(text, speechFinal) {
      if (finished) return;
      if (text !== "") {
        finals.push(text);
        partial = "";
        lastFinalAt = now();
        emitter.emit("callerActivity", { words: true });
        amd?.pushTranscript(text);
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
      emitter.emit("callerActivity", { words: false });
      bargeIn();
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
        bargeIn();
      }
    },
    sendToolResult(id, result) {
      if (finished || !awaitingTools.delete(id)) return;
      toolResults.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result ?? null) });
      if (awaitingTools.size > 0) return;
      history.push(...toolResults);
      toolResults = [];
      const waiting = queuedUser;
      queuedUser = [];
      for (const item of waiting) history.push({ role: "user", content: item.text });
      const last = waiting.at(-1);
      const next = () => startResponse(last?.endedAt, last?.delay ?? 0);
      if (turn?.synthesizing) afterSynthesis = next;
      else next();
    },
    say(text) {
      if (finished || text.trim() === "") return;
      if (turn || agentAudible()) stopTurn(true);
      const contextId = `say-${++saySeq}`;
      sayContexts.set(contextId, text);
      tts?.speak(contextId, text, true);
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
