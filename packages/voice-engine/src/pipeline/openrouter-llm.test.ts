import { afterEach, describe, expect, it } from "vitest";
import { startFakeSse, textChunk, toolChunk, usageChunk } from "../testing/fake-pipeline";
import type { ToolSpec } from "../types";
import { LLM_PROFILES } from "./llm-profile";
import { FALLBACK_PRICING, LlmHttpError, OPENROUTER_MODEL, chatBody, streamChat, streamChatResilient, type LlmEvent } from "./openrouter-llm";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const tools: ToolSpec[] = [
  { name: "agenda_marcar", description: "Marca um horário.", parameters: { type: "object", properties: { inicio: { type: "string" } } } },
  { name: "call_webhook", description: "Chama o webhook.", parameters: { type: "object", properties: {} } },
];

async function collect(stream: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenRouter, Chat Completions em streaming", () => {
  it("manda modelo, streaming, mensagens e ferramentas no formato de função, com a chave Bearer", async () => {
    const server = await startFakeSse((_request, reply) => reply.end());
    stops.push(() => server.stop());
    await collect(streamChat({ apiKey: "sk-or-falsa", baseUrl: server.url, messages: [{ role: "user", content: "oi" }], tools }));
    const request = server.requests[0];
    expect(request?.url).toBe("/chat/completions");
    expect(request?.headers.authorization).toBe("Bearer sk-or-falsa");
    expect(request?.body).toMatchObject({
      model: OPENROUTER_MODEL,
      stream: true,
      messages: [{ role: "user", content: "oi" }],
      tools: [{ type: "function", function: { name: "agenda_marcar" } }, { type: "function", function: { name: "call_webhook" } }],
      tool_choice: "auto",
    });
  });

  it("sem perfil, o padrão é o A: Haiku 5.5, cache do prompt de sistema, teto 1024 e raciocínio do modelo (sem o campo)", () => {
    const body = chatBody({ messages: [{ role: "system", content: "Você é a recepção." }, { role: "user", content: "oi" }], tools: [] });
    expect(body["model"]).toBe("anthropic/claude-haiku-5.5");
    expect(body["max_tokens"]).toBe(1024);
    expect(body).not.toHaveProperty("reasoning");
    expect(body["messages"]).toEqual([
      { role: "system", content: [{ type: "text", text: "Você é a recepção.", cache_control: { type: "ephemeral" } }] },
      { role: "user", content: "oi" },
    ]);
  });

  it("cada perfil do agente é respeitado: B desliga o raciocínio; C é o Flash de antes, sem cache e com teto 400", () => {
    const messages = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "oi" }];
    const b = chatBody({ messages, tools: [], profile: LLM_PROFILES.b });
    expect(b).toMatchObject({ model: "anthropic/claude-haiku-5.5", max_tokens: 400, reasoning: { enabled: false } });
    expect(JSON.stringify(b["messages"])).toContain("cache_control");

    const d = chatBody({ messages, tools: [], profile: LLM_PROFILES.d });
    expect(d).toMatchObject({ model: "openai/gpt-oss-120b", max_tokens: 400, reasoning: { effort: "low" }, provider: { order: ["cerebras", "groq", "baseten"], allow_fallbacks: true } });
    expect(JSON.stringify(d)).not.toContain("cache_control");
    expect(chatBody({ messages, tools: [], profile: LLM_PROFILES.d, plain: true })).not.toHaveProperty("reasoning");
    expect(chatBody({ messages, tools: [], profile: LLM_PROFILES.b })).not.toHaveProperty("provider");
    expect(chatBody({ messages, tools: [], profile: LLM_PROFILES.e })).toMatchObject({ model: "deepseek/deepseek-v4.1-flash", reasoning: { enabled: false }, provider: { order: ["together", "wafer", "reka"], allow_fallbacks: true } });
    // Um modelo trocado à mão (teste) não herda o roteamento do perfil; o do próprio perfil, sim.
    expect(chatBody({ messages, tools: [], profile: LLM_PROFILES.e, model: "outro/modelo" })).not.toHaveProperty("provider");
    expect(chatBody({ messages, tools: [], profile: LLM_PROFILES.e, model: LLM_PROFILES.e.model })).toHaveProperty("provider");
    expect(chatBody({ messages, tools: [], profile: LLM_PROFILES.e, providerOrder: ["wafer", "reka"] })).toMatchObject({ provider: { order: ["wafer", "reka"] } });
    const c = chatBody({ messages, tools: [], profile: LLM_PROFILES.c });
    expect(c).toMatchObject({ model: "google/gemini-2.5-flash", max_tokens: 400, messages });
    expect(c).not.toHaveProperty("reasoning");
    expect(JSON.stringify(c["messages"])).not.toContain("cache_control");
  });

  it("cache_control só vai a modelo que o aceita, mesmo no perfil que o pede", () => {
    const messages = [{ role: "system" as const, content: "s" }];
    expect(JSON.stringify(chatBody({ messages, tools: [], profile: LLM_PROFILES.a, model: "google/gemini-2.5-flash" }))).not.toContain("cache_control");
    expect(JSON.stringify(chatBody({ messages, tools: [], profile: LLM_PROFILES.a, model: "anthropic/claude-haiku-5.5" }))).toContain("cache_control");
  });

  it("entrega o texto em pedaços, a chamada de função montada e o custo declarado em centavos", async () => {
    const server = await startFakeSse((_request, reply) => {
      reply.comment("OPENROUTER PROCESSING");
      reply.write(textChunk("Claro, "));
      reply.write(textChunk("vou marcar."));
      reply.write(toolChunk(0, { id: "call_1", name: "agenda_", arguments: '{"inicio":' }));
      reply.write(toolChunk(0, { name: "marcar", arguments: '"2026-11-20T10:00"}' }));
      reply.write("lixo que não é json");
      reply.write({ outro: "formato" });
      reply.write(usageChunk(1200, 40, 0.00042, 1000));
      reply.end();
    });
    stops.push(() => server.stop());
    const events = await collect(streamChat({ apiKey: "k", baseUrl: server.url, messages: [], tools }));
    expect(events).toEqual([
      { type: "text", delta: "Claro, " },
      { type: "text", delta: "vou marcar." },
      { type: "usage", usage: { promptTokens: 1200, completionTokens: 40, cachedTokens: 1000, costCents: expect.closeTo(0.042, 9), model: OPENROUTER_MODEL } },
      { type: "tool_call", call: { id: "call_1", type: "function", function: { name: "agenda_marcar", arguments: '{"inicio":"2026-11-20T10:00"}' } } },
    ]);
  });

  it("sem `cost` na resposta, o custo sai dos tokens pelo preço de reserva", async () => {
    const server = await startFakeSse((_request, reply) => {
      reply.write(usageChunk(1_000_000, 1_000_000));
      reply.end();
    });
    stops.push(() => server.stop());
    const events = await collect(streamChat({ apiKey: "k", baseUrl: server.url, messages: [], tools: [] }));
    expect(events).toEqual([
      { type: "usage", usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0, costCents: FALLBACK_PRICING.inputCentsPerMillion + FALLBACK_PRICING.outputCentsPerMillion, model: OPENROUTER_MODEL } },
    ]);
  });

  it("registra por chamada o modelo, o provedor, o fim da resposta, os tokens de raciocínio e os de cache, sem conteúdo", async () => {
    const server = await startFakeSse((_request, reply) => {
      reply.write({ provider: "Claude Platform on AWS", choices: [{ delta: { content: "Segredo da conversa" }, finish_reason: null }] });
      reply.write({ provider: "Claude Platform on AWS", choices: [{ delta: {}, finish_reason: "length" }] });
      reply.write({
        provider: "Claude Platform on AWS",
        choices: [],
        usage: { prompt_tokens: 900, completion_tokens: 1024, cost: 0.001, prompt_tokens_details: { cached_tokens: 700, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 980 } },
      });
      reply.end();
    });
    stops.push(() => server.stop());
    const events = await collect(streamChat({ apiKey: "k", baseUrl: server.url, messages: [], tools: [] }));
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      usage: {
        promptTokens: 900,
        completionTokens: 1024,
        cachedTokens: 700,
        cacheWriteTokens: 100,
        reasoningTokens: 980,
        finishReason: "length",
        provider: "Claude Platform on AWS",
        model: OPENROUTER_MODEL,
        costCents: expect.closeTo(0.1, 9),
      },
    });
    expect(JSON.stringify(usage)).not.toContain("Segredo");
  });

  it("HTTP de erro lança `LlmHttpError` com o status, sem repetir o corpo", async () => {
    const server = await startFakeSse((_request, reply) => reply.status(401, { error: { message: "chave sk-or-xyz inválida" } }));
    stops.push(() => server.stop());
    const failure = collect(streamChat({ apiKey: "k", baseUrl: server.url, messages: [], tools: [] }));
    await expect(failure).rejects.toBeInstanceOf(LlmHttpError);
    await expect(failure).rejects.toThrow("HTTP 401");
  });

  describe("provedor que recusa reasoning ou cache_control (4xx)", () => {
    const messages = [{ role: "system" as const, content: "s" }, { role: "user" as const, content: "oi" }];

    it("repete o pedido sem esses parâmetros, avisa com um evento de fallback e entrega a resposta", async () => {
      const server = await startFakeSse((request, reply) => {
        if (JSON.stringify(request.body).includes("cache_control") || "reasoning" in request.body) return reply.status(400, { error: { message: "unsupported parameter" } });
        reply.write(textChunk("Olá"));
        reply.write(usageChunk(10, 2));
        reply.end();
      });
      stops.push(() => server.stop());
      const events = await collect(streamChat({ apiKey: "k", baseUrl: server.url, messages, tools: [], profile: LLM_PROFILES.b }));
      expect(events[0]).toEqual({ type: "fallback", status: 400 });
      expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", delta: "Olá" }]);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[1]?.body).not.toHaveProperty("reasoning");
      expect(JSON.stringify(server.requests[1]?.body)).not.toContain("cache_control");
      expect(server.requests[1]?.body).toMatchObject({ model: "anthropic/claude-haiku-5.5", max_tokens: 400 });
    });

    it("com plain já ligado (sessão que caiu antes) não manda os parâmetros nem emite fallback de novo", async () => {
      const server = await startFakeSse((_request, reply) => reply.end());
      stops.push(() => server.stop());
      const events = await collect(streamChat({ apiKey: "k", baseUrl: server.url, messages, tools: [], profile: LLM_PROFILES.b, plain: true }));
      expect(events.some((event) => event.type === "fallback")).toBe(false);
      expect(server.requests).toHaveLength(1);
      expect(JSON.stringify(server.requests[0]?.body)).not.toContain("cache_control");
    });

    it("401 (chave) não é fallback: lança sem repetir; e 4xx também falha se o pedido sem os parâmetros falhar", async () => {
      const auth = await startFakeSse((_request, reply) => reply.status(401, {}));
      stops.push(() => auth.stop());
      await expect(collect(streamChat({ apiKey: "k", baseUrl: auth.url, messages, tools: [], profile: LLM_PROFILES.b }))).rejects.toThrow("HTTP 401");
      expect(auth.requests).toHaveLength(1);

      const always = await startFakeSse((_request, reply) => reply.status(400, {}));
      stops.push(() => always.stop());
      await expect(collect(streamChat({ apiKey: "k", baseUrl: always.url, messages, tools: [], profile: LLM_PROFILES.b }))).rejects.toThrow("HTTP 400");
      expect(always.requests).toHaveLength(2);
    });

    it("perfil C (sem reasoning nem cache) não tem o que tirar: o 4xx lança direto", async () => {
      const server = await startFakeSse((_request, reply) => reply.status(400, {}));
      stops.push(() => server.stop());
      await expect(collect(streamChat({ apiKey: "k", baseUrl: server.url, messages, tools: [], profile: LLM_PROFILES.c }))).rejects.toThrow("HTTP 400");
      expect(server.requests).toHaveLength(1);
    });
  });

  it("abortado no meio (barge-in) termina sem erro e sem chamada de função pela metade", async () => {
    const controller = new AbortController();
    const server = await startFakeSse((_request, reply) => {
      reply.write(textChunk("Começando "));
      reply.write(toolChunk(0, { id: "c", name: "call_webhook", arguments: "{" }));
      // Não fecha: o abort é que termina.
    });
    stops.push(() => server.stop());
    const events: LlmEvent[] = [];
    for await (const event of streamChat({ apiKey: "k", baseUrl: server.url, messages: [], tools, signal: controller.signal })) {
      events.push(event);
      controller.abort();
    }
    expect(events).toEqual([
      { type: "text", delta: "Começando " },
      { type: "usage", usage: expect.objectContaining({ completionTokens: LLM_PROFILES.a.maxTokens, costCents: expect.any(Number) }) },
    ]);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("erro no meio do stream vira exceção", async () => {
    const server = await startFakeSse((_request, reply) => {
      reply.write({ error: { message: "provider down" } });
      reply.end();
    });
    stops.push(() => server.stop());
    await expect(collect(streamChat({ apiKey: "k", baseUrl: server.url, messages: [], tools: [] }))).rejects.toThrow("OpenRouter: erro no meio da resposta");
  });
});

describe("tempo limite no primeiro conteúdo, com nova tentativa no próximo provedor (ADR 0023)", () => {
  const profile = { ...LLM_PROFILES.e, firstTokenTimeoutMs: 60 };
  const messages = [{ role: "user" as const, content: "oi" }];

  it("provedor que não entrega nada no prazo é largado, e o pedido sai de novo com os provedores que sobraram", async () => {
    let calls = 0;
    const server = await startFakeSse((_request, reply) => {
      calls++;
      if (calls === 1) return; // o primeiro provedor não responde
      reply.write({ provider: "Wafer", choices: [{ delta: { content: "Oi." }, finish_reason: null }] });
      reply.write({ provider: "Wafer", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } });
      reply.end();
    });
    stops.push(() => server.stop());
    const events = await collect(streamChatResilient({ apiKey: "k", baseUrl: server.url, messages, tools: [], profile }));
    expect(events.map((event) => event.type)).toEqual(["retry", "text", "usage"]);
    expect(events[0]).toEqual({ type: "retry", provider: "together" });
    expect(server.requests.map((request) => (request.body.provider as { order: string[] }).order)).toEqual([["together", "wafer", "reka"], ["wafer", "reka"]]);
    expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { provider: "Wafer" } });
  });

  it("resposta no prazo: nenhuma nova tentativa, e o extrato é o do provedor", async () => {
    const server = await startFakeSse((_request, reply) => {
      reply.write({ provider: "Together", choices: [{ delta: { content: "Oi." }, finish_reason: null }] });
      reply.write({ provider: "Together", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } });
      reply.end();
    });
    stops.push(() => server.stop());
    const events = await collect(streamChatResilient({ apiKey: "k", baseUrl: server.url, messages, tools: [], profile }));
    expect(events.map((event) => event.type)).toEqual(["text", "usage"]);
    expect(server.requests).toHaveLength(1);
  });

  it("chamada de função também conta como conteúdo: não refaz um pedido que só responde com ferramenta", async () => {
    const server = await startFakeSse(async (_request, reply) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply.write(toolChunk(0, { id: "c1", name: "agenda_marcar", arguments: "{}" }));
      reply.end();
    });
    stops.push(() => server.stop());
    const events = await collect(streamChatResilient({ apiKey: "k", baseUrl: server.url, messages, tools, profile }));
    expect(events.some((event) => event.type === "retry")).toBe(false);
    expect(server.requests).toHaveLength(1);
  });

  it("o último provedor da ordem não tem limite, e sem ordem ou sem limite no perfil é o streamChat de sempre", async () => {
    let calls = 0;
    const server = await startFakeSse(async (_request, reply) => {
      calls++;
      if (calls < 3) return; // os dois primeiros não respondem
      await new Promise((resolve) => setTimeout(resolve, 150)); // o último demora mais que o limite e ainda assim vale
      reply.write({ choices: [{ delta: { content: "Oi." }, finish_reason: null }] });
      reply.end();
    });
    stops.push(() => server.stop());
    const events = await collect(streamChatResilient({ apiKey: "k", baseUrl: server.url, messages, tools: [], profile }));
    expect(events.filter((event) => event.type === "retry")).toHaveLength(2);
    expect(events.some((event) => event.type === "text")).toBe(true);
    const plain = await startFakeSse((_request, reply) => reply.end());
    stops.push(() => plain.stop());
    await collect(streamChatResilient({ apiKey: "k", baseUrl: plain.url, messages, tools: [], profile: LLM_PROFILES.b }));
    expect(plain.requests).toHaveLength(1);
  });

  it("barge-in no meio: termina sem nova tentativa", async () => {
    const server = await startFakeSse(() => undefined);
    stops.push(() => server.stop());
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    const events = await collect(streamChatResilient({ apiKey: "k", baseUrl: server.url, messages, tools: [], profile, signal: abort.signal }));
    expect(events.some((event) => event.type === "retry")).toBe(false);
  });
});
