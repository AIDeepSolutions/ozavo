import { afterEach, describe, expect, it } from "vitest";
import { pcm16ToUlaw } from "../resample";
import { manualClock, startFakeWs, until } from "../testing/fake-pipeline";
import { CARTESIA_MODEL, cartesiaLanguage, openCartesiaTts, type TtsHandlers } from "./cartesia-tts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function recorder() {
  const log = { audio: [] as Buffer[], done: [] as string[], ttfb: [] as number[], errors: [] as string[], failed: [] as string[] };
  const handlers: TtsHandlers = {
    audio: (_id, pcm) => log.audio.push(pcm),
    done: (id) => log.done.push(id),
    firstAudio: (_id, ms) => log.ttfb.push(ms),
    error: (error) => log.errors.push(error.message),
    failed: (error) => log.failed.push(error.message),
  };
  return { log, handlers };
}

async function setup() {
  const server = await startFakeWs();
  stops.push(() => server.stop());
  const time = manualClock();
  const { log, handlers } = recorder();
  const tts = await openCartesiaTts({ apiKey: "sk_car_falsa", voiceId: "voz-do-tenant-1", language: "pt-BR", clock: time.clock, url: server.url }, handlers);
  stops.unshift(() => tts.close());
  return { server, time, log, tts };
}

describe("Cartesia TTS", () => {
  it("abre com a chave no cabeçalho e a versão na URL", async () => {
    const { server } = await setup();
    expect(server.request.headers["x-api-key"]).toBe("sk_car_falsa");
    expect(server.request.url).toContain("cartesia_version=");
  });

  it("pede μ-law 8 kHz nativo, com a voz do tenant, em pt", async () => {
    const { server, tts } = await setup();
    tts.speak("turn-1", "Olá.", false);
    const message = await server.waitFor((m) => m.context_id === "turn-1");
    expect(message).toMatchObject({
      model_id: CARTESIA_MODEL,
      transcript: "Olá.",
      voice: "voz-do-tenant-1",
      language: "pt",
      continue: true,
      output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 },
    });
    tts.speak("turn-1", "", true);
    expect(await server.waitFor((m) => m.context_id === "turn-1")).toMatchObject({ transcript: "", continue: false });
  });

  it("μ-law do provedor vira PCM16 8 kHz na borda, e o TTFB sai do relógio", async () => {
    const { server, time, tts, log } = await setup();
    tts.speak("turn-1", "Olá.", true);
    await server.waitFor((m) => m.context_id === "turn-1");
    time.advance(42);
    const pcm = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
    server.send({ type: "chunk", data: pcm16ToUlaw(pcm).toString("base64"), context_id: "turn-1", done: false });
    server.send({ type: "done", context_id: "turn-1", done: true });
    await until(() => log.done.length === 1);
    expect(log.audio[0]?.length).toBe(320);
    expect(log.ttfb).toEqual([42]);
    expect(log.done).toEqual(["turn-1"]);
  });

  it("cancelar descarta o que ainda chegar do contexto e avisa o provedor", async () => {
    const { server, tts, log } = await setup();
    tts.speak("turn-2", "Uma frase longa.", true);
    await server.waitFor((m) => m.context_id === "turn-2" && "transcript" in m);
    tts.cancel("turn-2");
    expect(await server.waitFor((m) => m.cancel === true)).toEqual({ context_id: "turn-2", cancel: true });
    server.send({ type: "chunk", data: Buffer.alloc(80, 0xff).toString("base64"), context_id: "turn-2" });
    server.send({ type: "done", context_id: "turn-2" });
    tts.speak("turn-3", "Outra.", true);
    await server.waitFor((m) => m.context_id === "turn-3");
    server.send({ type: "done", context_id: "turn-3" });
    await until(() => log.done.includes("turn-3"));
    expect(log.audio).toEqual([]);
    expect(log.done).toEqual(["turn-3"]);
  });

  it("erro do provedor num contexto não derruba a conexão; mensagem fora do formato é ignorada", async () => {
    const { server, log, tts } = await setup();
    server.send({ type: "error", title: "limite", message: "concurrency limit", context_id: "turn-9" });
    server.send({ type: "chunk" });
    server.send("não é json");
    tts.speak("turn-4", "Oi.", true);
    await server.waitFor((m) => m.context_id === "turn-4");
    server.send({ type: "done", context_id: "turn-4" });
    await until(() => log.done.length === 1);
    expect(log.errors).toEqual(["Cartesia: o provedor recusou a síntese"]);
    expect(log.failed).toEqual([]);
  });

  it("conta os caracteres enviados (o que a Cartesia cobra)", async () => {
    const { tts } = await setup();
    tts.speak("turn-1", "Olá, ", false);
    tts.speak("turn-1", "tudo bem?", true);
    expect(tts.drainCharacters()).toBe(14);
    expect(tts.drainCharacters()).toBe(0);
  });

  it("queda da conexão vira `failed`", async () => {
    const { server, log } = await setup();
    server.drop();
    await until(() => log.failed.length === 1);
    expect(log.failed[0]).toMatch(/Cartesia/);
  });

  it("conexão recusada rejeita a abertura", async () => {
    const server = await startFakeWs();
    const url = server.url;
    await server.stop();
    const { handlers } = recorder();
    await expect(openCartesiaTts({ apiKey: "x", voiceId: "v", language: "pt-BR", clock: manualClock().clock, url }, handlers)).rejects.toThrow(/Cartesia/);
  });

  it("idioma BCP 47 vira o código curto", () => {
    expect(cartesiaLanguage("pt-BR")).toBe("pt");
    expect(cartesiaLanguage("es")).toBe("es");
  });
});
