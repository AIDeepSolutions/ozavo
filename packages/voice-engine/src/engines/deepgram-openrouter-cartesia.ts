/**
 * Motor em pipeline: Deepgram Nova-3 ouve, um modelo do OpenRouter pensa e chama ferramentas, e a
 * Cartesia Sonic 3.6 fala, em μ-law 8 kHz nativo. Para o resto do sistema é um motor como os de voz
 * direta: uma `VoiceSession`, PCM16 8 kHz na borda, `toolCall`, `interrupted`, `usage`.
 *
 * A orquestração (barge-in, endpointing dinâmico, caixa postal, custo, latência) mora em
 * `../pipeline/session.ts`; cada provedor tem o seu arquivo em `../pipeline/`, com as páginas da
 * documentação consultadas e o que não foi confirmado contra o servidor real.
 *
 * A chave do motor é um JSON com as três chaves (`../pipeline/credentials.ts`), cifrado em repouso
 * com `encryptSecret` como qualquer chave de IA.
 *
 * Teste da chave (`checkKey`), consultado em 2026-11-16, sem gerar áudio nem texto:
 *   - Cartesia: `GET https://api.cartesia.ai/voices?limit=1`, `Authorization: Bearer`, `Cartesia-Version`
 *     (https://docs.cartesia.ai/api-reference/voices/list); 200 com `data: []`.
 *   - Deepgram: `GET https://api.deepgram.com/v1/projects`, `Authorization: Token`. Não confirmado na
 *     página nesta data (a referência consultada só documenta `POST /v1/auth/grant`).
 *   - OpenRouter: `GET https://openrouter.ai/api/v1/key`, `Authorization: Bearer`. Não confirmado na
 *     página nesta data.
 *
 * Preço (centavos de dólar), conferido em 2026-11-16:
 *   - Deepgram Nova-3 monolíngue em streaming: US$ 0,0077/min (preço cheio; o promocional é 0,0048),
 *     em https://deepgram.com/pricing. É o `centsPerMinute`, sobre o tempo de áudio enviado.
 *   - Cartesia Sonic: 1 crédito por caractere, US$ 65 por milhão no maior excedente publicado (Pro),
 *     em https://cartesia.ai/pricing. É o `centsPerMillionCharacters`.
 *   - OpenRouter: o custo de cada pedido vem na própria resposta (`usage.cost`) e entra como
 *     `providerCostCents`; não há preço de token na tabela abaixo, para não contar duas vezes.
 *
 * Onde o áudio é processado: nenhum dos três publica, nas páginas consultadas, o país onde processa a
 * fala; fica `undeclared`.
 */
import { systemClock, type Clock } from "@ozavo/core";
import { checkKeyOverHttp } from "../key-check";
import { CARTESIA_API_URL, CARTESIA_MODEL, CARTESIA_VERSION, openCartesiaTts } from "../pipeline/cartesia-tts";
import { InvalidPipelineKeyError, parsePipelineKey, type PipelineCredentials } from "../pipeline/credentials";
import { DEEPGRAM_API_URL, DEEPGRAM_MODEL, openDeepgramStt } from "../pipeline/deepgram-stt";
import { llmProfileOf } from "../pipeline/llm-profile";
import { OPENROUTER_API_URL, OPENROUTER_MODEL, streamChat } from "../pipeline/openrouter-llm";
import { createPipelineSession, type TurnMetrics } from "../pipeline/session";
import type { AmdOptions } from "../pipeline/amd";
import type { ConnectOptions, KeyCheck, KeyCheckOptions, KeyCheckResult, VoiceEngine, VoiceSession, VoiceSessionConfig } from "../types";
import { z } from "zod";

export const PIPELINE_ENGINE_ID = "deepgram-openrouter-cartesia";

export interface PipelineConnectOptions extends ConnectOptions {
  /** Endereços de cada provedor (testes apontam para servidores falsos). */
  urls?: { stt?: string; tts?: string; llm?: string };
  clock?: Clock;
  fetch?: typeof fetch;
  onMetrics?(metrics: TurnMetrics): void;
  /** `false` desliga a detecção de caixa postal. */
  amd?: AmdOptions | false;
}

export class InvalidVoiceError extends Error {
  constructor() {
    super("Motor em pipeline: a voz do agente não é um voice_id da Cartesia");
  }
}

export async function connectPipeline(config: VoiceSessionConfig, apiKey: string, options: PipelineConnectOptions = {}): Promise<VoiceSession> {
  const keys: PipelineCredentials = parsePipelineKey(apiKey);
  // A voz é do agente (cada organização escolhe a sua); sem escolha, a padrão do motor.
  const voiceId = config.voiceId?.trim() || CARTESIA_DEFAULT_VOICE;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(voiceId)) throw new InvalidVoiceError();
  const clock = options.clock ?? systemClock;
  const timeout = { readyTimeoutMs: options.readyTimeoutMs, schedule: options.schedule };
  // O perfil é do agente (tela de configuração); `options.model` (testes) troca só o modelo.
  const profile = llmProfileOf(config.llmProfile);
  const llmModel = options.model ?? profile.model;
  return createPipelineSession({
    config,
    clock,
    schedule: options.schedule,
    onMetrics: options.onMetrics,
    amd: options.amd,
    openStt: (handlers) =>
      openDeepgramStt(
        {
          apiKey: keys.deepgram,
          language: config.language,
          url: options.urls?.stt,
          vocabulary: config.vocabulary,
          listeningEnvironment: config.listeningEnvironment,
          timeout,
        },
        handlers,
      ),
    openTts: (handlers) =>
      openCartesiaTts({ apiKey: keys.cartesia, voiceId, language: config.language, clock, url: options.urls?.tts, timeout }, handlers),
    chat: (messages, tools, signal) =>
      streamChat({ apiKey: keys.openrouter, messages, tools, signal, model: llmModel, profile, baseUrl: options.urls?.llm, fetch: options.fetch }),
  });
}

const anyJsonObject = z.object({}).passthrough();
const RANK: readonly KeyCheckResult[] = ["unreachable", "rejected", "no_credit", "region_unavailable", "model_unavailable", "rate_limited", "unexpected_response", "accepted"];

/** Das três respostas, a que mais precisa da atenção de quem testa (a primeira da lista acima). */
export function worstKeyCheck(results: readonly KeyCheckResult[]): KeyCheckResult {
  return [...results].sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] ?? "unexpected_response";
}

async function checkPipelineKey(apiKey: string, options: KeyCheckOptions): Promise<KeyCheck> {
  const model = `${DEEPGRAM_MODEL} + ${options.model ?? OPENROUTER_MODEL} + ${CARTESIA_MODEL}`;
  let keys: PipelineCredentials;
  try {
    keys = parsePipelineKey(apiKey);
  } catch (error) {
    if (error instanceof InvalidPipelineKeyError) return { result: "rejected", model };
    throw error;
  }
  const base = options.baseUrl;
  const checks = await Promise.all([
    checkKeyOverHttp(
      {
        url: `${base ?? DEEPGRAM_API_URL}/v1/projects`,
        headers: { Authorization: `Token ${keys.deepgram}` },
        model: DEEPGRAM_MODEL,
        accepted: z.object({ projects: z.array(anyJsonObject) }),
      },
      options,
    ),
    checkKeyOverHttp(
      {
        url: `${base ?? CARTESIA_API_URL}/voices?limit=1`,
        headers: { Authorization: `Bearer ${keys.cartesia}`, "Cartesia-Version": CARTESIA_VERSION },
        model: CARTESIA_MODEL,
        accepted: z.object({ data: z.array(anyJsonObject) }),
      },
      options,
    ),
    checkKeyOverHttp(
      {
        url: `${base ? `${base}/api/v1` : OPENROUTER_API_URL}/key`,
        headers: { Authorization: `Bearer ${keys.openrouter}` },
        model: options.model ?? OPENROUTER_MODEL,
        accepted: z.object({ data: anyJsonObject }),
      },
      options,
    ),
  ]);
  return { result: worstKeyCheck(checks.map((check) => check.result)), model };
}

/**
 * Vozes da Cartesia em português, como `GET /voices?language=pt` devolveu em 2026-11-16 (as dez
 * primeiras). O id é o que vai em `voice`; a tela mostra o id. Cada agente (e, portanto, cada
 * organização) escolhe a sua, e qualquer outro id da biblioteca da Cartesia também é aceito.
 */
export const CARTESIA_PT_VOICES = [
  { id: "8a6d0b8e-8cd8-4952-a41e-b7af18662135" }, // Helena
  { id: "cb2694c3-715f-4da9-99f3-1c974fff2928" }, // Eloá
  { id: "9904416a-0831-44ea-b8ee-5f145e8f9bbf" }, // Alice
  { id: "8c44acc3-f107-460b-8958-a57ec638eaf5" }, // Lívia
  { id: "616c64d7-f541-436b-9b8d-e79cfbe19ef9" }, // Felipe
  { id: "81452d3b-a5f6-4ef4-afff-542182fac725" }, // Fabiana
  { id: "a5b0fceb-cc32-4eef-8929-421f55d32e16" }, // Lorena
  { id: "b1d18488-4aaa-47e7-9e4b-483c90a67968" }, // Matias
  { id: "07b6f895-78b9-4921-8e10-8a21c99c2e8a" }, // Rafael
  { id: "8d826d43-20ad-4c56-8d37-1048eccca1bf" }, // Larissa
] as const;
export const CARTESIA_DEFAULT_VOICE = CARTESIA_PT_VOICES[0].id;

const engine: VoiceEngine = {
  id: PIPELINE_ENGINE_ID,
  label: "Deepgram + OpenRouter + Cartesia (pipeline)",
  provider: "deepgram, openrouter, cartesia",
  processingLocation: { kind: "undeclared" },
  voices: CARTESIA_PT_VOICES,
  acceptsCustomVoices: true,
  detectsAnsweringMachine: true,
  defaultVoice: CARTESIA_DEFAULT_VOICE,
  // A ordem e os ids são os de `pipelineCredentials`: a tela monta o JSON que `parsePipelineKey` lê.
  keyParts: [
    { id: "deepgram", label: "Deepgram" },
    { id: "openrouter", label: "OpenRouter" },
    { id: "cartesia", label: "Cartesia" },
  ],
  pricing: {
    centsPerMinute: 0.77,
    centsPerMillionCharacters: 6500,
    checkedOn: "2026-11-16",
    source: "https://deepgram.com/pricing ; https://cartesia.ai/pricing ; OpenRouter: usage.cost de cada resposta",
  },
  connect: (config, apiKey, options) => connectPipeline(config, apiKey, options),
  checkKey: (apiKey, options = {}) => checkPipelineKey(apiKey, options),
};

export default engine;
