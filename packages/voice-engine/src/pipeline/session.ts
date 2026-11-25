import type { Clock } from "@ozavo/core";
import { SessionEmitter } from "../emitter";
import { instructionsWithVocabulary } from "../vocabulary";
import { CONTEXT_MAX_TOKENS, formatRetrievedContext } from "../knowledge-prompt";
import type { AnsweringMachineDetection, KnowledgeCallInfo, ToolSpec, TurnLatency, Usage, VoiceSession, VoiceSessionConfig } from "../types";
import { AnsweringMachineDetector, type AmdOptions } from "./amd";
import type { CartesiaTts, TtsHandlers } from "./cartesia-tts";
import type { DeepgramStt, SttHandlers } from "./deepgram-stt";
import { assessTurnEnd, endpointDelayMs, type TurnEndKind } from "./endpointing";
import { BRIDGE_TEXTS, BridgeStore, durationMs, pickBridge, sensitiveTurn, sharedBridgeStore, trimEdges, type BridgePhrase } from "./bridge";
import { resolveLatency, withStablePrefix } from "./latency";
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
  /**
   * Chamada de aquecimento: o mesmo prefixo da conversa (instrução + ferramentas), uma resposta mínima. Esquenta a conexão com o
   * provedor e o cache do prefixo antes do primeiro turno. Ausente, não há aquecimento.
   */
  warm?(messages: readonly ChatMessage[], tools: readonly ToolSpec[], signal: AbortSignal): AsyncIterable<LlmEvent>;
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
  /** Detector de pausa local (padrão: `PAUSE_VAD`), que marca o fim REAL da fala para a medida de latência. */
  pauseVad?: VadOptions;
  /** Onde ficam as frases de ponte já sintetizadas (padrão: o do processo). */
  bridgeStore?: BridgeStore;
  /** Sorteio da frase de ponte (padrão: `Math.random`). */
  random?: () => number;
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

/** O recado do aquecimento: curto, sem pedir nada (o modelo só precisa receber o prefixo). */
const WARMUP_USER_TEXT: Record<string, string> = { pt: "Oi.", en: "Hi.", es: "Hola." };

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

/** Pausa local: 5 quadros (100 ms) de silêncio depois de fala marcam o fim REAL da fala. */
const PAUSE_VAD: VadOptions = { stopFrames: 5 };

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
  /** Quando o turno foi dado por encerrado e o pedido ao modelo saiu. */
  commitAt: number;
  firstTokenAt?: number;
  ttsStartedAt?: number;
  ttfbMs?: number;
  /** O provedor do modelo que respondeu (do extrato de uso). */
  provider?: string;
  /** Quando a frase de ponte começou a tocar neste turno. */
  bridgeAt?: number;
  /** Cancela os prazos da frase de ponte (o texto chegou, ou o turno acabou). */
  cancelBridge?: () => void;
  /** Quantas vezes o pedido foi refeito no provedor seguinte por demora no primeiro texto. */
  retries?: number;
  /** `hit`: a resposta veio de um pedido adiantado; `miss`: um pedido adiantado foi descartado e este refez. */
  speculation?: "hit" | "miss";
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

/**
 * Pedido ao modelo que saiu antes de o fim de turno estar decidido. Os eventos ficam guardados (nada vai à síntese): se o turno
 * fechar com o mesmo texto, a resposta é aproveitada daqui; se a pessoa continuar, o pedido é descartado.
 */
interface Speculation {
  /** O texto da pessoa com que o pedido saiu, comparável (sem pontuação nem caixa). */
  key: string;
  /** Tamanho do histórico quando saiu: se mudou (resultado de ferramenta, fala avulsa), o pedido não vale mais. */
  historyLength: number;
  abort: AbortController;
  events: LlmEvent[];
  done: boolean;
  error?: unknown;
  wake?: () => void;
  firstEventAt?: number;
  /** O extrato de uso do pedido já foi entregue a um turno (então o custo dele já foi contado). */
  usageSeen?: boolean;
  startedAt: number;
  /** Os trechos da base que o pedido levou (modo de busca): valem para o turno que o aproveitar. */
  knowledge?: { context: string | undefined; info: KnowledgeCallInfo };
}

const speechKey = (text: string): string => normalizeWords(text).join(" ");

export async function createPipelineSession(deps: PipelineSessionDeps): Promise<VoiceSession> {
  const { config, clock } = deps;
  const schedule = deps.schedule ?? scheduleTimeout;
  const emitter = new SessionEmitter();
  const now = (): number => clock.now().getTime();
  const lang = config.language.split("-")[0]?.toLowerCase() ?? "pt";

  const history: ChatMessage[] = [
    {
      role: "system",
      // O que varia por ligação (contexto do pedido de saída) vai por último: o prefixo fica igual para o cache do provedor.
      content: withStablePrefix(instructionsWithVocabulary(config.instructions, config.vocabulary), `${LANGUAGE_RULE[lang] ?? `Always answer in ${config.language}.`} ${PHONE_STYLE}`),
    },
  ];
  const vad = new EnergyVad(deps.vad);
  const latency = resolveLatency(config.latency);
  const bargeVad = new EnergyVad(deps.bargeInVad ?? BARGE_IN_VAD);
  const pauseVad = new EnergyVad({ ...(deps.pauseVad ?? PAUSE_VAD), stopFrames: Math.max(1, Math.round(latency.pauseMs / 20)) });
  /** Quando a pessoa parou de falar de verdade (último quadro com voz), pelo áudio; `undefined` enquanto ela fala. */
  let speechEndedAt: number | undefined;
  const environment = config.listeningEnvironment ?? "normal";
  /** Pedido adiantado ao modelo, se há um. */
  let speculation: Speculation | undefined;
  /** Um pedido adiantado foi descartado neste turno (a pessoa continuou): o turno que vier a seguir leva a marca. */
  let speculationMissed = false;
  /** Custo da última chamada completa ao modelo, para estimar o de um pedido adiantado descartado (o provedor não manda extrato). */
  let lastCallCostCents = 0;
  let lastPromptTokens = 0;
  const bridgeStore = deps.bridgeStore ?? sharedBridgeStore;
  const bridgeKey = BridgeStore.keyOf(config.voiceId, lang);
  const bridgeTexts = BRIDGE_TEXTS[lang];
  /** Contexto de síntese de uma frase de ponte (guardada ao terminar), por id de contexto. */
  const bridgeSynth = new Map<string, { text: string; tier: "short" | "long"; chunks: Buffer[] }>();
  let bridgeSeq = 0;
  const recentBridges: string[] = [];
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

  /** Custo dos embeddings das perguntas ainda não lançado no extrato (centavos de dólar): vai junto da próxima leitura de uso, que sai a cada segundo de áudio ou fim de fala. */
  let pendingEmbeddingCents = 0;
  const flushUsage = (llm?: Partial<Usage>): void => {
    const seconds = stt?.drainSeconds() ?? 0;
    const characters = tts?.drainCharacters() ?? 0;
    if (!llm && seconds === 0 && characters === 0 && pendingEmbeddingCents === 0) return;
    const embeddingCents = pendingEmbeddingCents;
    pendingEmbeddingCents = 0;
    emitter.emit("usage", { seconds, characters, ...llm, ...(embeddingCents > 0 && { providerCostCents: (llm?.providerCostCents ?? 0) + embeddingCents }) });
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
          onEmbedded: ({ costMicrocents }) => void (pendingEmbeddingCents += costMicrocents / 1_000_000),
        })
      : undefined;
  /** Os trechos do último turno de quem ligou: valem também para a continuação do turno depois de uma ferramenta. */
  let knowledgeContext: string | undefined;
  let cancelKnowledgeSpeculation: (() => void) | undefined;
  /** A busca especulativa: o texto de quem ligou até agora (finais + parcial), depois de um tempo sem mudar. */
  const speculateKnowledge = (delayMs: number): void => {
    if (!retriever) return;
    cancelKnowledgeSpeculation?.();
    cancelKnowledgeSpeculation = undefined;
    const text = [...finals, ...(partial ? [partial] : [])].join(" ").trim();
    if (wordCount(text) < SPECULATE_MIN_WORDS) return;
    if (delayMs <= 0) return retriever.speculate(text, true);
    cancelKnowledgeSpeculation = schedule(() => {
      cancelKnowledgeSpeculation = undefined;
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
      current.cancelBridge?.();
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

  /** Toca uma frase de ponte: o áudio guardado vai direto à saída, na fila do que o agente já fala. */
  const playBridge = (phrase: BridgePhrase, current: AgentTurn): void => {
    const at = now();
    playhead = Math.max(playhead, at) + phrase.pcm.length / BYTES_PER_MS;
    rememberAgentText(phrase.text);
    recentBridges.push(phrase.text);
    if (recentBridges.length > 2) recentBridges.shift();
    current.bridgeAt ??= at;
    emitter.emit("audio", phrase.pcm);
  };

  /**
   * Se o primeiro texto do modelo não chegar em `bridgeAfterMs` depois do pedido, toca uma frase curta; se mesmo assim não chegar
   * quando ela acabar, uma mais longa. Nunca antes de uma ferramenta sensível, nunca em turno que continua um resultado de ferramenta.
   */
  const scheduleBridge = (current: AgentTurn): void => {
    if (!latency.bridge || !bridgeTexts || finished) return;
    const lastAgent = [...history].reverse().find((message) => message.role === "assistant" && typeof message.content === "string")?.content;
    if (sensitiveTurn(typeof lastAgent === "string" ? lastAgent : undefined, hasWriteTools)) return;
    let cancelNext: (() => void) | undefined;
    const attempt = (tier: "short" | "long"): void => {
      if (turn !== current || current.firstTokenAt !== undefined || finished) return;
      const phrase = pickBridge(bridgeStore.get(bridgeKey), tier, recentBridges, deps.random);
      if (!phrase) return;
      playBridge(phrase, current);
      if (tier === "short") cancelNext = schedule(() => attempt("long"), Math.ceil(durationMs(phrase)) + 300);
    };
    const cancelFirst = schedule(() => attempt("short"), Math.max(0, latency.bridgeAfterMs - (now() - current.commitAt)));
    current.cancelBridge = () => {
      cancelFirst();
      cancelNext?.();
      current.cancelBridge = undefined;
    };
  };

  /** Sintetiza, uma de cada vez e só com a voz livre, as frases de ponte que ainda faltam para esta voz e este idioma. */
  const synthesizeNextBridge = (): void => {
    if (!latency.bridge || !bridgeTexts || finished || !tts || bridgeSynth.size > 0 || sayContexts.size > 0 || turn) return;
    const missing = ([["short", bridgeTexts.short], ["long", bridgeTexts.long]] as const).flatMap(([tier, texts]) => texts.map((text) => ({ tier, text }))).find(({ text }) => !bridgeStore.has(bridgeKey, text));
    if (!missing) return;
    const contextId = `bridge-${++bridgeSeq}`;
    bridgeSynth.set(contextId, { text: missing.text, tier: missing.tier, chunks: [] });
    tts.speak(contextId, missing.text, true);
  };

  const respond = async (userEndedAt: number | undefined, endpointDelay: number, adopted?: Speculation, missed = false, question?: string, afterTool = false): Promise<void> => {
    const current: AgentTurn = {
      id: ++turnSeq,
      contextId: `turn-${turnSeq}`,
      abort: new AbortController(),
      userEndedAt,
      endpointDelayMs: endpointDelay,
      commitAt: now(),
      ...(adopted && { speculation: "hit" as const }),
      ...(!adopted && missed && { speculation: "miss" as const }),
      measured: false,
      spoken: "",
      written: false,
      synthesizing: false,
      recorded: false,
    };
    turn = current;
    if (userEndedAt !== undefined && !afterTool) scheduleBridge(current);
    // Os trechos da base para esta fala (modo de busca): a busca é especulativa e tem orçamento, então a espera é curta e nunca falha.
    // Um pedido adiantado já trouxe os trechos da fala que ele usou: valem os dele.
    let knowledgeInfo: KnowledgeCallInfo | undefined = knowledge?.mode === "full" ? { mode: "full", hits: [], retrievalMs: 0, speculative: false, usedVector: false, embeddingTokens: 0 } : undefined;
    if (adopted?.knowledge) {
      knowledgeContext = adopted.knowledge.context;
      knowledgeInfo = { ...adopted.knowledge.info, embeddingTokens: retriever?.settle() ?? 0 };
    } else if (retriever && question !== undefined) {
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
      for await (const event of adopted ? replay(adopted, current.abort.signal) : deps.chat(withKnowledgeContext(history, knowledgeContext), config.tools, current.abort.signal)) {
        if (event.type === "fallback") {
          emitter.emit("llmCall", { promptTokens: 0, cachedTokens: 0, completionTokens: 0, fallback: true, fallbackStatus: event.status });
          continue;
        }
        if (event.type === "retry") {
          // O primeiro provedor demorou e o pedido foi refeito no próximo: o pedido cortado também custou (estimado pelo último extrato).
          current.retries = (current.retries ?? 0) + 1;
          chargeDiscarded("retry", undefined, event.provider);
          continue;
        }
        if (event.type === "usage") {
          const { promptTokens, cachedTokens, completionTokens, costCents } = event.usage;
          if (event.usage.provider && turn === current) current.provider = event.usage.provider;
          if (event.usage.provider) {
            lastCallCostCents = event.usage.costCents;
            lastPromptTokens = event.usage.promptTokens;
          }
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
          current.cancelBridge?.();
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
      current.cancelBridge?.();
      if (turn !== current || current.abort.signal.aborted) return;
      tts?.cancel(current.contextId);
      recordAgent(current);
      turn = undefined;
      emitter.emit("error", cause instanceof Error ? cause : new Error(String(cause)));
      // Nunca muda: quem ligou ouve uma desculpa e pode repetir.
      speakApology();
      return;
    }
    current.cancelBridge?.();
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

  /**
   * Um pedido ao modelo que foi cortado (adiantado e descartado, ou refeito no provedor seguinte) não manda extrato, mas custou: entra na
   * conta pelo custo da última chamada completa (ou, antes de haver uma, pelo do aquecimento).
   */
  const chargeDiscarded = (purpose: "speculative" | "retry", spec?: Speculation, provider?: string): void => {
    if (spec) spec.usageSeen = true;
    emitter.emit("llmCall", { purpose, ...(provider && { provider }), promptTokens: lastPromptTokens, cachedTokens: 0, completionTokens: 0 });
    flushUsage({ providerCostCents: lastCallCostCents });
  };

  /** Entrega, na ordem, os eventos que o pedido adiantado já recebeu e os que ainda vão chegar. */
  async function* replay(spec: Speculation, signal: AbortSignal): AsyncGenerator<LlmEvent> {
    let index = 0;
    // Um só ouvinte do corte para a espera inteira (um por espera acumulava ouvintes numa resposta de muitos pedaços).
    const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    for (;;) {
      if (signal.aborted) {
        spec.abort.abort();
        // Cortado (a pessoa falou por cima) antes de o extrato chegar: o pedido custou mesmo assim.
        if (!spec.usageSeen) chargeDiscarded("speculative", spec);
        return;
      }
      while (index < spec.events.length) {
        const next = spec.events[index++];
        if (next?.type === "usage") spec.usageSeen = true;
        if (next) yield next;
      }
      if (spec.done) {
        if (spec.error) throw spec.error;
        return;
      }
      await Promise.race([new Promise<void>((resolve) => (spec.wake = resolve)), aborted]);
    }
  }

  /** Larga o pedido adiantado (a pessoa continuou, ou o texto mudou). Conta como gasto estimado: o provedor não manda extrato de um pedido cortado. */
  const dropSpeculation = (markMissed = true): void => {
    const spec = speculation;
    if (!spec) return;
    speculation = undefined;
    if (markMissed) speculationMissed = true;
    spec.abort.abort();
    chargeDiscarded("speculative", spec);
  };

  /** Começa o pedido ao modelo com o texto que já temos, sem falar nada, antes de o fim de turno estar decidido. */
  const startSpeculation = (text: string): void => {
    if (!latency.speculation || finished || turn || awaitingTools.size > 0) return;
    const key = speechKey(text);
    if (speculation) {
      if (speculation.key === key && speculation.historyLength === history.length) return;
      dropSpeculation();
    }
    const spec: Speculation = { key, historyLength: history.length, abort: new AbortController(), events: [], done: false, startedAt: now() };
    speculation = spec;
    const wake = (): void => {
      const waiting = spec.wake;
      spec.wake = undefined;
      waiting?.();
    };
    void (async () => {
      try {
        if (retriever) {
          // Modo de busca: o pedido adiantado leva os trechos da fala parcial, buscados como no fim do turno (mesmo orçamento).
          const retrieved = await retriever.forTurn(text, true);
          if (spec.abort.signal.aborted) return;
          spec.knowledge = { context: formatRetrievedContext(retrieved.hits, { language: config.language, only: knowledge?.only === true, maxTokens: CONTEXT_MAX_TOKENS }).text, info: retrieved.info };
        }
        for await (const event of deps.chat(withKnowledgeContext([...history, { role: "user", content: text }], spec.knowledge?.context), config.tools, spec.abort.signal)) {
          if (spec.abort.signal.aborted) return;
          if (event.type === "text" || event.type === "tool_call") spec.firstEventAt ??= now();
          spec.events.push(event);
          wake();
        }
      } catch (cause) {
        spec.error = cause;
      } finally {
        spec.done = true;
        wake();
      }
    })();
  };

  /** O pedido adiantado, se ainda vale para este texto e este histórico; senão, descarta. */
  const takeSpeculation = (text: string): Speculation | undefined => {
    const spec = speculation;
    if (!spec) return undefined;
    if (spec.key !== speechKey(text) || spec.historyLength !== history.length - 1 || spec.abort.signal.aborted || spec.error) {
      dropSpeculation();
      return undefined;
    }
    speculation = undefined;
    return spec;
  };

  const startResponse = (endedAt: number | undefined, delay: number, adopted?: Speculation, missed = false, question?: string, afterTool = false): void => {
    const pending = respond(endedAt, delay, adopted, missed, question, afterTool);
    activeResponses.add(pending);
    void pending.finally(() => activeResponses.delete(pending));
  };

  const endCallerTurn = (): void => {
    cancelEndpoint?.();
    cancelEndpoint = undefined;
    cancelKnowledgeSpeculation?.();
    cancelKnowledgeSpeculation = undefined;
    const text = [...finals, ...(finals.length === 0 && partial ? [partial] : [])].join(" ").trim();
    finals = [];
    partial = "";
    if (text === "" || finished) {
      dropSpeculation(false);
      speculationMissed = false;
      return;
    }
    // O fim real da fala (pausa vista no áudio) vale mais que a chegada do último texto, que vem ~0,3 a 0,6 s depois.
    const endedAt = speechEndedAt ?? (lastFinalAt || now());
    // A pausa vale para este turno só: um valor velho faria o próximo final, no meio de outra fala, fechar o turno.
    speechEndedAt = undefined;
    const delay = turnDelay;
    emitter.emit("transcript", { speaker: "user", text });
    flushUsage();
    if (awaitingTools.size > 0) {
      dropSpeculation(false);
      queuedUser.push({ text, endedAt, delay });
      return;
    }
    // O modelo ainda pensava no turno anterior: recomeça com tudo o que a pessoa disse.
    if (turn) stopTurn(false);
    history.push({ role: "user", content: text });
    const adopted = takeSpeculation(text);
    const missed = speculationMissed;
    speculationMissed = false;
    startResponse(endedAt, delay, adopted, missed, text);
  };

  /** Um final chegou e o turno pode estar acabando: decide quanto esperar, e adianta o pedido ao modelo se a frase parece fechada. */
  const scheduleTurnEnd = (paused: boolean): void => {
    const text = finals.join(" ");
    const assessment = assessTurnEnd(text, environment);
    const delay = paused && speechEndedAt !== undefined ? Math.max(0, assessment.silenceMs - (now() - speechEndedAt)) : endpointDelayMs(text, environment);
    turnDelay = delay;
    if (delay <= 0) {
      cancelEndpoint = undefined;
      endCallerTurn();
      return;
    }
    cancelEndpoint = schedule(endCallerTurn, delay);
    const likelyDone: readonly TurnEndKind[] = ["closed", "short", "default"];
    // Só com a pausa confirmada pelo áudio: sem ela o prazo vem do provedor, e adiantar o pedido seria chutar.
    if (paused && likelyDone.includes(assessment.kind)) startSpeculation(text);
  };

  let turnDelay = 0;
  const sttHandlers: SttHandlers = {
    partial(text) {
      if (finished) return;
      partial = text;
      // Texto novo: a pessoa continua falando, e o fim de turno marcado não vale mais. Parcial que só repete o que o provedor já
      // entregou como final (chega depois do `Finalize`) não é continuação.
      if (finals.length === 0 || !isEchoOf(text, finals.join(" "))) {
        cancelEndpoint?.();
        cancelEndpoint = undefined;
        dropSpeculation();
      }
      emitter.emit("callerActivity", { words: true });
      amd?.pushTranscript(text);
      // Palavra que o agente acabou de dizer é eco do microfone, não pessoa interrompendo.
      if (!isEchoOf(text, recentAgentText)) {
        bargeIn();
        speculateKnowledge(SPECULATE_DEBOUNCE_MS);
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
        if (!isEchoOf(text, recentAgentText)) speculateKnowledge(0);
      }
      if (finals.length === 0) return;
      // Com o fim de turno por pausa, um final que chega durante a pausa também pode fechar o turno (pedimos esse final ao provedor).
      const paused = latency.fastEndpoint && speechEndedAt !== undefined;
      if (!speechFinal && !paused) return;
      cancelEndpoint?.();
      scheduleTurnEnd(paused);
    },
    speechStarted() {
      if (finished) return;
      cancelEndpoint?.();
      cancelEndpoint = undefined;
      dropSpeculation();
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
      const collecting = bridgeSynth.get(contextId);
      if (collecting) {
        collecting.chunks.push(pcm16);
        return;
      }
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
            // O primeiro som é o da frase de ponte, se tocou; o da resposta de verdade é quando o áudio dela começa de fato (depois da ponte).
            rttMs: (current.bridgeAt ?? at) - current.userEndedAt,
            answerMs: Math.max(at, playhead) - current.userEndedAt,
            ...(current.bridgeAt !== undefined && { bridge: true }),
            endpointMs: Math.max(0, current.commitAt - current.userEndedAt),
            ...(current.firstTokenAt !== undefined && { modelMs: current.firstTokenAt - current.commitAt, firstSentenceMs: current.ttsStartedAt - current.firstTokenAt }),
            ...(current.provider !== undefined && { provider: current.provider }),
            ...(current.speculation !== undefined && { speculation: current.speculation }),
            ...(current.retries !== undefined && { retries: current.retries }),
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
      const collecting = bridgeSynth.get(contextId);
      if (collecting) {
        bridgeSynth.delete(contextId);
        if (collecting.chunks.length > 0) bridgeStore.put(bridgeKey, { text: collecting.text, tier: collecting.tier, pcm: trimEdges(Buffer.concat(collecting.chunks)) });
        flushUsage();
        synthesizeNextBridge();
        return;
      }
      if (sayContexts.has(contextId)) {
        recordSay(contextId);
        flushUsage();
        synthesizeNextBridge();
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
        synthesizeNextBridge();
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

  const warmAbort = new AbortController();
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
    warmAbort.abort();
    dropSpeculation(false);
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
      for (const event of pauseVad.push(pcm16_8k)) {
        if (event.type === "speech_start") {
          speechEndedAt = undefined;
          // Voltou a falar: o fim de turno marcado e o pedido adiantado não valem mais.
          cancelEndpoint?.();
          cancelEndpoint = undefined;
          dropSpeculation();
        } else {
          speechEndedAt = now() - latency.pauseMs;
          // Pede ao provedor o texto do que foi dito até aqui, sem esperar o `speech_final` dele (~0,3 s a mais).
          if (latency.fastEndpoint) stt?.finalize();
        }
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
      const next = () => startResponse(last?.endedAt, last?.delay ?? 0, undefined, false, question, true);
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

  // Aquecimento: enquanto o aviso de gravação e a saudação tocam, uma chamada mínima ao modelo com o MESMO prefixo (instrução +
  // ferramentas) abre a conexão com o provedor e esquenta o cache dele, para o primeiro turno de verdade não pagar a partida a frio.
  // Falhar não atrapalha a ligação: fica registrado como uma chamada de aquecimento sem tokens.
  if (latency.warmup && deps.warm) {
    const warming = (async (): Promise<void> => {
      const startedAt = now();
      let firstTokenMs: number | undefined;
      try {
        for await (const event of deps.warm?.([...history, { role: "user", content: WARMUP_USER_TEXT[lang] ?? WARMUP_USER_TEXT.en ?? "Hi" }], config.tools, warmAbort.signal) ?? []) {
          if (event.type === "text" || event.type === "tool_call") firstTokenMs ??= now() - startedAt;
          if (event.type !== "usage") continue;
          const { promptTokens, cachedTokens, completionTokens, costCents } = event.usage;
          emitter.emit("llmCall", {
            purpose: "warmup",
            model: event.usage.model,
            provider: event.usage.provider,
            promptTokens,
            cachedTokens,
            cacheWriteTokens: event.usage.cacheWriteTokens,
            completionTokens,
            ...(firstTokenMs !== undefined && { firstTokenMs }),
          });
          if (event.usage.provider) {
            lastCallCostCents = costCents;
            lastPromptTokens = promptTokens;
          }
          flushUsage({ textInputTokens: Math.max(0, promptTokens - cachedTokens), cachedInputTokens: cachedTokens, textOutputTokens: completionTokens, providerCostCents: costCents });
        }
      } catch {
        if (!warmAbort.signal.aborted) emitter.emit("llmCall", { purpose: "warmup", finishReason: "error", promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
      }
    })();
    activeResponses.add(warming);
    void warming.finally(() => activeResponses.delete(warming));
  }
  if (config.greeting) session.say(config.greeting);
  else synthesizeNextBridge();
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
