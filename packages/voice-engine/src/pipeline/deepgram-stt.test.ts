import { afterEach, describe, expect, it } from "vitest";
import { manualScheduler, startFakeWs, until } from "../testing/fake-pipeline";
import { deepgramUrl, openDeepgramStt, type SttHandlers } from "./deepgram-stt";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function recorder() {
  const log: string[] = [];
  const handlers: SttHandlers = {
    partial: (text) => log.push(`partial:${text}`),
    final: (text, speechFinal) => log.push(`final:${text}:${speechFinal}`),
    speechStarted: () => log.push("speech_started"),
    utteranceEnd: () => log.push("utterance_end"),
    failed: (error) => log.push(`failed:${error.message}`),
  };
  return { log, handlers };
}

async function setup(extra: { vocabulary?: string[] } = {}) {
  const server = await startFakeWs();
  stops.push(() => server.stop());
  const { log, handlers } = recorder();
  const stt = await openDeepgramStt({ apiKey: "dg-falsa", language: "pt-BR", url: server.url, ...extra }, handlers);
  stops.unshift(() => stt.close());
  return { server, log, stt };
}

const results = (transcript: string, isFinal: boolean, speechFinal = false) => ({
  type: "Results",
  is_final: isFinal,
  speech_final: speechFinal,
  channel: { alternatives: [{ transcript, confidence: 0.9 }] },
});

describe("Deepgram STT", () => {
  it("mantém STT aberta em silêncio e cancela keepalive ao fechar", async () => {
    const server = await startFakeWs();
    stops.push(() => server.stop());
    const timers = manualScheduler();
    const stt = await openDeepgramStt({ apiKey: "falsa", language: "pt-BR", url: server.url, timeout: { schedule: timers.schedule } }, recorder().handlers);
    timers.runAll();
    expect(await server.waitFor((m) => m.type === "KeepAlive")).toEqual({ type: "KeepAlive" });
    await stt.close();
    expect(timers.pending()).toEqual([]);
  });

  it("abre com Nova-3, pt-BR, PCM16 8 kHz e a chave no cabeçalho `Token`", async () => {
    const { server } = await setup({ vocabulary: ["Ozavo", "Dra. Ana"] });
    expect(server.request.headers.authorization).toBe("Token dg-falsa");
    const params = new URL(server.request.url, "http://x").searchParams;
    expect(params.get("model")).toBe("nova-3");
    expect(params.get("language")).toBe("pt-BR");
    expect(params.get("encoding")).toBe("linear16");
    expect(params.get("sample_rate")).toBe("8000");
    expect(params.get("interim_results")).toBe("true");
    expect(params.get("vad_events")).toBe("true");
    expect(params.getAll("keyterm")).toEqual(["Ozavo", "Dra. Ana"]);
  });

  it("áudio de quem ligou sai como está, em quadro binário, e o tempo é medido", async () => {
    const { server, stt } = await setup();
    const audio = Buffer.alloc(1600, 7);
    stt.sendAudio(audio);
    stt.sendAudio(audio);
    await until(() => server.binary().length === 3200);
    expect(server.binary().equals(Buffer.concat([audio, audio]))).toBe(true);
    expect(stt.drainSeconds()).toBeCloseTo(0.2);
    expect(stt.drainSeconds()).toBe(0);
  });

  it("traduz parcial, final, início de fala e fim de fala; ignora o que não é do protocolo", async () => {
    const { server, log } = await setup();
    server.send({ type: "Metadata", request_id: "r" });
    server.send({ type: "Results" });
    server.send({ type: "SpeechStarted", channel: [0], timestamp: 0.1 });
    server.send(results("quero mar", false));
    server.send(results("", false));
    server.send(results("quero marcar", true, false));
    server.send(results("para sexta.", true, true));
    server.send({ type: "UtteranceEnd", channel: [0], last_word_end: 2.1 });
    await until(() => log.includes("utterance_end"));
    expect(log).toEqual(["speech_started", "partial:quero mar", "final:quero marcar:false", "final:para sexta.:true", "utterance_end"]);
  });

  it("finalize pede ao provedor o final do que ouviu; fechar manda CloseStream", async () => {
    const { server, stt } = await setup();
    stt.finalize();
    expect(await server.waitFor((m) => m.type === "Finalize")).toEqual({ type: "Finalize" });
    const closing = stt.close();
    expect(await server.waitFor((m) => m.type === "CloseStream")).toEqual({ type: "CloseStream" });
    await closing;
  });

  it("queda vira `failed`", async () => {
    const { server, log } = await setup();
    server.drop();
    await until(() => log.some((line) => line.startsWith("failed:")));
  });

  it("ambiente barulhento espera mais pela pausa", () => {
    const quiet = new URL(deepgramUrl({ language: "pt-BR" })).searchParams.get("endpointing");
    const noisy = new URL(deepgramUrl({ language: "pt-BR", listeningEnvironment: "noisy" })).searchParams.get("endpointing");
    expect(Number(noisy)).toBeGreaterThan(Number(quiet));
  });
});
