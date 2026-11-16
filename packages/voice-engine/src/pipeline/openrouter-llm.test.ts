import { afterEach, describe, expect, it } from "vitest";
import { startFakeSse, textChunk, toolChunk, usageChunk } from "../testing/fake-pipeline";
import type { ToolSpec } from "../types";
import { FALLBACK_PRICING, LlmHttpError, OPENROUTER_MODEL, streamChat, type LlmEvent } from "./openrouter-llm";

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
      { type: "usage", usage: { promptTokens: 1200, completionTokens: 40, cachedTokens: 1000, costCents: expect.closeTo(0.042, 9) } },
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
      { type: "usage", usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0, costCents: FALLBACK_PRICING.inputCentsPerMillion + FALLBACK_PRICING.outputCentsPerMillion } },
    ]);
  });

  it("HTTP de erro lança `LlmHttpError` com o status, sem repetir o corpo", async () => {
    const server = await startFakeSse((_request, reply) => reply.status(401, { error: { message: "chave sk-or-xyz inválida" } }));
    stops.push(() => server.stop());
    const failure = collect(streamChat({ apiKey: "k", baseUrl: server.url, messages: [], tools: [] }));
    await expect(failure).rejects.toBeInstanceOf(LlmHttpError);
    await expect(failure).rejects.toThrow("HTTP 401");
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
      { type: "usage", usage: expect.objectContaining({ completionTokens: 400, costCents: expect.any(Number) }) },
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
