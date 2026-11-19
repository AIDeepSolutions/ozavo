import { afterEach, describe, expect, it } from "vitest";
import { encodePipelineKey, InvalidPipelineKeyError, parsePipelineKey, pipelineCredentials } from "../pipeline/credentials";
import type { TurnMetrics } from "../pipeline/session";
import { pcm16ToUlaw } from "../resample";
import { expireAtOnce, startFakeHttp } from "../testing/fake-http";
import { manualClock, startFakeSse, startFakeWs, textChunk, toolChunk, until, usageChunk, type SseReply } from "../testing/fake-pipeline";
import type { LlmCallInfo, ToolSpec, VoiceSession } from "../types";
import engine, { CARTESIA_DEFAULT_VOICE, connectPipeline, InvalidVoiceError, worstKeyCheck } from "./deepgram-openrouter-cartesia";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const KEY = encodePipelineKey({ deepgram: "dg-falsa", cartesia: "sk_car_falsa", openrouter: "sk-or-falsa" });

const TOOLS: ToolSpec[] = [
  { name: "agenda_marcar", description: "Marca um horário na agenda.", parameters: { type: "object", properties: { inicio: { type: "string" } }, required: ["inicio"] } },
  { name: "agenda_remarcar", description: "Remarca.", parameters: { type: "object", properties: {} } },
  { name: "agenda_cancelar", description: "Cancela.", parameters: { type: "object", properties: {} } },
  { name: "call_webhook", description: "Chama o webhook.", parameters: { type: "object", properties: {} } },
];

const results = (transcript: string, speechFinal: boolean) => ({
  type: "Results",
  is_final: true,
  speech_final: speechFinal,
  channel: { alternatives: [{ transcript }] },
});

async function setup(options: { greeting?: string; voiceId?: string; llmProfile?: "a" | "b" | "c" } = {}) {
  const deepgram = await startFakeWs();
  const cartesia = await startFakeWs();
  const replies: SseReply[] = [];
  const openrouter = await startFakeSse((_request, reply) => void replies.push(reply));
  stops.push(() => deepgram.stop(), () => cartesia.stop(), () => openrouter.stop());
  const time = manualClock();
  const metrics: TurnMetrics[] = [];
  const session = await connectPipeline(
    { instructions: "Você é a recepcionista.", language: "pt-BR", tools: TOOLS, greeting: options.greeting, voiceId: options.voiceId, llmProfile: options.llmProfile },
    KEY,
    { urls: { stt: deepgram.url, tts: cartesia.url, llm: openrouter.url }, clock: time.clock, onMetrics: (m) => metrics.push(m) },
  );
  stops.unshift(() => session.close());
  const log = record(session);
  return { deepgram, cartesia, openrouter, replies, session, time, metrics, log };
}

function record(session: VoiceSession) {
  const log = { audio: [] as Buffer[], events: [] as string[], tools: [] as Array<{ id: string; name: string; args: unknown }>, transcripts: [] as string[] };
  session.on("audio", (pcm) => log.audio.push(pcm));
  session.on("toolCall", (call) => log.tools.push(call));
  session.on("transcript", (turn) => log.transcripts.push(`${turn.speaker}:${turn.text}`));
  session.on("interrupted", () => log.events.push("interrupted"));
  session.on("error", (error) => log.events.push(`error:${error.message}`));
  session.on("closed", (reason) => log.events.push(`closed:${reason}`));
  return log;
}

const ulawOf = (samples: number): string => {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i / 3)), i * 2);
  return pcm16ToUlaw(pcm).toString("base64");
};

describe("motor deepgram-openrouter-cartesia (contrato com servidores falsos)", () => {
  it("abre as duas pontas com as chaves certas; com saudação, o agente fala primeiro com a voz do tenant", async () => {
    const t = await setup({ greeting: "Clínica Exemplo, bom dia.", voiceId: "616c64d7-f541-436b-9b8d-e79cfbe19ef9" });
    expect(t.deepgram.request.headers.authorization).toBe("Token dg-falsa");
    expect(t.deepgram.request.url).toContain("language=pt-BR");
    expect(t.cartesia.request.headers["x-api-key"]).toBe("sk_car_falsa");
    const greeting = await t.cartesia.waitFor((m) => m.context_id === "say-1");
    expect(greeting).toMatchObject({
      transcript: "Clínica Exemplo, bom dia.",
      voice: "616c64d7-f541-436b-9b8d-e79cfbe19ef9",
      language: "pt",
      model_id: "sonic-3.6",
      output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
    });
  });

  it("sem voz escolhida, usa a padrão do motor; voz que não é id é recusada", async () => {
    const t = await setup({ greeting: "Oi." });
    expect(await t.cartesia.waitFor((m) => m.context_id === "say-1")).toMatchObject({ voice: CARTESIA_DEFAULT_VOICE });
    await expect(connectPipeline({ instructions: "", language: "pt-BR", tools: [], voiceId: "voz com espaço" }, KEY)).rejects.toBeInstanceOf(InvalidVoiceError);
  });

  it("uma conversa inteira: áudio sai para a Deepgram, o turno vai ao OpenRouter, a fala volta da Cartesia em PCM16 8 kHz", async () => {
    const t = await setup();
    const caller = Buffer.alloc(640, 3);
    t.session.sendAudio(caller);
    await until(() => t.deepgram.binary().length === 640);
    expect(t.deepgram.binary().equals(caller)).toBe(true);

    t.deepgram.send(results("Quero marcar uma consulta.", true));
    await until(() => t.replies.length === 1);
    const request = t.openrouter.requests[0];
    expect(request?.headers.authorization).toBe("Bearer sk-or-falsa");
    expect(request?.body).toMatchObject({ stream: true, messages: expect.arrayContaining([{ role: "user", content: "Quero marcar uma consulta." }]) });
    expect((request?.body.tools as unknown[]).length).toBe(4);

    t.replies[0]?.write(textChunk("Claro, para quando?"));
    const first = await t.cartesia.waitFor((m) => m.context_id === "turn-1");
    expect(first).toMatchObject({ transcript: "Claro, para quando?", continue: true });
    t.replies[0]?.write(usageChunk(300, 8, 0.0001));
    t.replies[0]?.end();
    expect(await t.cartesia.waitFor((m) => m.context_id === "turn-1")).toMatchObject({ continue: false });

    t.cartesia.send({ type: "chunk", data: ulawOf(160), context_id: "turn-1" });
    t.cartesia.send({ type: "done", context_id: "turn-1" });
    await until(() => t.log.transcripts.length === 2);
    expect(t.log.audio[0]?.length).toBe(320);
    expect(t.log.transcripts).toEqual(["user:Quero marcar uma consulta.", "agent:Claro, para quando?"]);
  });

  it("o perfil do agente chega ao pedido do modelo: padrão A (Haiku, cache, 1024), B (raciocínio desligado), C (Flash de antes)", async () => {
    const pedido = async (llmProfile?: "a" | "b" | "c") => {
      const t = await setup({ llmProfile });
      t.deepgram.send(results("Quero marcar uma consulta.", true));
      await until(() => t.replies.length === 1);
      return t.openrouter.requests[0]?.body as Record<string, unknown>;
    };
    const padrao = await pedido();
    expect(padrao).toMatchObject({ model: "anthropic/claude-haiku-5.5", max_tokens: 1024 });
    expect(padrao).not.toHaveProperty("reasoning");
    expect(JSON.stringify(padrao["messages"])).toContain("cache_control");

    expect(await pedido("a")).toMatchObject({ model: "anthropic/claude-haiku-5.5", max_tokens: 1024 });
    expect(await pedido("b")).toMatchObject({ model: "anthropic/claude-haiku-5.5", max_tokens: 400, reasoning: { enabled: false } });
    const c = await pedido("c");
    expect(c).toMatchObject({ model: "google/gemini-2.5-flash", max_tokens: 400 });
    expect(JSON.stringify(c["messages"])).not.toContain("cache_control");
  });

  it("cada chamada ao modelo emite `llmCall` com provedor, fim, raciocínio e cache, sem o texto", async () => {
    const t = await setup();
    const calls: LlmCallInfo[] = [];
    t.session.on("llmCall", (call) => calls.push(call));
    t.deepgram.send(results("Meu CPF é um dois três.", true));
    await until(() => t.replies.length === 1);
    t.replies[0]?.write({ provider: "Claude Platform on AWS", choices: [{ delta: { content: "Certo." }, finish_reason: "stop" }] });
    t.replies[0]?.write({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 60, cost: 0.0002, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 40 } } });
    t.replies[0]?.end();
    await until(() => calls.length === 1);
    expect(calls[0]).toMatchObject({ model: "anthropic/claude-haiku-5.5", provider: "Claude Platform on AWS", finishReason: "stop", reasoningTokens: 40, promptTokens: 500, cachedTokens: 400, completionTokens: 60 });
    expect(JSON.stringify(calls)).not.toContain("CPF");
    expect(JSON.stringify(calls)).not.toContain("Certo");
  });

  it("provedor que recusa reasoning/cache_control (400): repete sem eles, registra llmCall com fallback e os turnos seguintes já pedem sem", async () => {
    const t = await setup({ llmProfile: "b" });
    const calls: LlmCallInfo[] = [];
    t.session.on("llmCall", (call) => calls.push(call));
    t.deepgram.send(results("Quero marcar uma consulta.", true));
    await until(() => t.replies.length === 1);
    t.replies[0]?.status(400, { error: { message: "unsupported parameter" } });
    await until(() => t.replies.length === 2);
    t.replies[1]?.write(textChunk("Claro, para quando?"));
    t.replies[1]?.write(usageChunk(300, 8, 0.0001));
    t.replies[1]?.end();
    await until(() => calls.length === 2);
    expect(calls[0]).toEqual({ promptTokens: 0, cachedTokens: 0, completionTokens: 0, fallback: true, fallbackStatus: 400 });
    expect(calls[1]?.fallback).toBeUndefined();
    expect(t.openrouter.requests[0]?.body).toHaveProperty("reasoning");
    expect(t.openrouter.requests[1]?.body).not.toHaveProperty("reasoning");
    expect(JSON.stringify(t.openrouter.requests[1]?.body)).not.toContain("cache_control");
    // Nenhuma desculpa: a fala do agente chegou à síntese.
    expect(await t.cartesia.waitFor((m) => m.context_id === "turn-1")).toMatchObject({ transcript: "Claro, para quando?" });
  });

  it("chamada de função vira `toolCall`, e o resultado volta ao modelo com o mesmo id", async () => {
    const t = await setup();
    t.deepgram.send(results("Pode marcar sexta às dez.", true));
    await until(() => t.replies.length === 1);
    t.replies[0]?.write(toolChunk(0, { id: "call_9", name: "agenda_marcar", arguments: '{"inicio":"2026-11-20T10:00:00-03:00"}' }));
    t.replies[0]?.end();
    await until(() => t.log.tools.length === 1);
    expect(t.log.tools).toEqual([{ id: "call_9", name: "agenda_marcar", args: { inicio: "2026-11-20T10:00:00-03:00" } }]);
    t.session.sendToolResult("call_9", { ok: true, message: "Marcado para sexta, 10h." });
    await until(() => t.replies.length === 2);
    expect(t.openrouter.requests[1]?.body.messages).toEqual(
      expect.arrayContaining([{ role: "tool", tool_call_id: "call_9", content: JSON.stringify({ ok: true, message: "Marcado para sexta, 10h." }) }]),
    );
  });

  it("barge-in: fala de quem ligou por cima corta a Cartesia (`cancel`) e emite `interrupted`", async () => {
    const t = await setup({ greeting: "Bom dia, aqui é a Clínica Exemplo, em que posso ajudar?" });
    await t.cartesia.waitFor((m) => m.context_id === "say-1");
    t.cartesia.send({ type: "chunk", data: ulawOf(1600), context_id: "say-1" });
    await until(() => t.log.audio.length === 1);
    // Fala alta e sustentada (> 120 ms): o VAD local dispara sem esperar a Deepgram.
    const loud = Buffer.alloc(320 * 10);
    for (let i = 0; i < loud.length / 2; i++) loud.writeInt16LE(i % 2 === 0 ? 9000 : -9000, i * 2);
    t.session.sendAudio(loud);
    expect(t.log.events).toEqual(["interrupted"]);
    expect(await t.cartesia.waitFor((m) => m.cancel === true)).toEqual({ context_id: "say-1", cancel: true });
  });

  it("mensagem fora do formato é ignorada sem derrubar a sessão", async () => {
    const t = await setup();
    t.deepgram.send({ type: "Results", channel: "errado" });
    t.deepgram.send("não é json");
    t.cartesia.send({ type: "chunk", data: 42 });
    t.deepgram.send(results("Oi.", true));
    await until(() => t.replies.length === 1);
    expect(t.log.events).toEqual([]);
  });

  it("queda de qualquer provedor vira `error` seguido de `closed`", async () => {
    const t = await setup();
    t.deepgram.drop();
    await until(() => t.log.events.includes("closed:socket_closed"));
    expect(t.log.events[0]).toMatch(/^error:Deepgram/);
    expect(t.log.events.at(-1)).toBe("closed:socket_closed");
  });

  it("close() duas vezes não gera erro", async () => {
    const t = await setup();
    await t.session.close();
    await t.session.close();
    expect(t.log.events).toEqual(["closed:client"]);
  });

  it("conexão recusada, ou chave sem as três partes, rejeita o connect", async () => {
    const dead = await startFakeWs();
    const url = dead.url;
    await dead.stop();
    const cartesia = await startFakeWs();
    stops.push(() => cartesia.stop());
    await expect(connectPipeline({ instructions: "", language: "pt-BR", tools: [] }, KEY, { urls: { stt: url, tts: cartesia.url } })).rejects.toThrow(/Deepgram/);
    await expect(connectPipeline({ instructions: "", language: "pt-BR", tools: [] }, "sk-uma-chave-so")).rejects.toBeInstanceOf(InvalidPipelineKeyError);
  });

  it("latência medida pelo relógio injetado: TTFB < 100 ms e RTT < 500 ms com provedores simulados", async () => {
    const t = await setup();
    t.deepgram.send(results("Qual o horário?", true));
    // O endpointing usa o agendador real aqui (120 ms de prazo); o relógio é o de teste.
    await until(() => t.replies.length === 1);
    t.time.advance(120 + 180); // prazo do endpointing + primeiro token do modelo
    t.replies[0]?.write(textChunk("Das oito às dezoito."));
    await t.cartesia.waitFor((m) => m.context_id === "turn-1");
    t.time.advance(60); // TTFB da síntese
    t.cartesia.send({ type: "chunk", data: ulawOf(160), context_id: "turn-1" });
    await until(() => t.metrics.length === 1);
    t.replies[0]?.end();
    expect(t.metrics[0]?.ttfbMs).toBe(60);
    expect(t.metrics[0]?.rttMs).toBe(360);
    expect(t.metrics[0]?.ttfbMs).toBeLessThan(100);
    expect(t.metrics[0]?.rttMs).toBeLessThan(500);
  });
});

describe("checkKey (servidor HTTP falso)", () => {
  it("as três chaves aceitas: `accepted`, cada uma no cabeçalho do seu provedor, sem gastar", async () => {
    // Cada provedor responde no formato dele: um fetch roteado pelo caminho, sem rede.
    const seen: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
    const bodies: Record<string, unknown> = { "/v1/projects": { projects: [{ project_id: "p" }] }, "/voices": { data: [], has_more: false }, "/api/v1/key": { data: { label: "teste" } } };
    const routed: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(bodies[url.pathname] ?? {}), { status: 200 });
    };
    const check = await engine.checkKey(KEY, { baseUrl: "https://falso.invalid", fetch: routed });
    expect(check.result).toBe("accepted");
    const byPath = Object.fromEntries(seen.map((r) => [r.path, r]));
    expect(byPath["/v1/projects"]?.headers.Authorization).toBe("Token dg-falsa");
    expect(byPath["/voices"]?.headers.Authorization).toBe("Bearer sk_car_falsa");
    expect(byPath["/voices"]?.headers["Cartesia-Version"]).toBeTruthy();
    expect(byPath["/api/v1/key"]?.headers.Authorization).toBe("Bearer sk-or-falsa");
    expect(seen.every((r) => r.method === "GET")).toBe(true);
  });

  it("recusa, crédito, limite e erro do provedor viram o vocabulário fechado", async () => {
    const http = await startFakeHttp();
    stops.push(() => http.stop());
    for (const [status, result] of [
      [401, "rejected"],
      [402, "no_credit"],
      [429, "rate_limited"],
      [503, "unreachable"],
    ] as const) {
      http.respond({ status, body: {} });
      expect((await engine.checkKey(KEY, { baseUrl: http.url })).result).toBe(result);
    }
    http.respond({ status: 200, body: { outro: "formato" } });
    expect((await engine.checkKey(KEY, { baseUrl: http.url })).result).toBe("unexpected_response");
  });

  it("chave que não é o JSON das três é `rejected`, sem pedido nenhum", async () => {
    const http = await startFakeHttp();
    stops.push(() => http.stop());
    expect((await engine.checkKey("sk-solta", { baseUrl: http.url })).result).toBe("rejected");
    expect(http.requests).toEqual([]);
  });

  it("prazo estourado é `unreachable`", async () => {
    const http = await startFakeHttp();
    stops.push(() => http.stop());
    http.respond({ status: 200, hang: true });
    expect((await engine.checkKey(KEY, { baseUrl: http.url, schedule: expireAtOnce })).result).toBe("unreachable");
  });

  it("das três respostas vale a que pede atenção", () => {
    expect(worstKeyCheck(["accepted", "rejected", "accepted"])).toBe("rejected");
    expect(worstKeyCheck(["accepted", "accepted", "accepted"])).toBe("accepted");
    expect(worstKeyCheck(["rate_limited", "unreachable"])).toBe("unreachable");
  });
});

describe("declaração do motor", () => {
  it("preço com data e fonte; vozes pt com padrão na lista", () => {
    expect(engine.pricing.checkedOn).toBe("2026-11-16");
    expect(engine.pricing.centsPerMinute).toBeGreaterThan(0);
    expect(engine.pricing.centsPerMillionCharacters).toBeGreaterThan(0);
    expect(engine.voices?.some((voice) => voice.id === engine.defaultVoice)).toBe(true);
  });
});

describe("partes da chave na tela", () => {
  it("pede um campo por provedor, e o JSON que a tela monta é o que o motor lê", () => {
    const ids = (engine.keyParts ?? []).map((part) => part.id);
    expect([...ids].sort()).toEqual(Object.keys(pipelineCredentials.shape).sort());
    const typed = Object.fromEntries(ids.map((id) => [id, ` ${id}-falsa `]));
    expect(parsePipelineKey(JSON.stringify(typed))).toEqual({ deepgram: "deepgram-falsa", cartesia: "cartesia-falsa", openrouter: "openrouter-falsa" });
  });
});
