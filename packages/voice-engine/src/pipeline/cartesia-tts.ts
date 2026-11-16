/**
 * Síntese de voz da Cartesia (Sonic), por WebSocket, com áudio G.711 μ-law a 8 kHz direto do
 * provedor: o mesmo formato da linha telefônica, sem reamostrar. O μ-law vira PCM16 8 kHz aqui,
 * porque a borda do Ozavo é sempre PCM16 (o AudioSocket).
 *
 * Documentação oficial consultada em 2026-11-16:
 *   - https://docs.cartesia.ai/api-reference/tts/websocket  (URL `wss://api.cartesia.ai/tts/websocket`,
 *     `cartesia_version`, cabeçalho `X-API-Key`, campos `model_id` (`sonic-3.6`), `transcript`, `voice`,
 *     `language`, `context_id`, `continue`, `output_format` `{ container: "raw", encoding: "pcm_mulaw",
 *     sample_rate: 8000 }`; respostas `chunk` (`data` em base64), `done`, `error`, `flush_done`,
 *     `timestamps`; cancelamento `{ context_id, cancel: true }`)
 *   - https://cartesia.ai/pricing  (1 crédito por caractere; o maior preço de excedente publicado é
 *     US$ 65 por milhão de créditos, no plano Pro)
 *
 * Medido contra o servidor real em 2026-11-16 nesta VPS: três sínteses curtas em pt,
 * sonic-3.6, voz padrão, pcm_mulaw 8 kHz: TTFB de 267, 265 e 266 ms. A meta de 100 ms
 * não foi atingida. Protocolo de áudio e `done` confirmados; qualidade perceptiva e ligação
 * telefônica real ainda não verificadas. Reproduzir: scripts/medir-pipeline.ts --live.
 */
import type { Clock } from "@ozavo/core";
import { z } from "zod";
import { SessionEmitter } from "../emitter";
import { openProviderSocket, type ProviderSocket } from "../provider-socket";
import { ulawToPcm16 } from "../resample";
import type { ConnectOptions } from "../types";

export const CARTESIA_WS_URL = "wss://api.cartesia.ai/tts/websocket";
export const CARTESIA_API_URL = "https://api.cartesia.ai";
export const CARTESIA_VERSION = "2026-08-14";
export const CARTESIA_MODEL = "sonic-3.6";
export const CARTESIA_OUTPUT_FORMAT = { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 } as const;

const serverMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chunk"), data: z.string(), context_id: z.string() }),
  z.object({ type: z.literal("done"), context_id: z.string() }),
  z.object({
    type: z.literal("error"),
    context_id: z.string().optional(),
    title: z.string().optional(),
    message: z.string().optional(),
    status_code: z.number().optional(),
  }),
]);

export interface CartesiaTtsOptions {
  apiKey: string;
  voiceId: string;
  /** BCP 47 (`pt-BR`); a Cartesia recebe só o idioma (`pt`). */
  language: string;
  clock: Clock;
  url?: string;
  model?: string;
  timeout?: Pick<ConnectOptions, "readyTimeoutMs" | "schedule">;
}

export interface TtsHandlers {
  /** Fala sintetizada, já em PCM16 mono 8 kHz. */
  audio(contextId: string, pcm16_8k: Buffer): void;
  /** O provedor terminou o contexto (toda a fala dele já saiu em `audio`). */
  done(contextId: string): void;
  /** Tempo entre o primeiro texto de um contexto e o primeiro áudio dele. */
  firstAudio(contextId: string, ttfbMs: number): void;
  /** Erro do provedor num contexto; a conexão continua. */
  error(error: Error): void;
  /** A conexão caiu sem ninguém pedir. */
  failed(error: Error): void;
}

export interface CartesiaTts {
  /** Manda um trecho de texto para o contexto. `final` diz que não vem mais nada nele. */
  speak(contextId: string, text: string, final: boolean): void;
  /** Para o contexto: o que ainda chegar dele é descartado. */
  cancel(contextId: string): void;
  /** Caracteres enviados desde a última leitura (é o que a Cartesia cobra). */
  drainCharacters(): number;
  close(): Promise<void>;
}

/** `pt-BR` → `pt`. */
export const cartesiaLanguage = (language: string): string => language.split("-")[0]?.toLowerCase() ?? language;

export async function openCartesiaTts(options: CartesiaTtsOptions, handlers: TtsHandlers): Promise<CartesiaTts> {
  const emitter = new SessionEmitter();
  const startedAt = new Map<string, number>();
  const heard = new Set<string>();
  const cancelled = new Set<string>();
  const schedule = options.timeout?.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });
  const deadlines = new Map<string, () => void>();
  const clearDeadline = (contextId: string): void => {
    deadlines.get(contextId)?.();
    deadlines.delete(contextId);
  };
  let characters = 0;
  let lastError: Error | undefined;
  emitter.on("error", (error) => (lastError = error));
  emitter.on("closed", (reason) => {
    if (reason !== "client") handlers.failed(lastError ?? new Error("Cartesia: a conexão caiu"));
  });

  const onMessage = (raw: unknown): void => {
    const parsed = serverMessage.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "error") {
      if (message.context_id && cancelled.has(message.context_id)) return;
      handlers.error(new Error("Cartesia: o provedor recusou a síntese"));
      return;
    }
    const contextId = message.context_id;
    if (cancelled.has(contextId)) return;
    if (message.type === "done") {
      clearDeadline(contextId);
      startedAt.delete(contextId);
      heard.delete(contextId);
      handlers.done(contextId);
      return;
    }
    if (!heard.has(contextId)) {
      heard.add(contextId);
      const start = startedAt.get(contextId);
      if (start !== undefined) handlers.firstAudio(contextId, options.clock.now().getTime() - start);
    }
    const ulaw = Buffer.from(message.data, "base64");
    if (ulaw.length > 0) handlers.audio(contextId, ulawToPcm16(ulaw));
  };

  const version = CARTESIA_VERSION;
  const socket: ProviderSocket = await openProviderSocket({
    url: `${options.url ?? CARTESIA_WS_URL}?cartesia_version=${version}`,
    headers: { "X-API-Key": options.apiKey, "Cartesia-Version": version },
    label: "Cartesia",
    emitter,
    privateErrors: true,
    onMessage,
    timeout: options.timeout,
  });

  const language = cartesiaLanguage(options.language);
  const model = options.model ?? CARTESIA_MODEL;
  return {
    speak(contextId, text, final) {
      if (cancelled.has(contextId)) return;
      if (!startedAt.has(contextId) && text.trim() !== "") startedAt.set(contextId, options.clock.now().getTime());
      clearDeadline(contextId);
      deadlines.set(contextId, schedule(() => {
        deadlines.delete(contextId);
        handlers.failed(new Error("Cartesia: prazo de síntese excedido"));
      }, 10000));
      characters += text.length;
      socket.send({
        model_id: model,
        transcript: text,
        voice: options.voiceId,
        language,
        context_id: contextId,
        output_format: CARTESIA_OUTPUT_FORMAT,
        continue: !final,
      });
    },
    cancel(contextId) {
      if (cancelled.has(contextId)) return;
      clearDeadline(contextId);
      cancelled.add(contextId);
      startedAt.delete(contextId);
      heard.delete(contextId);
      socket.send({ context_id: contextId, cancel: true });
    },
    drainCharacters() {
      const value = characters;
      characters = 0;
      return value;
    },
    close: () => {
      for (const contextId of deadlines.keys()) clearDeadline(contextId);
      return socket.close();
    },
  };
}
