import { describe, expect, it } from "vitest";
import engine from "../engines/deepgram-openrouter-cartesia";
import { estimateCostMicrocents } from "../pricing";
import { silence, speech } from "../testing/audio";
import { manualClock, manualScheduler, until } from "../testing/fake-pipeline";
import type { AnsweringMachineDetection, ToolSpec, Usage, VoiceSessionConfig } from "../types";
import type { TtsHandlers } from "./cartesia-tts";
import type { SttHandlers } from "./deepgram-stt";
import { ENDPOINT_CLOSED_MS } from "./endpointing";
import type { ChatMessage, LlmEvent } from "./openrouter-llm";
import { createPipelineSession, isEchoOf, speakable, splitPoint, type TurnMetrics } from "./session";

/** Um pedido ao modelo que o teste controla: empurra eventos, termina ou falha quando quiser. */
class ScriptedStream {
  private queue: LlmEvent[] = [];
  private waiting: (() => void) | undefined;
  private ended = false;
  private failure: Error | undefined;
  constructor(
    readonly messages: ChatMessage[],
    readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", () => this.wake());
  }
  push(...events: LlmEvent[]): void {
    this.queue.push(...events);
    this.wake();
  }
  end(): void {
    this.ended = true;
    this.wake();
  }
  fail(error: Error): void {
    this.failure = error;
    this.wake();
  }
  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }
  async *events(): AsyncGenerator<LlmEvent> {
    for (;;) {
      if (this.signal.aborted) return;
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }
}

const TOOLS: ToolSpec[] = ["agenda_marcar", "agenda_remarcar", "agenda_cancelar", "call_webhook"].map((name) => ({
  name,
  description: `Ferramenta ${name}.`,
  parameters: { type: "object", properties: {} },
}));

async function setup(config: Partial<VoiceSessionConfig> = {}, options: { amd?: false } = {}) {
  const time = manualClock();
  const timers = manualScheduler();
  const streams: ScriptedStream[] = [];
  const spoken: Array<{ contextId: string; text: string; final: boolean; at: number }> = [];
  const cancelled: string[] = [];
  const sentAudio: Buffer[] = [];
  let finalizes = 0;
  let sttSeconds = 0;
  let ttsCharacters = 0;
  let closes = 0;
  let stt: SttHandlers | undefined;
  let tts: TtsHandlers | undefined;
  const metrics: TurnMetrics[] = [];
  const emittedMetrics: TurnMetrics[] = [];
  const session = await createPipelineSession({
    config: { instructions: "Você é a recepcionista da Clínica Exemplo.", language: "pt-BR", tools: TOOLS, ...config },
    clock: time.clock,
    schedule: timers.schedule,
    onMetrics: (m) => metrics.push(m),
    amd: options.amd,
    openStt: async (handlers) => {
      stt = handlers;
      return {
        sendAudio: (pcm) => sentAudio.push(pcm),
        finalize: () => void finalizes++,
        drainSeconds: () => {
          const value = sttSeconds;
          sttSeconds = 0;
          return value;
        },
        close: async () => void closes++,
      };
    },
    openTts: async (handlers) => {
      tts = handlers;
      return {
        speak: (contextId, text, final) => {
          ttsCharacters += text.length;
          spoken.push({ contextId, text, final, at: time.ms });
        },
        cancel: (contextId) => cancelled.push(contextId),
        drainCharacters: () => {
          const value = ttsCharacters;
          ttsCharacters = 0;
          return value;
        },
        close: async () => void closes++,
      };
    },
    chat: (messages, _tools, signal) => {
      const stream = new ScriptedStream([...messages], signal);
      streams.push(stream);
      return stream.events();
    },
  });
  const events: string[] = [];
  const usages: Usage[] = [];
  const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
  const transcripts: Array<{ speaker: string; text: string }> = [];
  const amd: AnsweringMachineDetection[] = [];
  const audio: Buffer[] = [];
  session.on("interrupted", () => events.push("interrupted"));
  session.on("error", (error) => events.push(`error:${error.message}`));
  session.on("closed", (reason) => events.push(`closed:${reason}`));
  session.on("usage", (usage) => usages.push(usage));
  session.on("toolCall", (call) => toolCalls.push(call));
  session.on("transcript", (turn) => transcripts.push(turn));
  session.on("answeringMachine", (detection) => amd.push(detection));
  session.on("turnMetrics", (measured) => emittedMetrics.push(measured));
  session.on("audio", (pcm) => audio.push(pcm));
  if (!stt || !tts) throw new Error("portas não abertas");
  const ports = { stt, tts };
  const addSttSeconds = (s: number) => (sttSeconds += s);
  return { session, time, timers, streams, spoken, cancelled, sentAudio, metrics, emittedMetrics, events, usages, toolCalls, transcripts, amd, audio, ports, addSttSeconds, finalizes: () => finalizes, closes: () => closes };
}

/** Quem ligou fala e para: a STT entrega o final com pausa, e o endpointing marca o prazo. */
function callerSays(t: Awaited<ReturnType<typeof setup>>, text: string): void {
  t.ports.stt.partial(text.slice(0, 5));
  t.ports.stt.final(text, true);
}

describe("sessão do pipeline", () => {
  it("contabiliza saudação depois de os handlers serem registrados", async () => {
    const t = await setup({ greeting: "Bom dia." });
    t.ports.tts.done("say-1");
    expect(t.usages).toEqual([{ seconds: 0, characters: 8 }]);
  });

  it("say tem prioridade e cancela a síntese anterior sem intercalar contextos", async () => {
    const t = await setup({ greeting: "Bom dia." });
    t.session.say("Preciso encerrar.");
    expect(t.cancelled).toEqual(["say-1"]);
    t.ports.tts.audio("say-1", Buffer.alloc(320));
    t.ports.tts.audio("say-2", Buffer.alloc(640));
    expect(t.audio).toHaveLength(1);
    expect(t.audio[0]?.length).toBe(640);
  });

  it("recusa conexão se uma ponta cair enquanto a outra ainda abre", async () => {
    let sttClosed = false;
    let failed: ((error: Error) => void) | undefined;
    await expect(createPipelineSession({
      config: { instructions: "", language: "pt-BR", tools: [] },
      clock: manualClock().clock,
      openStt: async (handlers) => {
        failed = handlers.failed;
        return { sendAudio: () => undefined, finalize: () => undefined, drainSeconds: () => 0, close: async () => { sttClosed = true; } };
      },
      openTts: async () => {
        failed?.(new Error("conexão perdida durante abertura"));
        return { speak: () => undefined, cancel: () => undefined, drainCharacters: () => 0, close: async () => undefined };
      },
      chat: async function* () { yield* []; },
    })).rejects.toThrow("conexão perdida durante abertura");
    expect(sttClosed).toBe(true);
  });

  it("limita o turno ao alvo de 160 caracteres, deixando a frase em curso terminar, sem impedir chamadas de ferramenta", async () => {
    const t = await setup();
    callerSays(t, "Explique os serviços.");
    t.timers.runAll();
    t.streams[0]?.push({ type: "text", delta: "Podemos ajudar com sua consulta. ".repeat(30) }, { type: "tool_call", call: { id: "c1", type: "function", function: { name: "call_webhook", arguments: "{}" } } });
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 1);
    // Cinco frases de 33 caracteres: a quinta cruza os 160 e termina dentro da tolerância.
    expect(t.spoken.map((piece) => piece.text).join("")).toBe("Podemos ajudar com sua consulta. ".repeat(5).trimEnd());
  });

  it("inbound não roda detecção de caixa postal", async () => {
    const t = await setup();
    t.ports.stt.final("Deixe sua mensagem após o sinal.", true);
    expect(t.amd).toEqual([]);
  });

  it("resultado rápido de ferramenta espera a síntese anterior terminar", async () => {
    const t = await setup();
    callerSays(t, "Verifique a agenda.");
    t.timers.runAll();
    t.streams[0]?.push({ type: "text", delta: "Vou verificar." }, { type: "tool_call", call: { id: "c1", type: "function", function: { name: "call_webhook", arguments: "{}" } } });
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 1);
    t.session.sendToolResult("c1", { ok: true });
    expect(t.streams).toHaveLength(1);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    expect(t.audio).toHaveLength(1);
    t.ports.tts.done("turn-1");
    expect(t.streams).toHaveLength(2);
  });

  it("áudio tardio de contexto cancelado é descartado", async () => {
    const t = await setup({ greeting: "Bom dia." });
    t.ports.stt.partial("Olá");
    t.ports.tts.audio("say-1", Buffer.alloc(320));
    expect(t.audio).toEqual([]);
  });

  it("fala contínua emite consumo de STT a cada segundo, sem esperar transcrição", async () => {
    const t = await setup();
    t.addSttSeconds(1);
    t.session.sendAudio(Buffer.alloc(16000));
    expect(t.usages).toEqual([{ seconds: 1, characters: 0 }]);
  });

  it("com saudação, o agente fala primeiro, num contexto próprio", async () => {
    const t = await setup({ greeting: "Clínica Exemplo, bom dia." });
    expect(t.spoken).toEqual([{ contextId: "say-1", text: "Clínica Exemplo, bom dia.", final: true, at: t.time.ms }]);
    // A transcrição sai quando a fala termina: quem chama já registrou os handlers.
    expect(t.transcripts).toEqual([]);
    t.ports.tts.done("say-1");
    expect(t.transcripts).toEqual([{ speaker: "agent", text: "Clínica Exemplo, bom dia." }]);
  });

  it("áudio de quem ligou vai para a STT como chegou (PCM16 8 kHz)", async () => {
    const t = await setup();
    const chunk = silence(1);
    t.session.sendAudio(chunk);
    expect(t.sentAudio).toEqual([chunk]);
  });

  it("endpointing dinâmico: frase fechada encerra o turno no prazo curto, e o modelo recebe o histórico", async () => {
    const t = await setup();
    callerSays(t, "Quero marcar uma consulta.");
    expect(t.timers.pending()).toEqual([ENDPOINT_CLOSED_MS]);
    expect(t.streams).toHaveLength(0);
    t.timers.runAll();
    expect(t.transcripts).toEqual([{ speaker: "user", text: "Quero marcar uma consulta." }]);
    expect(t.streams).toHaveLength(1);
    const messages = t.streams[0]?.messages ?? [];
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(messages[0]?.role === "system" && messages[0].content).toContain("português do Brasil");
    expect(messages.at(-1)).toEqual({ role: "user", content: "Quero marcar uma consulta." });
  });

  it("a pessoa continuar falando cancela o fim de turno marcado", async () => {
    const t = await setup();
    t.ports.stt.final("Quero marcar para", true);
    expect(t.timers.pending()).toHaveLength(1);
    t.ports.stt.partial("sexta");
    expect(t.timers.pending()).toEqual([]);
    t.ports.stt.final("sexta de manhã.", true);
    t.timers.runAll();
    expect(t.transcripts).toEqual([{ speaker: "user", text: "Quero marcar para sexta de manhã." }]);
  });

  it("a primeira frase do modelo vai para a síntese antes de ele terminar de escrever", async () => {
    const t = await setup();
    callerSays(t, "Vocês abrem sábado?");
    t.timers.runAll();
    const stream = t.streams[0];
    stream?.push({ type: "text", delta: "Abrimos, sim." }, { type: "text", delta: " Das oito ao meio-dia" });
    await until(() => t.spoken.length === 1);
    expect(t.spoken[0]).toMatchObject({ contextId: "turn-1", text: "Abrimos, sim.", final: false });
    stream?.push({ type: "text", delta: "." });
    stream?.end();
    await until(() => t.spoken.some((s) => s.final));
    expect(t.spoken.map((s) => s.text).join("")).toBe("Abrimos, sim. Das oito ao meio-dia.");
    t.ports.tts.done("turn-1");
    expect(t.transcripts.at(-1)).toEqual({ speaker: "agent", text: "Abrimos, sim. Das oito ao meio-dia." });
  });

  it("ferramentas: agendar, reagendar, cancelar e webhook viram `toolCall`, e o resultado volta com o id", async () => {
    const t = await setup();
    callerSays(t, "Quero remarcar e avisar o sistema.");
    t.timers.runAll();
    t.streams[0]?.push(
      { type: "tool_call", call: { id: "c1", type: "function", function: { name: "agenda_remarcar", arguments: '{"de":"a","para":"b"}' } } },
      { type: "tool_call", call: { id: "c2", type: "function", function: { name: "call_webhook", arguments: "não é json" } } },
    );
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 2);
    expect(t.toolCalls).toEqual([
      { id: "c1", name: "agenda_remarcar", args: { de: "a", para: "b" } },
      { id: "c2", name: "call_webhook", args: "não é json" },
    ]);
    // Quem ligou fala enquanto as ferramentas rodam: a fala espera os resultados entrarem no histórico.
    callerSays(t, "Obrigado.");
    t.timers.runAll();
    t.session.sendToolResult("c1", { ok: true, message: "Remarcado." });
    expect(t.streams).toHaveLength(1);
    t.session.sendToolResult("desconhecido", { ok: true });
    t.session.sendToolResult("c2", { ok: true, message: "Webhook chamado." });
    expect(t.streams).toHaveLength(2);
    const tail = t.streams[1]?.messages.slice(-4);
    expect(tail).toEqual([
      { role: "assistant", content: null, tool_calls: expect.arrayContaining([expect.objectContaining({ id: "c1" })]) },
      { role: "tool", tool_call_id: "c1", content: JSON.stringify({ ok: true, message: "Remarcado." }) },
      { role: "tool", tool_call_id: "c2", content: JSON.stringify({ ok: true, message: "Webhook chamado." }) },
      { role: "user", content: "Obrigado." },
    ]);
  });

  it("barge-in: a fala de quem ligou corta o modelo e a síntese, e emite `interrupted`", async () => {
    const t = await setup();
    callerSays(t, "Me explica os planos.");
    t.timers.runAll();
    const stream = t.streams[0];
    stream?.push({ type: "text", delta: "Temos três planos. O primeiro" });
    await until(() => t.spoken.length === 1);
    t.ports.tts.audio("turn-1", Buffer.alloc(16_000));
    t.session.sendAudio(Buffer.concat([silence(10), speech(16)]));
    expect(t.events).toContain("interrupted");
    expect(t.cancelled).toEqual(["turn-1"]);
    expect(stream?.signal.aborted).toBe(true);
    // O que já tinha sido falado fica registrado, e o modelo sabe até onde foi.
    expect(t.transcripts.at(-1)).toEqual({ speaker: "agent", text: "Temos três planos." });
    callerSays(t, "Só o mais barato.");
    t.timers.runAll();
    expect(t.streams[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: "Temos três planos." },
      { role: "user", content: "Só o mais barato." },
    ]);
  });

  it("barge-in também corta a saudação; sem o agente falando, fala de quem ligou não interrompe", async () => {
    const t = await setup({ greeting: "Bom dia, aqui é a Clínica Exemplo, em que posso ajudar?" });
    t.session.sendAudio(Buffer.concat([silence(10), speech(16)]));
    expect(t.events).toEqual(["interrupted"]);
    expect(t.cancelled).toEqual(["say-1"]);
    t.session.sendAudio(Buffer.concat([silence(20), speech(16)]));
    expect(t.events).toEqual(["interrupted"]);
  });

  it("eco da própria fala do agente (transcrição ou início de fala do provedor) não o interrompe", async () => {
    const t = await setup({ greeting: "Bom dia, aqui é a Clínica Exemplo, em que posso ajudar?" });
    t.ports.stt.speechStarted();
    t.ports.stt.partial("em que posso ajudar");
    t.session.sendAudio(Buffer.concat([silence(10), speech(8)])); // estalo curto: abaixo dos 280 ms
    expect(t.events).toEqual([]);
    expect(t.cancelled).toEqual([]);
    // Palavra que o agente não disse é a pessoa falando por cima.
    t.ports.stt.partial("espera um instante");
    expect(t.events).toEqual(["interrupted"]);
  });

  it("o que vai para a voz sai sem marcação, emoji, símbolo ou abreviação; a transcrição guarda o original", async () => {
    const t = await setup();
    callerSays(t, "Quanto custa?");
    t.timers.runAll();
    t.streams[0]?.push({ type: "text", delta: "O plano custa R$ 49,90 por mês, **com 10% de desconto** 😊 (Sr. Paulo)." });
    t.streams[0]?.end();
    await until(() => t.spoken.some((s) => s.final));
    const said = t.spoken.map((s) => s.text).join("");
    expect(said).not.toMatch(/[*😊()%$]/u);
    expect(said).toContain("49 reais e 90 centavos");
    expect(said).toContain("10 por cento");
    expect(said).toContain("senhor Paulo");
  });

  it("a ponte ainda tocando o áudio conta como agente falando (o provedor termina antes)", async () => {
    const t = await setup();
    callerSays(t, "Oi.");
    t.timers.runAll();
    t.streams[0]?.push({ type: "text", delta: "Olá, tudo bem?" });
    t.streams[0]?.end();
    await until(() => t.spoken.some((s) => s.final));
    t.ports.tts.audio("turn-1", Buffer.alloc(32_000)); // 2 s de fala
    t.ports.tts.done("turn-1");
    t.time.advance(500);
    t.session.sendAudio(Buffer.concat([silence(10), speech(16)]));
    expect(t.events).toEqual(["interrupted"]);
  });

  it("custo: segundos de STT, caracteres de TTS e o custo declarado pelo OpenRouter; o preço do motor fecha a conta", async () => {
    const t = await setup();
    t.addSttSeconds(60);
    callerSays(t, "Oi.");
    t.timers.runAll();
    t.streams[0]?.push({ type: "text", delta: "Olá." }, { type: "usage", usage: { promptTokens: 500, completionTokens: 10, cachedTokens: 400, costCents: 0.05 } });
    t.streams[0]?.end();
    await until(() => t.spoken.some((s) => s.final));
    t.ports.tts.done("turn-1");
    const total = t.usages.reduce<Required<Pick<Usage, "seconds" | "characters" | "providerCostCents" | "textInputTokens" | "cachedInputTokens" | "textOutputTokens">>>(
      (sum, u) => ({
        seconds: sum.seconds + (u.seconds ?? 0),
        characters: sum.characters + (u.characters ?? 0),
        providerCostCents: sum.providerCostCents + (u.providerCostCents ?? 0),
        textInputTokens: sum.textInputTokens + (u.textInputTokens ?? 0),
        cachedInputTokens: sum.cachedInputTokens + (u.cachedInputTokens ?? 0),
        textOutputTokens: sum.textOutputTokens + (u.textOutputTokens ?? 0),
      }),
      { seconds: 0, characters: 0, providerCostCents: 0, textInputTokens: 0, cachedInputTokens: 0, textOutputTokens: 0 },
    );
    expect(total).toEqual({ seconds: 60, characters: 4, providerCostCents: 0.05, textInputTokens: 100, cachedInputTokens: 400, textOutputTokens: 10 });
    // 1 min de Deepgram (0,77 ¢) + 4 caracteres de Cartesia (6500 ¢/M) + 0,05 ¢ do OpenRouter, tokens sem preço próprio.
    expect(estimateCostMicrocents(engine.pricing, total)).toBe(Math.round((0.77 + (4 / 1e6) * 6500 + 0.05) * 1e6));
  });

  it("falha do modelo: erro para o painel e uma desculpa para quem está na linha, nunca silêncio", async () => {
    const t = await setup();
    callerSays(t, "Oi.");
    t.timers.runAll();
    t.streams[0]?.fail(new Error("OpenRouter: o pedido falhou (HTTP 502)"));
    await until(() => t.spoken.length > 0);
    expect(t.events).toEqual(["error:OpenRouter: o pedido falhou (HTTP 502)"]);
    expect(t.spoken[0]?.text).toMatch(/^Desculpe/);
  });

  it("caixa postal: a frase típica emite `answeringMachine` uma vez", async () => {
    const t = await setup({ direction: "outbound" });
    t.ports.stt.final("Deixe sua mensagem após o sinal.", true);
    t.ports.stt.final("Deixe sua mensagem após o sinal.", true);
    expect(t.amd).toEqual([{ verdict: "machine", reason: "phrase" }]);
  });

  it("closeCallerTurn fecha o turno com o que já foi ouvido, ou pede o final à STT", async () => {
    const t = await setup();
    t.session.closeCallerTurn();
    expect(t.finalizes()).toBe(1);
    t.ports.stt.partial("é que eu");
    t.session.closeCallerTurn();
    expect(t.transcripts).toEqual([{ speaker: "user", text: "é que eu" }]);
  });

  it("queda de uma ponta vira `error` seguido de `closed`, e fecha a outra", async () => {
    const t = await setup();
    t.ports.tts.failed(new Error("Cartesia: a conexão caiu"));
    await until(() => t.events.includes("closed:socket_closed"));
    expect(t.events).toEqual(["error:Cartesia: a conexão caiu", "closed:socket_closed"]);
    expect(t.closes()).toBe(2);
  });

  it("close() duas vezes fecha uma vez, sem erro", async () => {
    const t = await setup();
    await Promise.all([t.session.close(), t.session.close()]);
    await t.session.close();
    expect(t.events).toEqual(["closed:client"]);
    expect(t.closes()).toBe(2);
  });

  it("uma ponta que não abre rejeita a abertura e fecha a outra", async () => {
    let sttClosed = false;
    await expect(
      createPipelineSession({
        config: { instructions: "", language: "pt-BR", tools: [] },
        clock: manualClock().clock,
        openStt: async () => ({ sendAudio: () => undefined, finalize: () => undefined, drainSeconds: () => 0, close: async () => void (sttClosed = true) }),
        openTts: async () => {
          throw new Error("Cartesia: não foi possível conectar");
        },
        chat: async function* () {
          yield* [];
        },
      }),
    ).rejects.toThrow("Cartesia: não foi possível conectar");
    expect(sttClosed).toBe(true);
  });
});

describe("latência do turno (relógio de teste; os atrasos dos provedores são os simulados abaixo)", () => {
  // Atrasos de provedor simulados, conservadores para provedores na mesma região que a VPS. O que o
  // teste prova é que o pipeline não soma espera nenhuma às deles: o RTT é endpointing + primeiro
  // token + TTFB, e não depende de o modelo terminar de escrever.
  const LLM_FIRST_TOKEN_MS = 180;
  const TTS_TTFB_MS = 60;
  const LLM_REST_MS = 900;

  it("TTFB < 100 ms e RTT < 500 ms com streaming de ponta a ponta", async () => {
    const t = await setup();
    callerSays(t, "Qual o horário de vocês?");
    const speechEnd = t.time.ms;
    t.time.advance(ENDPOINT_CLOSED_MS);
    t.timers.runAll();
    t.time.advance(LLM_FIRST_TOKEN_MS);
    t.streams[0]?.push({ type: "text", delta: "Atendemos das oito às dezoito." });
    await until(() => t.spoken.length === 1);
    t.time.advance(TTS_TTFB_MS);
    t.ports.tts.firstAudio("turn-1", TTS_TTFB_MS);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    // O modelo ainda escreve o resto da resposta muito depois: não muda a latência percebida.
    t.time.advance(LLM_REST_MS);
    t.streams[0]?.push({ type: "text", delta: " De segunda a sexta." });
    t.streams[0]?.end();
    await until(() => t.spoken.some((s) => s.final));
    expect(t.metrics).toEqual([
      { turn: 1, endpointDelayMs: ENDPOINT_CLOSED_MS, llmFirstTokenMs: ENDPOINT_CLOSED_MS + LLM_FIRST_TOKEN_MS, ttfbMs: TTS_TTFB_MS, rttMs: ENDPOINT_CLOSED_MS + LLM_FIRST_TOKEN_MS + TTS_TTFB_MS },
    ]);
    // A mesma medida sai como evento da sessão, que a conversa grava na linha do tempo.
    expect(t.emittedMetrics).toEqual(t.metrics);
    expect(t.metrics[0]?.ttfbMs).toBeLessThan(100);
    expect(t.metrics[0]?.rttMs).toBeLessThan(500);
    expect(t.spoken[0]?.at).toBe(speechEnd + ENDPOINT_CLOSED_MS + LLM_FIRST_TOKEN_MS);
  });

  it("o primeiro trecho sai cedo: corte em vírgula num começo longo, não só no ponto final", () => {
    expect(splitPoint("Sim.", true)).toBe(-1);
    expect(splitPoint("Pois não, claro.", true)).toBe(16);
    expect(splitPoint("Claro, posso verificar isso para você, um instante", true)).toBe(38);
    expect(splitPoint("Claro, posso verificar isso", false)).toBe(-1);
    expect(splitPoint("Ok.", false)).toBe(-1);
  });
});

describe("confirmação só depois do resultado da escrita (write-guard)", () => {
  const writeCall = (id: string) => ({ type: "tool_call" as const, call: { id, type: "function" as const, function: { name: "agenda_marcar", arguments: "{}" } } });

  it("a frase 'está marcado' dita no mesmo turno da chamada de escrita não é falada nem fica no histórico", async () => {
    const t = await setup();
    callerSays(t, "Sim, pode marcar.");
    t.timers.runAll();
    t.streams[0]?.push({ type: "text", delta: "Pronto, sua consulta está marcada para quinta às nove." }, writeCall("w1"));
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 1);
    expect(t.spoken.map((piece) => piece.text).join("")).toBe("");
    t.session.sendToolResult("w1", { ok: true, message: "Horário marcado." });
    await until(() => t.streams.length === 2);
    const assistant = t.streams[1]?.messages.find((m) => m.role === "assistant" && "tool_calls" in m);
    expect(assistant).toMatchObject({ content: null });
  });

  it("texto que não afirma nada feito sai como antes, junto da chamada de escrita", async () => {
    const t = await setup();
    callerSays(t, "Sim, pode marcar.");
    t.timers.runAll();
    t.streams[0]?.push({ type: "text", delta: "Um instante, vou marcar para você." }, writeCall("w1"));
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 1);
    expect(t.spoken.map((piece) => piece.text).join("")).toBe("Um instante, vou marcar para você.");
  });

  it("depois de uma escrita que falhou, 'está marcado' não é falado e a pessoa ouve a indisponibilidade", async () => {
    const t = await setup();
    callerSays(t, "Sim, pode marcar.");
    t.timers.runAll();
    t.streams[0]?.push(writeCall("w1"));
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 1);
    t.session.sendToolResult("w1", { ok: false, message: "O sistema de agenda não respondeu." });
    await until(() => t.streams.length === 2);
    t.streams[1]?.push({ type: "text", delta: "Pronto, está marcado para quinta às nove." });
    t.streams[1]?.end();
    await until(() => t.spoken.length > 0);
    const said = t.spoken.map((piece) => piece.text).join("");
    expect(said).toContain("Não consegui concluir isso na agenda agora");
    expect(said).not.toContain("está marcado");
  });

  it("a retenção vale também depois de um turno só de consulta no meio: só uma escrita bem-sucedida a levanta", async () => {
    const t = await setup();
    callerSays(t, "Sim, pode marcar.");
    t.timers.runAll();
    t.streams[0]?.push(writeCall("w1"));
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 1);
    t.session.sendToolResult("w1", { ok: false, message: "recusada" });
    await until(() => t.streams.length === 2);
    t.streams[1]?.push({ type: "tool_call", call: { id: "r1", type: "function", function: { name: "call_webhook", arguments: "{}" } } });
    t.streams[1]?.end();
    await until(() => t.toolCalls.length === 2);
    t.session.sendToolResult("r1", { ok: true });
    await until(() => t.streams.length === 3);
    t.streams[2]?.push({ type: "text", delta: "Sua consulta foi agendada para quinta às nove." });
    t.streams[2]?.end();
    await until(() => t.spoken.length > 0);
    expect(t.spoken.map((piece) => piece.text).join("")).not.toContain("foi agendada");
  });

  describe("a retenção depois de uma falha não é permanente (achado 9 da revisão)", () => {
    const failedWrite = (id: string, args: object) => ({ type: "tool_call" as const, call: { id, type: "function" as const, function: { name: "agenda_marcar", arguments: JSON.stringify(args) } } });

    async function afterFailure(args: object) {
      const t = await setup();
      callerSays(t, "Sim, pode marcar.");
      t.timers.runAll();
      t.streams[0]?.push(failedWrite("w1", args));
      t.streams[0]?.end();
      await until(() => t.toolCalls.length === 1);
      t.session.sendToolResult("w1", { ok: false, message: "recusada" });
      await until(() => t.streams.length === 2);
      return t;
    }

    it("expira: na terceira resposta depois da falha, uma confirmação legítima é falada", async () => {
      const t = await afterFailure({ starts_at: "2026-11-20T14:00:00-03:00" });
      t.streams[1]?.push({ type: "text", delta: "Não consegui marcar. Posso anotar para a equipe?" });
      t.streams[1]?.end();
      await until(() => t.spoken.length > 0);
      callerSays(t, "Pode anotar, obrigada.");
      t.timers.runAll();
      await until(() => t.streams.length === 3);
      t.streams[2]?.push({ type: "text", delta: "Anotado." });
      t.streams[2]?.end();
      callerSays(t, "Está bem, e a consulta de sexta?");
      t.timers.runAll();
      await until(() => t.streams.length === 4);
      t.streams[3]?.push({ type: "text", delta: "Pronto, sua consulta está marcada para sexta às 14h." });
      t.streams[3]?.end();
      await until(() => t.spoken.map((piece) => piece.text).join("").includes("está marcada"));
      expect(t.spoken.map((piece) => piece.text).join("")).toContain("está marcada para sexta às 14h");
    });

    it("segura a confirmação do mesmo horário que falhou, mas não a de outro compromisso (fala sobre outro horário)", async () => {
      const igual = await afterFailure({ starts_at: "2026-11-20T14:00:00-03:00" });
      igual.streams[1]?.push({ type: "text", delta: "Pronto, está marcada para sexta às 14h." });
      igual.streams[1]?.end();
      await until(() => igual.spoken.length > 0);
      expect(igual.spoken.map((piece) => piece.text).join("")).toContain("Não consegui concluir isso na agenda agora");
      expect(igual.spoken.map((piece) => piece.text).join("")).not.toContain("está marcada");

      const outro = await afterFailure({ starts_at: "2026-11-20T14:00:00-03:00" });
      outro.streams[1]?.push({ type: "text", delta: "A sua consulta de sexta às 10h já está marcada." });
      outro.streams[1]?.end();
      await until(() => outro.spoken.length > 0);
      expect(outro.spoken.map((piece) => piece.text).join("")).toContain("às 10h já está marcada");
    });

    it("a falha de marcar não segura uma frase de cancelamento, e a de cancelar não segura 'está marcada'", async () => {
      const t = await afterFailure({ starts_at: "2026-11-20T14:00:00-03:00" });
      t.streams[1]?.push({ type: "text", delta: "A consulta antiga foi cancelada pelo sistema ontem." });
      t.streams[1]?.end();
      await until(() => t.spoken.length > 0);
      expect(t.spoken.map((piece) => piece.text).join("")).toContain("foi cancelada");
    });
  });

  it("depois de uma escrita que deu certo, a confirmação do modelo é falada normalmente", async () => {
    const t = await setup();
    callerSays(t, "Sim, pode marcar.");
    t.timers.runAll();
    t.streams[0]?.push(writeCall("w1"));
    t.streams[0]?.end();
    await until(() => t.toolCalls.length === 1);
    t.session.sendToolResult("w1", { ok: true, message: "Horário marcado." });
    await until(() => t.streams.length === 2);
    t.streams[1]?.push({ type: "text", delta: "Pronto, sua consulta está marcada para quinta às nove." });
    t.streams[1]?.end();
    await until(() => t.spoken.length > 0);
    expect(t.spoken.map((piece) => piece.text).join("")).toContain("está marcada");
  });
});

describe("eco e leitura", () => {
  it("isEchoOf: só palavras que o agente acabou de dizer", () => {
    expect(isEchoOf("Em que posso ajudar", "Bom dia, em que posso ajudar?")).toBe(true);
    expect(isEchoOf("espera um instante", "Bom dia, em que posso ajudar?")).toBe(false);
    expect(isEchoOf("", "qualquer coisa")).toBe(true);
  });
  it("speakable deixa texto comum como está", () => {
    expect(speakable("Claro, posso ajudar com isso.")).toBe("Claro, posso ajudar com isso.");
  });
});
