/**
 * Transcrição em tempo real da Deepgram (Nova-3), por WebSocket, em pt-BR.
 *
 * A Cartesia Ink não serve aqui: não transcreve português em streaming. A Deepgram recebe o PCM16
 * 8 kHz da linha como está (`encoding=linear16&sample_rate=8000`), sem reamostrar.
 *
 * Documentação oficial consultada em 2026-11-16:
 *   - https://developers.deepgram.com/reference/speech-to-text/listen-streaming  (`wss://api.deepgram.com/v1/listen`,
 *     parâmetros `model`, `language`, `encoding`, `sample_rate`, `interim_results`, `endpointing`, `vad_events`,
 *     `utterance_end_ms`; mensagens `Results` com `is_final`, `speech_final`, `channel.alternatives[].transcript`,
 *     `SpeechStarted`, `UtteranceEnd`, `Metadata`; controle `KeepAlive`, `Finalize`, `CloseStream`)
 *   - https://developers.deepgram.com/reference/auth/tokens/grant  (`Authorization: Token <chave>`)
 *   - https://developers.deepgram.com/docs/models-languages-overview  (Nova-3 monolíngue aceita `pt`, `pt-BR`, `pt-PT`)
 *   - https://deepgram.com/pricing  (Nova-3 monolíngue em streaming: US$ 0,0048/min promocional, US$ 0,0077/min cheio)
 *
 * Não confirmado contra o servidor real (nenhuma chamada com chave foi feita):
 *   - a qualidade do `nova-3` em `pt-BR` numa linha de 8 kHz;
 *   - que `keyterm` (vocabulário) seja aceito com `language=pt-BR` (a página o descreve para o Nova-3);
 *   - o atraso real entre o fim da fala e o `speech_final` a partir da VPS.
 */
import { recognitionUrl } from "./deepgram-url";
import { z } from "zod";
import { SessionEmitter } from "../emitter";
import { openProviderSocket, type ProviderSocket } from "../provider-socket";
import type { ConnectOptions, ListeningEnvironment } from "../types";

export const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";
export const DEEPGRAM_API_URL = "https://api.deepgram.com";
export const DEEPGRAM_MODEL = "nova-3";
/** Bytes por segundo do PCM16 mono 8 kHz: é como o tempo de áudio enviado é medido. */
const BYTES_PER_SECOND = 16_000;

const serverMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("Results"),
    is_final: z.boolean().optional(),
    speech_final: z.boolean().optional(),
    channel: z.object({ alternatives: z.array(z.object({ transcript: z.string() })) }),
  }),
  z.object({ type: z.literal("SpeechStarted") }),
  z.object({ type: z.literal("UtteranceEnd") }),
  z.object({ type: z.literal("Error") }),
]);

export interface DeepgramSttOptions {
  apiKey: string;
  language: string;
  url?: string;
  model?: string;
  vocabulary?: readonly string[];
  listeningEnvironment?: ListeningEnvironment;
  timeout?: Pick<ConnectOptions, "readyTimeoutMs" | "schedule">;
}

export interface SttHandlers {
  /** Trecho provisório (pode mudar). */
  partial(text: string): void;
  /** Trecho definitivo. `speechFinal`: o provedor viu uma pausa depois dele. */
  final(text: string, speechFinal: boolean): void;
  /** O provedor detectou início de fala. */
  speechStarted(): void;
  /** O provedor viu o fim da fala (`utterance_end_ms` sem palavras). */
  utteranceEnd(): void;
  failed(error: Error): void;
}

export interface DeepgramStt {
  sendAudio(pcm16_8k: Buffer): void;
  /** Pede ao provedor que entregue já como final o que ouviu até agora. */
  finalize(): void;
  /** Segundos de áudio enviados desde a última leitura (é o que a Deepgram cobra). */
  drainSeconds(): number;
  close(): Promise<void>;
}

export function deepgramUrl(options: Pick<DeepgramSttOptions, "url" | "model" | "language" | "vocabulary" | "listeningEnvironment">): string {
  const url = recognitionUrl(options.url ?? DEEPGRAM_WS_URL, options.language, 8000, options.vocabulary ?? [], options.model ?? DEEPGRAM_MODEL);
  url.searchParams.set("vad_events", "true");
  url.searchParams.set("endpointing", options.listeningEnvironment === "noisy" ? "400" : "250");
  url.searchParams.set("utterance_end_ms", "1000");
  return url.toString();
}

export async function openDeepgramStt(options: DeepgramSttOptions, handlers: SttHandlers): Promise<DeepgramStt> {
  const emitter = new SessionEmitter();
  let lastError: Error | undefined;
  let bytes = 0;
  emitter.on("error", (error) => (lastError = error));
  emitter.on("closed", (reason) => {
    if (reason !== "client") handlers.failed(lastError ?? new Error("Deepgram: a conexão caiu"));
  });

  const onMessage = (raw: unknown): void => {
    const parsed = serverMessage.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "Error":
        handlers.failed(new Error("Deepgram: o provedor recusou a transcrição"));
        return;
      case "SpeechStarted":
        handlers.speechStarted();
        return;
      case "UtteranceEnd":
        handlers.utteranceEnd();
        return;
      case "Results": {
        const text = message.channel.alternatives[0]?.transcript.trim() ?? "";
        if (message.is_final) handlers.final(text, message.speech_final === true);
        else if (text !== "") handlers.partial(text);
        return;
      }
    }
  };

  const socket: ProviderSocket = await openProviderSocket({
    url: deepgramUrl(options),
    headers: { Authorization: `Token ${options.apiKey}` },
    label: "Deepgram",
    emitter,
    privateErrors: true,
    onMessage,
    timeout: options.timeout,
  });

  const schedule = options.timeout?.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  });
  let closed = false;
  let cancelKeepAlive: (() => void) | undefined;
  const keepAlive = (): void => {
    if (closed) return;
    socket.send({ type: "KeepAlive" });
    cancelKeepAlive = schedule(keepAlive, 4000);
  };
  cancelKeepAlive = schedule(keepAlive, 4000);

  return {
    sendAudio(pcm16_8k) {
      bytes += pcm16_8k.length;
      socket.sendBinary(pcm16_8k);
    },
    finalize() {
      socket.send({ type: "Finalize" });
    },
    drainSeconds() {
      const seconds = bytes / BYTES_PER_SECOND;
      bytes = 0;
      return seconds;
    },
    async close() {
      closed = true;
      cancelKeepAlive?.();
      socket.send({ type: "CloseStream" });
      await socket.close();
    },
  };
}
