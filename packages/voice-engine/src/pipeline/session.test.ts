import { describe, expect, it } from "vitest";
import engine from "../engines/deepgram-openrouter-cartesia";
import { estimateCostMicrocents } from "../pricing";
import { BRIDGE_TEXTS, BridgeStore, pickBridge } from "./bridge";
import { silence, speech } from "../testing/audio";
import { manualClock, manualScheduler, until } from "../testing/fake-pipeline";
import type { AnsweringMachineDetection, ToolSpec, Usage, VoiceSessionConfig } from "../types";
import type { TtsHandlers } from "./cartesia-tts";
import type { SttHandlers } from "./deepgram-stt";
import { ENDPOINT_CLOSED_MS } from "./endpointing";
import type { ChatMessage, LlmEvent } from "./openrouter-llm";
import { createPipelineSession, isEchoOf, speakable, splitPoint, type PipelineSessionDeps, type TurnMetrics } from "./session";

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

async function setup(config: Partial<VoiceSessionConfig> = {}, options: { amd?: false; warm?: PipelineSessionDeps["warm"]; bridgeStore?: BridgeStore } = {}) {
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
    config: { instructions: "Você é a recepcionista da Clínica Exemplo.", language: "pt-BR", tools: TOOLS, ...config, latency: { bridge: false, ...config.latency } },
    bridgeStore: options.bridgeStore ?? new BridgeStore(),
    random: () => 0,
    clock: time.clock,
    schedule: timers.schedule,
    onMetrics: (m) => metrics.push(m),
    amd: options.amd,
    warm: options.warm,
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
      {
        turn: 1,
        endpointDelayMs: ENDPOINT_CLOSED_MS,
        llmFirstTokenMs: ENDPOINT_CLOSED_MS + LLM_FIRST_TOKEN_MS,
        ttfbMs: TTS_TTFB_MS,
        rttMs: ENDPOINT_CLOSED_MS + LLM_FIRST_TOKEN_MS + TTS_TTFB_MS,
        answerMs: ENDPOINT_CLOSED_MS + LLM_FIRST_TOKEN_MS + TTS_TTFB_MS,
        endpointMs: ENDPOINT_CLOSED_MS,
        modelMs: LLM_FIRST_TOKEN_MS,
        firstSentenceMs: 0,
      },
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

describe("aquecimento da chamada e medida a partir do fim real da fala", () => {
  const warmStream = (): NonNullable<PipelineSessionDeps["warm"]> =>
    async function* () {
      yield { type: "text", delta: "Olá" };
      yield { type: "usage", usage: { promptTokens: 7200, cachedTokens: 0, completionTokens: 2, costCents: 0.2, model: "deepseek/deepseek-v4.1-flash", provider: "Together" } };
    };

  it("esquenta o modelo com o prefixo da conversa ao abrir, e o custo entra na conta", async () => {
    const calls: Array<{ messages: readonly ChatMessage[]; tools: readonly ToolSpec[] }> = [];
    const t = await setup({ greeting: "Bom dia." }, {
      warm: (messages, tools, signal) => {
        calls.push({ messages: [...messages], tools });
        return warmStream()(messages, tools, signal);
      },
    });
    const llmCalls: unknown[] = [];
    t.session.on("llmCall", (call) => llmCalls.push(call));
    await until(() => t.usages.some((usage) => usage.providerCostCents === 0.2));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages[0]).toMatchObject({ role: "system" });
    expect(calls[0]?.messages.at(-1)).toEqual({ role: "user", content: "Oi." });
    expect(calls[0]?.tools).toEqual(TOOLS);
    // O aquecimento usa o prefixo da conversa: a mensagem de sistema é a mesma que o primeiro turno vai mandar.
    callerSays(t, "Qual o horário?");
    t.timers.runAll();
    expect(t.streams[0]?.messages[0]).toEqual(calls[0]?.messages[0]);
  });

  it("registra o aquecimento na linha do tempo como chamada de aquecimento, sem texto", async () => {
    const time = manualClock();
    const llmCalls: Array<Record<string, unknown>> = [];
    const session = await createPipelineSession({
      config: { instructions: "Atenda.", language: "pt-BR", tools: [] },
      clock: time.clock,
      warm: warmStream(),
      openStt: async () => ({ sendAudio: () => undefined, finalize: () => undefined, drainSeconds: () => 0, close: async () => undefined }),
      openTts: async () => ({ speak: () => undefined, cancel: () => undefined, drainCharacters: () => 0, close: async () => undefined }),
      chat: async function* () { yield* []; },
    });
    session.on("llmCall", (call) => llmCalls.push({ ...call }));
    await session.close();
    // Quem registra se inscreve depois da criação: o aquecimento já pode ter terminado. O que importa é nunca levar texto da conversa.
    for (const call of llmCalls) expect(JSON.stringify(call)).not.toContain("Oi.");
  });

  it("aquecimento que falha não derruba a ligação e aparece como chamada sem tokens", async () => {
    const llmCalls: Array<Record<string, unknown>> = [];
    const time = manualClock();
    const events: string[] = [];
    const session = await createPipelineSession({
      config: { instructions: "Atenda.", language: "pt-BR", tools: [] },
      clock: time.clock,
      warm: async function* () {
        yield* [];
        throw new Error("fora do ar");
      },
      openStt: async () => ({ sendAudio: () => undefined, finalize: () => undefined, drainSeconds: () => 0, close: async () => undefined }),
      openTts: async () => ({ speak: () => undefined, cancel: () => undefined, drainCharacters: () => 0, close: async () => undefined }),
      chat: async function* () { yield* []; },
    });
    session.on("llmCall", (call) => llmCalls.push({ ...call }));
    session.on("error", (error) => events.push(error.message));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
    await session.close();
  });

  it("com o aquecimento desligado (latency.warmup=false) ou sem porta de aquecimento, não aquece", async () => {
    let calls = 0;
    await setup({ latency: { warmup: false } }, { warm: warmStream() });
    await setup({}, { warm: () => { calls++; return warmStream()([], [], new AbortController().signal); } });
    expect(calls).toBe(1);
    let off = 0;
    await setup({ latency: { warmup: false } }, { warm: () => { off++; return warmStream()([], [], new AbortController().signal); } });
    expect(off).toBe(0);
  });

  it("a latência conta do FIM REAL da fala (a pausa vista no áudio), não da chegada do último texto", async () => {
    const t = await setup();
    t.session.sendAudio(speech(30));
    t.time.advance(100);
    t.session.sendAudio(silence(8));
    const pausedAt = t.time.ms;
    const speechEnd = pausedAt - 100;
    // O texto final só chega 450 ms depois do fim da fala.
    t.time.advance(350);
    callerSays(t, "Qual o horário de vocês?");
    t.timers.runAll();
    t.time.advance(180);
    t.streams[0]?.push({ type: "text", delta: "Atendemos das oito às dezoito." });
    await until(() => t.spoken.length === 1);
    t.time.advance(60);
    t.ports.tts.firstAudio("turn-1", 60);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    const measured = t.metrics[0];
    expect(measured?.rttMs).toBe(t.time.ms - speechEnd);
    expect(measured?.endpointMs).toBeGreaterThanOrEqual(350 + 100);
    expect(measured?.modelMs).toBe(180);
  });
});

describe("fim de turno pela pausa e pedido adiantado ao modelo (ADR 0023)", () => {
  /** A pessoa fala e para: o detector local vê a pausa de 100 ms depois do último quadro com voz. */
  function pause(t: Awaited<ReturnType<typeof setup>>, speechFrames = 30): void {
    t.session.sendAudio(speech(speechFrames));
    t.session.sendAudio(silence(6));
  }

  it("ao ver a pausa pede ao provedor o texto do que foi dito (Finalize), sem esperar o speech_final dele", async () => {
    const t = await setup();
    pause(t);
    expect(t.finalizes()).toBe(1);
  });

  it("frase fechada: o final que chega durante a pausa fecha o turno na hora, e a latência conta do fim real da fala", async () => {
    const t = await setup();
    pause(t);
    t.time.advance(260);
    t.ports.stt.final("Quanto custa um projeto?", false);
    expect(t.streams).toHaveLength(1);
    expect(t.timers.pending()).toEqual([]);
    expect(t.metrics).toEqual([]);
    t.streams[0]?.push({ type: "text", delta: "Depende do escopo." });
    await until(() => t.spoken.length === 1);
    t.time.advance(100);
    t.ports.tts.firstAudio("turn-1", 100);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    expect(t.metrics[0]?.endpointMs).toBeLessThan(400);
    expect(t.transcripts.at(-1)).toEqual({ speaker: "user", text: "Quanto custa um projeto?" });
  });

  it("regressão da chamada do dono: 'E quais são suas' / 'empreitadas aí nessa empresa?' é UM turno, não dois", async () => {
    const t = await setup();
    pause(t, 20);
    t.time.advance(260);
    // A Deepgram até pontua o pedaço: a palavra que sobra no fim (possessivo) o mantém aberto.
    t.ports.stt.final("E quais são suas?", false);
    expect(t.streams).toHaveLength(0);
    expect(t.timers.pending().length).toBe(1);
    expect(t.timers.pending()[0]).toBeGreaterThan(500);
    // A pessoa continua: o prazo do fim de turno cai.
    t.time.advance(250);
    t.session.sendAudio(speech(20));
    t.ports.stt.partial("empreitadas aí");
    t.timers.runAll();
    expect(t.streams).toHaveLength(0);
    t.session.sendAudio(silence(6));
    t.time.advance(260);
    t.ports.stt.final("empreitadas aí nessa empresa?", false);
    expect(t.streams).toHaveLength(1);
    expect(t.transcripts.filter((turn) => turn.speaker === "user")).toEqual([{ speaker: "user", text: "E quais são suas? empreitadas aí nessa empresa?" }]);
    expect(t.streams[0]?.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["E quais são suas? empreitadas aí nessa empresa?"]);
  });

  it("um parcial que só repete o que já veio como final (chega depois do Finalize) não cancela o fim de turno", async () => {
    const t = await setup();
    pause(t);
    t.time.advance(260);
    t.ports.stt.final("sexta de manhã", false);
    expect(t.timers.pending().length).toBe(1);
    t.ports.stt.partial("sexta de manhã");
    expect(t.timers.pending().length).toBe(1);
    t.timers.runAll();
    expect(t.streams).toHaveLength(1);
  });

  it("sem fim de turno por pausa (fastEndpoint=false), o turno só fecha no speech_final, como antes, e não manda Finalize", async () => {
    const t = await setup({ latency: { fastEndpoint: false } });
    pause(t);
    expect(t.finalizes()).toBe(0);
    t.ports.stt.final("Quanto custa um projeto?", false);
    expect(t.streams).toHaveLength(0);
    t.ports.stt.final("", true);
    t.timers.runAll();
    expect(t.streams).toHaveLength(1);
  });

  it("frase provavelmente fechada, mas ainda no prazo de segurança: o pedido ao modelo sai já, e a resposta é aproveitada se o texto não muda", async () => {
    const t = await setup();
    pause(t);
    t.time.advance(260);
    t.ports.stt.final("sexta de manhã", false);
    // Antes de o turno fechar, o modelo já recebeu o pedido (sem nada ter ido à síntese).
    expect(t.streams).toHaveLength(1);
    expect(t.streams[0]?.messages.at(-1)).toEqual({ role: "user", content: "sexta de manhã" });
    t.streams[0]?.push({ type: "text", delta: "Pode ser sexta às nove." });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.spoken).toEqual([]);
    t.time.advance(150);
    t.timers.runAll();
    await until(() => t.spoken.length === 1);
    expect(t.streams).toHaveLength(1);
    expect(t.spoken[0]?.text).toBe("Pode ser sexta às nove.");
    t.time.advance(80);
    t.ports.tts.firstAudio("turn-1", 80);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    expect(t.metrics[0]).toMatchObject({ speculation: "hit", modelMs: 0 });
  });

  it("a pessoa continua depois do pedido adiantado: o pedido é descartado (e contado como gasto), e o turno refaz com o texto inteiro", async () => {
    const t = await setup();
    const llmCalls: Array<Record<string, unknown>> = [];
    t.session.on("llmCall", (call) => llmCalls.push({ ...call }));
    pause(t);
    t.time.advance(260);
    t.ports.stt.final("sexta de manhã", false);
    expect(t.streams).toHaveLength(1);
    t.time.advance(120);
    t.session.sendAudio(speech(20));
    expect(t.streams[0]?.signal.aborted).toBe(true);
    expect(llmCalls).toEqual([expect.objectContaining({ purpose: "speculative" })]);
    pause(t, 10);
    t.time.advance(260);
    t.ports.stt.final("às nove horas.", false);
    expect(t.streams).toHaveLength(2);
    expect(t.streams[1]?.messages.at(-1)).toEqual({ role: "user", content: "sexta de manhã às nove horas." });
    t.streams[1]?.push({ type: "text", delta: "Combinado, sexta às nove." });
    await until(() => t.spoken.length === 1);
    t.time.advance(80);
    t.ports.tts.firstAudio("turn-1", 80);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    expect(t.metrics[0]).toMatchObject({ speculation: "miss" });
  });

  it("frase aberta não gasta pedido adiantado, e com a especulação desligada nenhum sai", async () => {
    const open = await setup();
    pause(open);
    open.time.advance(260);
    open.ports.stt.final("Quero marcar para", false);
    expect(open.streams).toHaveLength(0);
    const off = await setup({ latency: { speculation: false } });
    pause(off);
    off.time.advance(260);
    off.ports.stt.final("sexta de manhã", false);
    expect(off.streams).toHaveLength(0);
    off.timers.runAll();
    expect(off.streams).toHaveLength(1);
  });
});

describe("frase de ponte (ADR 0023)", () => {
  const VOICE = "voz-de-teste-1";
  const SHORT = 3200; // 200 ms
  const LONG = 9600; // 600 ms
  const fullStore = (): BridgeStore => {
    const store = new BridgeStore();
    const key = BridgeStore.keyOf(VOICE, "pt");
    for (const text of BRIDGE_TEXTS.pt?.short ?? []) store.put(key, { text, tier: "short", pcm: Buffer.alloc(SHORT, 1) });
    for (const text of BRIDGE_TEXTS.pt?.long ?? []) store.put(key, { text, tier: "long", pcm: Buffer.alloc(LONG, 2) });
    return store;
  };
  /** O turno de quem ligou fecha (a pessoa falou e o prazo passou) e o pedido ao modelo sai. */
  const commit = (t: Awaited<ReturnType<typeof setup>>, text = "Qual o horário de vocês?"): void => {
    callerSays(t, text);
    t.timers.runAll();
  };
  const bridgeAudio = (t: Awaited<ReturnType<typeof setup>>): Buffer[] => t.audio.filter((chunk) => chunk.length === SHORT || chunk.length === LONG);

  it("sem frase pronta, sintetiza uma de cada vez com a voz do agente, só depois da saudação", async () => {
    const store = new BridgeStore();
    const t = await setup({ voiceId: VOICE, greeting: "Bom dia.", latency: { bridge: true } }, { bridgeStore: store });
    expect(t.spoken.map((piece) => piece.contextId)).toEqual(["say-1"]);
    t.ports.tts.done("say-1");
    expect(t.spoken.at(-1)).toEqual(expect.objectContaining({ contextId: "bridge-1", text: "Certo.", final: true }));
    // Só uma por vez: a próxima só sai quando a anterior termina.
    expect(t.spoken.filter((piece) => piece.contextId.startsWith("bridge"))).toHaveLength(1);
    t.ports.tts.audio("bridge-1", Buffer.alloc(SHORT));
    expect(t.audio).toEqual([]);
    t.ports.tts.done("bridge-1");
    expect(store.get(BridgeStore.keyOf(VOICE, "pt")).map((phrase) => phrase.text)).toEqual(["Certo."]);
    expect(t.spoken.at(-1)?.contextId).toBe("bridge-2");
  });

  it("o áudio guardado perde o silêncio das pontas (a ponte curta não atrasa a resposta atrás dela)", async () => {
    const store = new BridgeStore();
    const t = await setup({ voiceId: VOICE, latency: { bridge: true } }, { bridgeStore: store });
    const voiced = speech(10);
    t.ports.tts.audio("bridge-1", Buffer.concat([silence(8), voiced, silence(6)]));
    t.ports.tts.done("bridge-1");
    const saved = store.get(BridgeStore.keyOf(VOICE, "pt"))[0];
    // 8 quadros de silêncio antes e 6 depois viram 1 de folga de cada lado.
    expect(saved?.pcm.length).toBe((10 + 2) * 320);
  });

  it("o modelo demora para o primeiro texto: toca uma frase curta; quando o texto chega, a resposta vem em seguida, sem cortar a frase", async () => {
    const t = await setup({ voiceId: VOICE, latency: { bridge: true } }, { bridgeStore: fullStore() });
    commit(t);
    expect(bridgeAudio(t)).toHaveLength(0);
    t.time.advance(150);
    t.timers.runAll();
    expect(bridgeAudio(t)).toEqual([Buffer.alloc(SHORT, 1)]);
    t.time.advance(120);
    t.streams[0]?.push({ type: "text", delta: "Atendemos das oito às dezoito." });
    await until(() => t.spoken.some((piece) => piece.contextId === "turn-1"));
    // O texto chegou: a faixa longa não toca mais.
    t.time.advance(1000);
    t.timers.runAll();
    expect(bridgeAudio(t)).toHaveLength(1);
    t.time.advance(100);
    t.ports.tts.firstAudio("turn-1", 100);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    expect(t.metrics[0]).toMatchObject({ bridge: true });
    expect(t.metrics[0]?.rttMs).toBeLessThan(t.metrics[0]?.answerMs ?? 0);
    expect(t.transcripts.filter((turn) => turn.speaker === "agent")).toEqual([]);
  });

  it("o texto chega antes do prazo da ponte: nenhuma frase toca", async () => {
    const t = await setup({ voiceId: VOICE, latency: { bridge: true } }, { bridgeStore: fullStore() });
    commit(t);
    t.time.advance(60);
    t.streams[0]?.push({ type: "text", delta: "Atendemos das oito às dezoito." });
    await until(() => t.spoken.some((piece) => piece.contextId === "turn-1"));
    t.time.advance(500);
    t.timers.runAll();
    expect(bridgeAudio(t)).toEqual([]);
    t.ports.tts.audio("turn-1", Buffer.alloc(320));
    expect(t.metrics[0]?.bridge).toBeUndefined();
  });

  it("se a curta acabou e o texto ainda não veio, toca uma mais longa (diferente), e para por aí", async () => {
    const t = await setup({ voiceId: VOICE, latency: { bridge: true } }, { bridgeStore: fullStore() });
    commit(t);
    t.time.advance(150);
    t.timers.runAll();
    t.time.advance(500);
    t.timers.runAll();
    expect(bridgeAudio(t).map((chunk) => chunk.length)).toEqual([SHORT, LONG]);
    t.time.advance(2000);
    t.timers.runAll();
    expect(bridgeAudio(t)).toHaveLength(2);
  });

  it("não repete a mesma frase em turnos seguidos (nem a que tocou no turno anterior)", () => {
    const phrases = [...fullStore().get(BridgeStore.keyOf(VOICE, "pt"))];
    const recent: string[] = [];
    const played: string[] = [];
    for (let i = 0; i < 12; i++) {
      const phrase = pickBridge(phrases, "short", recent, () => 0);
      if (!phrase) throw new Error("sem frase");
      played.push(phrase.text);
      recent.push(phrase.text);
      if (recent.length > 2) recent.shift();
    }
    for (let i = 1; i < played.length; i++) expect(played[i]).not.toBe(played[i - 1]);
    expect(new Set(played).size).toBeGreaterThan(2);
    // Com uma frase só na faixa, ela repete (melhor que ficar calado), mas só quando é a única.
    expect(pickBridge(phrases.slice(0, 1), "short", ["Certo."], () => 0)).toBeUndefined();
  });

  it("nunca antes de ferramenta sensível: depois de uma pergunta de confirmação, o 'sim' não ganha ponte", async () => {
    const t = await setup({ voiceId: VOICE, latency: { bridge: true } }, { bridgeStore: fullStore() });
    t.session.say("Posso marcar para sexta às dez?");
    t.ports.tts.done("say-1");
    commit(t, "Sim, pode.");
    t.time.advance(500);
    t.timers.runAll();
    expect(bridgeAudio(t)).toEqual([]);
  });

  it("desligada na tela do agente (latency.bridge=false), nada é sintetizado nem tocado", async () => {
    const t = await setup({ voiceId: VOICE, greeting: "Bom dia.", latency: { bridge: false } }, { bridgeStore: new BridgeStore() });
    t.ports.tts.done("say-1");
    expect(t.spoken.map((piece) => piece.contextId)).toEqual(["say-1"]);
    commit(t);
    t.time.advance(500);
    t.timers.runAll();
    expect(bridgeAudio(t)).toEqual([]);
  });

  it("o turno acaba antes do prazo (a pessoa interrompeu, ou o agente teve de falar outra coisa): a ponte dele não toca", async () => {
    const t = await setup({ voiceId: VOICE, latency: { bridge: true } }, { bridgeStore: fullStore() });
    commit(t);
    t.session.say("Preciso encerrar.");
    t.time.advance(500);
    t.timers.runAll();
    expect(bridgeAudio(t)).toEqual([]);
  });
});
