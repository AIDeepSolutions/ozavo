/**
 * Modelo de texto do pipeline pelo OpenRouter: Chat Completions em streaming (SSE), com chamada de
 * função no formato da OpenAI.
 *
 * Documentação oficial consultada em 2026-11-16:
 *   - https://openrouter.ai/docs/use-cases/usage-accounting  (o uso sempre volta; campos `prompt_tokens`,
 *     `completion_tokens`, `cost` em créditos, `prompt_tokens_details.cached_tokens`; `usage.include` e
 *     `stream_options.include_usage` estão obsoletos e não têm efeito)
 *   - https://openrouter.ai/docs/api-reference/chat-completion  (`POST /api/v1/chat/completions`, `Authorization:
 *     Bearer`, `stream: true`, `tools`, `tool_choice`, deltas `choices[].delta.content` e `delta.tool_calls[]`
 *     com `index`, `id`, `function.name`, `function.arguments` em pedaços)
 *
 * O custo vem do próprio OpenRouter (`usage.cost`, crédito = dólar), então vale para qualquer modelo
 * escolhido. Se a resposta vier sem `cost`, o custo sai dos tokens pelo `FALLBACK_PRICING`, de
 * propósito acima do que os modelos rápidos cobram: superestimar fura menos o teto que subestimar.
 *
 * Medido em 2026-11-16 nesta VPS: primeiro token em 617 ms, uma resposta curta em pt-BR,
 * google/gemini-2.5-flash. Function calling foi verificado com servidor falso, não com conta
 * real. O uso final pode faltar em aborto/erro: nesse caso reserva todo o teto de saída e
 * estima a entrada por bytes, ao preço de reserva, sem contar novamente o extrato recebido.
 */
import { z } from "zod";
import type { ToolSpec } from "../types";

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODEL = "google/gemini-2.5-flash";
/** Centavos por milhão de tokens, usados só quando o OpenRouter não declara o custo. */
export const FALLBACK_PRICING = { inputCentsPerMillion: 500, outputCentsPerMillion: 2000 } as const;

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Centavos de dólar, já com o `cost` do provedor ou a estimativa de reserva. */
  costCents: number;
}

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ChatToolCall }
  | { type: "usage"; usage: LlmUsage };

export class LlmHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenRouter: o pedido falhou (HTTP ${status})`);
  }
}

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number(),
                  id: z.string().nullish(),
                  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      cost: z.number().nullish(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
    })
    .nullish(),
  error: z.object({ message: z.string().optional() }).optional(),
});

export interface ChatRequest {
  apiKey: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  model?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export function chatBody(request: Pick<ChatRequest, "messages" | "tools" | "model">): Record<string, unknown> {
  return {
    model: request.model ?? OPENROUTER_MODEL,
    messages: request.messages,
    stream: true,
    // Fala ao telefone: resposta curta. O teto também limita o gasto de uma resposta descontrolada.
    max_tokens: 400,
    ...(request.tools.length > 0 && {
      tools: request.tools.map((tool) => ({ type: "function", function: tool })),
      tool_choice: "auto",
    }),
  };
}

function usageOf(raw: NonNullable<z.infer<typeof chunkSchema>["usage"]>): LlmUsage {
  const costCents =
    typeof raw.cost === "number"
      ? raw.cost * 100
      : (raw.prompt_tokens / 1e6) * FALLBACK_PRICING.inputCentsPerMillion + (raw.completion_tokens / 1e6) * FALLBACK_PRICING.outputCentsPerMillion;
  return {
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
    costCents,
  };
}

/**
 * Faz o pedido e entrega o texto em pedaços, as chamadas de função já completas (no fim) e o uso.
 * Pedido abortado (barge-in) termina sem erro. HTTP fora de 2xx lança `LlmHttpError`.
 */
export async function* streamChat(request: ChatRequest): AsyncGenerator<LlmEvent> {
  const response = await (request.fetch ?? fetch)(`${request.baseUrl ?? OPENROUTER_API_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${request.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(chatBody(request)),
    signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new LlmHttpError(response.status);
  }

  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffered = "";
  let finished = false;
  let usageReceived = false;
  try {
    while (!finished) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        if (request.signal?.aborted) return;
        throw error;
      }
      if (read.done) break;
      buffered += decoder.decode(read.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        if (request.signal?.aborted) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          finished = true;
          break;
        }
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // pedaço que não é JSON não é do protocolo: ignorado
        }
        const parsed = chunkSchema.safeParse(json);
        if (!parsed.success) continue;
        const chunk = parsed.data;
        if (chunk.error) throw new Error("OpenRouter: erro no meio da resposta");
        for (const choice of chunk.choices ?? []) {
          const content = choice.delta?.content;
          if (content) yield { type: "text", delta: content };
          for (const part of choice.delta?.tool_calls ?? []) {
            const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name += part.function.name;
            if (part.function?.arguments) call.arguments += part.function.arguments;
            calls.set(part.index, call);
          }
        }
        if (chunk.usage && !usageReceived) {
          usageReceived = true;
          yield { type: "usage", usage: usageOf(chunk.usage) };
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (!usageReceived) {
      // Um aborto também custa. Sem extrato final, estima a entrada por byte e todo o teto
      // de saída: conserva o teto da chamada mesmo quando o usuário interrompe cada resposta.
      const promptTokens = Buffer.byteLength(JSON.stringify(request.messages)) + Buffer.byteLength(JSON.stringify(request.tools));
      yield { type: "usage", usage: usageOf({ prompt_tokens: promptTokens, completion_tokens: 400 }) };
    }
  }
  if (request.signal?.aborted) return;
  for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    if (!call.name) continue;
    yield { type: "tool_call", call: { id: call.id || `call_${index}`, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } } };
  }
}
