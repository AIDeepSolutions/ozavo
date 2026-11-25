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
import { acceptsCacheControl, llmProfileOf, LLM_PROFILES, type LlmProfile } from "./llm-profile";

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
/** O modelo do perfil padrão (A). Cada agente escolhe o seu perfil (`llm-profile.ts`). */
export const OPENROUTER_MODEL = LLM_PROFILES.a.model;
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
  /**
   * Observabilidade por chamada (sem conteúdo nem dado pessoal): o modelo pedido, o provedor que respondeu, por que a resposta
   * terminou (`length` é corte pelo teto de saída), os tokens de raciocínio e os que foram gravados no cache. Ausentes quando o
   * provedor não declara (ou quando a chamada foi abortada sem extrato).
   */
  model?: string;
  provider?: string;
  finishReason?: string;
  reasoningTokens?: number;
  cacheWriteTokens?: number;
  /** Centavos de dólar, já com o `cost` do provedor ou a estimativa de reserva. */
  costCents: number;
}

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ChatToolCall }
  | { type: "usage"; usage: LlmUsage }
  /** O provedor recusou `reasoning` ou `cache_control` (HTTP 4xx): o pedido foi repetido sem eles. Vem antes de qualquer texto. */
  | { type: "fallback"; status: number }
  /** O primeiro conteúdo (texto ou pedaço de chamada de função) chegou. Só existe com `markFirst`, para o tempo limite; não sai do `streamChatResilient`. */
  | { type: "first" }
  /** O provedor demorou para o primeiro conteúdo e o pedido foi refeito no próximo da lista (`provider` é o que foi deixado). */
  | { type: "retry"; provider: string };

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
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish(), cache_write_tokens: z.number().nullish() }).nullish(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().nullish() }).nullish(),
    })
    .nullish(),
  provider: z.string().nullish(),
  error: z.object({ message: z.string().optional() }).optional(),
});

export interface ChatRequest {
  apiKey: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  model?: string;
  /** Perfil do agente (`llm-profile.ts`). Omitido: o padrão (A). */
  profile?: LlmProfile;
  /** Teto de saída desta chamada, no lugar do do perfil (o aquecimento pede poucos tokens). */
  maxTokens?: number;
  /** Ordem de provedores desta chamada, no lugar da do perfil (a nova tentativa tira o que demorou). */
  providerOrder?: readonly string[];
  /** Interno do `streamChatResilient`: emite `first` quando o primeiro conteúdo chega. */
  markFirst?: boolean;
  /** Pedido sem `reasoning` nem `cache_control`: a sessão que já caiu no fallback segue assim, sem tentar de novo a cada turno. */
  plain?: boolean;
  baseUrl?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** Marca o prompt de sistema (primeira mensagem) para cache: `cache_control` em bloco de conteúdo, como o OpenRouter documenta para o Claude. */
function withCachedSystemPrompt(messages: readonly ChatMessage[]): readonly unknown[] {
  return messages.map((message, index) =>
    index === 0 && message.role === "system" ? { ...message, content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }] } : message,
  );
}

/** A ordem de provedores vale quando o modelo é o do perfil (um modelo trocado à mão, nos testes, não herda o roteamento dele). */
function providerOrderOf(request: Pick<ChatRequest, "model" | "profile" | "providerOrder">): readonly string[] | undefined {
  const profile = request.profile ?? llmProfileOf(undefined);
  return request.providerOrder ?? (request.model === undefined || request.model === profile.model ? profile.providerOrder : undefined);
}

export function chatBody(request: Pick<ChatRequest, "messages" | "tools" | "model" | "profile" | "plain" | "maxTokens" | "providerOrder">): Record<string, unknown> {
  const profile = request.profile ?? llmProfileOf(undefined);
  const model = request.model ?? profile.model;
  return {
    model,
    messages: !request.plain && profile.cacheSystemPrompt && acceptsCacheControl(model) ? withCachedSystemPrompt(request.messages) : request.messages,
    stream: true,
    // Fala ao telefone: resposta curta. O teto também limita o gasto de uma resposta descontrolada. Com o raciocínio ligado ele
    // é dividido com o texto, por isso o perfil que o mantém ligado usa 1024.
    max_tokens: request.maxTokens ?? profile.maxTokens,
    ...(!request.plain && profile.reasoning === "off" && { reasoning: { enabled: false } }),
    ...(!request.plain && profile.reasoning === "low" && { reasoning: { effort: "low" } }),
    ...(providerOrderOf(request) && { provider: { order: providerOrderOf(request), allow_fallbacks: true } }),
    ...(request.tools.length > 0 && {
      tools: request.tools.map((tool) => ({ type: "function", function: tool })),
      tool_choice: "auto",
    }),
  };
}

/** O perfil manda algo que o fallback tira (`reasoning` ou `cache_control`)? Se não, repetir não muda nada. */
function chatBodyDiffersWhenPlain(request: Pick<ChatRequest, "messages" | "tools" | "model" | "profile" | "maxTokens" | "providerOrder">): boolean {
  return JSON.stringify(chatBody(request)) !== JSON.stringify(chatBody({ ...request, plain: true }));
}

function usageOf(raw: NonNullable<z.infer<typeof chunkSchema>["usage"]>, observed: Pick<LlmUsage, "model" | "provider" | "finishReason"> = {}): LlmUsage {
  const costCents =
    typeof raw.cost === "number"
      ? raw.cost * 100
      : (raw.prompt_tokens / 1e6) * FALLBACK_PRICING.inputCentsPerMillion + (raw.completion_tokens / 1e6) * FALLBACK_PRICING.outputCentsPerMillion;
  return {
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
    costCents,
    ...observed,
    ...(raw.completion_tokens_details?.reasoning_tokens != null && { reasoningTokens: raw.completion_tokens_details.reasoning_tokens }),
    ...(raw.prompt_tokens_details?.cache_write_tokens != null && { cacheWriteTokens: raw.prompt_tokens_details.cache_write_tokens }),
  };
}

/**
 * Faz o pedido e entrega o texto em pedaços, as chamadas de função já completas (no fim) e o uso.
 * Pedido abortado (barge-in) termina sem erro. HTTP fora de 2xx lança `LlmHttpError`.
 */
export async function* streamChat(request: ChatRequest): AsyncGenerator<LlmEvent> {
  const post = (plain: boolean): Promise<Response> =>
    (request.fetch ?? fetch)(`${request.baseUrl ?? OPENROUTER_API_URL}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${request.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(chatBody({ ...request, plain })),
      signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
  let response = await post(request.plain === true);
  // 400/422: o provedor não aceitou o corpo, e o que o perfil acrescenta (reasoning, cache_control) é o suspeito. Repete uma vez sem
  // eles, em vez de deixar o agente pedir desculpa em todo turno. 401/402/403/429 e 5xx são outra coisa e seguem como erro.
  if ((response.status === 400 || response.status === 422) && request.plain !== true && chatBodyDiffersWhenPlain(request)) {
    await response.body?.cancel();
    yield { type: "fallback", status: response.status };
    response = await post(true);
  }
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
  let firstSeen = false;
  let finishReason: string | undefined;
  let provider: string | undefined;
  const model = request.model ?? (request.profile ?? llmProfileOf(undefined)).model;
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
        if (chunk.provider) provider = chunk.provider;
        for (const choice of chunk.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          const content = choice.delta?.content;
          if (request.markFirst && !firstSeen && (content || (choice.delta?.tool_calls?.length ?? 0) > 0)) {
            firstSeen = true;
            yield { type: "first" };
          }
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
          yield { type: "usage", usage: usageOf(chunk.usage, { model, ...(provider && { provider }), ...(finishReason && { finishReason }) }) };
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
      yield { type: "usage", usage: usageOf({ prompt_tokens: promptTokens, completion_tokens: request.maxTokens ?? (request.profile ?? llmProfileOf(undefined)).maxTokens }, { model }) };
    }
  }
  if (request.signal?.aborted) return;
  for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
    if (!call.name) continue;
    yield { type: "tool_call", call: { id: call.id || `call_${index}`, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } } };
  }
}

/**
 * `streamChat` com tempo limite no PRIMEIRO conteúdo (ADR 0023): se o provedor da vez não entrega nada em
 * `profile.firstTokenTimeoutMs`, o pedido é cortado e refeito no próximo da ordem do perfil, até o último, que não tem limite. O
 * roteamento do OpenRouter só troca de provedor quando ele falha; um provedor lento mas vivo segurava a cauda (p90) inteira.
 * A estimativa de custo do pedido cortado fica com quem consome (`retry`): o provedor não manda extrato de um pedido cortado.
 */
export async function* streamChatResilient(request: ChatRequest): AsyncGenerator<LlmEvent> {
  const profile = request.profile ?? llmProfileOf(undefined);
  const timeoutMs = profile.firstTokenTimeoutMs;
  const order = providerOrderOf(request);
  if (!timeoutMs || !order || order.length < 2) {
    yield* streamChat(request);
    return;
  }
  for (let attempt = 0; attempt < order.length; attempt++) {
    const remaining = order.slice(attempt);
    const last = attempt === order.length - 1;
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    let timedOut = false;
    const timer = last
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
    try {
      for await (const event of streamChat({ ...request, signal, providerOrder: remaining, markFirst: true })) {
        if (event.type === "first") {
          if (timer) clearTimeout(timer);
          continue;
        }
        // O extrato estimado de um pedido que nós mesmos cortamos não vale como uma chamada.
        if (timedOut && event.type === "usage") continue;
        yield event;
      }
    } catch (error) {
      // Cortado por nós (prazo) ou pela pessoa (barge-in): a `fetch` rejeita antes de haver resposta; não é erro do provedor.
      if (!timedOut && !request.signal?.aborted) throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!timedOut || request.signal?.aborted) return;
    yield { type: "retry", provider: remaining[0] ?? "" };
  }
}
