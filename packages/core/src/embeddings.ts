import { z } from "zod";

/**
 * Embeddings pelo OpenRouter (`POST /api/v1/embeddings`), o mesmo provedor e a mesma chave do modelo
 * de texto do pipeline de voz. O tamanho do vetor é o da coluna `knowledge_chunks.embedding`.
 */

export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
/**
 * Preço de tabela do modelo, em dólares por milhão de tokens (OpenRouter, conferido em 25/11/2026).
 * Só entra na conta quando a resposta não traz o custo (`usage.cost`), que é o valor cobrado.
 */
export const EMBEDDING_PRICE_USD_PER_MILLION_TOKENS = 0.02;

const MICROCENTS_PER_USD = 100_000_000;
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
/** Entradas por pedido e tokens por pedido: abaixo do limite do modelo (8.192 tokens por entrada). */
const MAX_INPUTS_PER_REQUEST = 64;
const MAX_TOKENS_PER_REQUEST = 60_000;

export type EmbeddingFailureCode = "embedding_http" | "embedding_bad_response" | "embedding_unreachable";

/** Falha ao pedir embeddings. `retryable`: vale tentar de novo (limite de uso, erro do provedor, rede). */
export class EmbeddingError extends Error {
  constructor(
    readonly code: EmbeddingFailureCode,
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export interface EmbeddingOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  /** Prazo de cada pedido. */
  timeoutMs?: number;
  /** Tentativas por pedido quando a falha é transitória (padrão 3). */
  attempts?: number;
  /** Espera entre tentativas; injetada para o teste não esperar de verdade. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EmbeddingResult {
  vectors: number[][];
  /** Tokens de entrada cobrados. */
  tokens: number;
  /** Custo em microcentavos de dólar (1 US$ = 100.000.000). */
  costMicrocents: number;
  model: string;
}

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.number().nonnegative().optional(), total_tokens: z.number().nonnegative().optional(), cost: z.number().nonnegative().optional() }).optional(),
});

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Custo de tabela de `tokens` tokens, em microcentavos de dólar. */
export const listPriceMicrocents = (tokens: number): number => Math.round((tokens / 1_000_000) * EMBEDDING_PRICE_USD_PER_MILLION_TOKENS * MICROCENTS_PER_USD);

async function requestOnce(inputs: string[], options: Required<Pick<EmbeddingOptions, "model" | "timeoutMs">> & EmbeddingOptions): Promise<EmbeddingResult> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: options.model, input: inputs }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    // A mensagem não repete nada do pedido (a chave vai no cabeçalho, mas a regra vale para qualquer erro).
    throw new EmbeddingError("embedding_unreachable", true, "Embedding provider unreachable or timed out");
  }
  if (!response.ok) {
    // 429 e 5xx passam sozinhos; 400, 401, 402 e 403 são da conta ou do pedido e repetir não ajuda.
    const retryable = response.status === 429 || response.status >= 500;
    throw new EmbeddingError("embedding_http", retryable, `Embedding provider answered HTTP ${response.status}`, response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EmbeddingError("embedding_bad_response", true, "Embedding provider answered with a body that is not JSON");
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || parsed.data.data.length !== inputs.length) {
    throw new EmbeddingError("embedding_bad_response", false, "Embedding provider answered with an unexpected shape");
  }
  const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
  const vectors = ordered.map((item) => item.embedding);
  if (vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
    throw new EmbeddingError("embedding_bad_response", false, `Embedding model did not return ${EMBEDDING_DIMENSIONS} dimensions`);
  }
  const tokens = parsed.data.usage?.prompt_tokens ?? parsed.data.usage?.total_tokens ?? 0;
  const costMicrocents = parsed.data.usage?.cost !== undefined ? Math.round(parsed.data.usage.cost * MICROCENTS_PER_USD) : listPriceMicrocents(tokens);
  return { vectors, tokens, costMicrocents, model: options.model };
}

/**
 * Embeddings de `inputs`, na mesma ordem. Divide em pedidos de até 64 entradas e ~60 mil tokens
 * (`approxTokens` de cada entrada vem do chamador, que já contou) e repete o que falhar de forma
 * transitória, com espera crescente.
 */
export async function embedTexts(inputs: string[], options: EmbeddingOptions, approxTokens: number[] = []): Promise<EmbeddingResult> {
  const model = options.model ?? EMBEDDING_MODEL;
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  const settings = { ...options, model, timeoutMs: options.timeoutMs ?? 30_000 };
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchTokens = 0;
  inputs.forEach((input, i) => {
    const cost = approxTokens[i] ?? Math.ceil(input.length / 3);
    if (batch.length > 0 && (batch.length >= MAX_INPUTS_PER_REQUEST || batchTokens + cost > MAX_TOKENS_PER_REQUEST)) {
      batches.push(batch);
      batch = [];
      batchTokens = 0;
    }
    batch.push(input);
    batchTokens += cost;
  });
  if (batch.length > 0) batches.push(batch);

  const total: EmbeddingResult = { vectors: [], tokens: 0, costMicrocents: 0, model };
  for (const part of batches) {
    let result: EmbeddingResult | undefined;
    for (let attempt = 1; !result; attempt += 1) {
      try {
        result = await requestOnce(part, settings);
      } catch (error) {
        if (!(error instanceof EmbeddingError) || !error.retryable || attempt >= attempts) throw error;
        await sleep(500 * 4 ** (attempt - 1));
      }
    }
    total.vectors.push(...result.vectors);
    total.tokens += result.tokens;
    total.costMicrocents += result.costMicrocents;
  }
  return total;
}

/** O vetor como o texto que o pgvector lê (`'[0.1,0.2,...]'::vector`). */
export const toVectorLiteral = (vector: readonly number[]): string => `[${vector.join(",")}]`;
