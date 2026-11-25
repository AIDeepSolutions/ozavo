/**
 * Replay do fim de turno com os textos e os tempos de uma ligação real (a do dono ao Nico ADS, 25/11/2026, 23 turnos medidos), sem rede,
 * sem Deepgram, sem modelo e sem voz (nenhum crédito gasto): o motor de verdade (`createPipelineSession`) roda com um relógio virtual, e o
 * que a Deepgram mandaria é reconstruído por turno a partir do que a ligação registrou.
 *
 * Duas condições por turno (as duas aparecem na ligação):
 *   - `saudavel`: a pausa local vê o silêncio e pede o `Finalize`; o final chega ~300 ms depois do fim da fala com `speech_final`;
 *   - `cancelado`: o mesmo, mas a Deepgram manda `SpeechStarted` logo depois do final (com ruído de linha ela "vê fala" de novo depois do
 *     `Finalize`: reproduzido com a sonda `sondar-fim-de-turno.ts --noise 500`), o que cancelava o fim de turno e o pedido adiantado, e só o
 *     `UtteranceEnd` (~1 s depois da última palavra) fechava o turno, como nos turnos de ~1.250 ms da ligação.
 *   - `preso` (turnos que a ligação de validação fechou por `quiet`, com ~1.000 ms): o ruído de linha mantém a pausa local "falando", a Deepgram
 *     não manda `speech_final`, as palavras chegam só como parcial (~250 ms depois da voz) e o `Finalize` devolve o final ~300 ms depois de pedido.
 *     É o que a ligação de 25/11 22:22 UTC mostrou nos turnos "Eu gostaria de fazer", "Meu nome é" e "…no meu".
 *   - `cego` (`--cenario cego`, nos turnos que esperaram o UtteranceEnd): a pausa local não vê o fim (ruído mantém o detector "falando") e o
 *     provedor entrega o texto como final SEM `speech_final`; só o `UtteranceEnd` fecharia. É a rede de segurança por silêncio de palavras.
 *
 * Saída: `endpointMs` (do fim real da fala à decisão de que o turno acabou), taxa de acerto da especulação e percentis, por condição.
 * Uso: pnpm tsx scripts/bancada-latencia/replay-fim-de-turno.ts [--turnos <json>] [--json]
 */
import { readFileSync } from "node:fs";
import { createPipelineSession } from "../../packages/voice-engine/src/pipeline/session";
import type { SttHandlers } from "../../packages/voice-engine/src/pipeline/deepgram-stt";
import type { TtsHandlers } from "../../packages/voice-engine/src/pipeline/cartesia-tts";
import type { LlmEvent } from "../../packages/voice-engine/src/pipeline/openrouter-llm";
import { silence, speech } from "../../packages/voice-engine/src/testing/audio";
import type { TurnMetrics } from "../../packages/voice-engine/src/pipeline/session";
import { assessTurnEnd } from "../../packages/voice-engine/src/pipeline/endpointing";

/** Da decisão de que o turno acabou ao primeiro som do agente (ponte ou resposta adiantada): mediana medida nas duas ligações (101 ms). A projeção do percebido soma isto ao fim de turno do replay. */
const FIRST_SOUND_AFTER_DECISION_MS = 100;

interface RealTurn {
  turn: number;
  user: string;
  endpointMs: number;
  speculation: "hit" | "miss" | null;
  rttMs: number;
  modelMs?: number;
  /** O que fechou o turno na ligação real (ausente nas ligações anteriores à #45). */
  endBy?: string;
  call?: string;
  depois?: string;
}

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

/** Relógio e agendador virtuais: o tempo só anda quando o replay manda, e os prazos disparam na ordem. */
function virtualTime(start = 1_800_000_000_000) {
  let now = start;
  let seq = 0;
  const jobs: Array<{ at: number; seq: number; fn: () => void; cancelled: boolean }> = [];
  return {
    clock: { now: () => new Date(now) },
    schedule(fn: () => void, delayMs: number): () => void {
      const job = { at: now + delayMs, seq: seq++, fn, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
    get ms(): number {
      return now;
    },
    /** Avança `ms`, disparando os prazos que vencem no caminho. */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = jobs.filter((job) => !job.cancelled && job.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.cancelled = true;
        due.fn();
      }
      now = target;
    },
  };
}

type Mode = "saudavel" | "cancelado" | "cego" | "preso";

async function playTurn(real: RealTurn, mode: Mode): Promise<{ endpointMs?: number; speculation?: "hit" | "miss"; endBy?: string }> {
  const time = virtualTime();
  let stt: SttHandlers | undefined;
  let tts: TtsHandlers | undefined;
  let finalizeHook: () => void = () => undefined;
  const metrics: TurnMetrics[] = [];
  const session = await createPipelineSession({
    config: { instructions: "Você é o Nico.", language: "pt-BR", tools: [], latency: { bridge: false } },
    clock: time.clock,
    schedule: time.schedule,
    random: () => 0,
    amd: false,
    onMetrics: (m) => metrics.push(m),
    openStt: async (handlers) => {
      stt = handlers;
      return { sendAudio: () => undefined, finalize: () => finalizeHook(), drainSeconds: () => 0, close: async () => undefined };
    },
    openTts: async (handlers) => {
      tts = handlers;
      return { speak: () => undefined, cancel: () => undefined, drainCharacters: () => 0, close: async () => undefined };
    },
    // O modelo responde na hora: o que se mede aqui é o fim de turno.
    chat: async function* (): AsyncGenerator<LlmEvent> {
      yield { type: "text", delta: "Certo." };
    },
  });
  if (!stt || !tts) throw new Error("portas não abertas");
  const handlers = stt;
  const words = real.user.split(/\s+/);
  const spokenMs = Math.max(600, words.length * 320);
  // A fala: quadros de voz de 20 ms com os parciais crescendo, e depois o fim REAL da fala (t = 0).
  const frames = Math.round(spokenMs / 20);
  // Um bloco só de fala sintética: quadros iguais repetidos parecem ruído estável e o detector aprende o piso por cima da fala.
  const voice = speech(frames);
  for (let i = 0; i < frames; i++) {
    session.sendAudio(voice.subarray(i * 320, (i + 1) * 320));
    if (i % 12 === 0) handlers.partial(words.slice(0, Math.max(1, Math.round((words.length * i) / frames))).join(" "));
    time.advance(20);
  }
  if (mode !== "preso") handlers.partial(real.user);
  const endAt = time.ms;
  if (mode === "preso") {
    // O `Finalize` pedido (por quem for) devolve o final com speech_final ~300 ms depois.
    finalizeHook = () => void time.schedule(() => handlers.final(real.user, true), 300);
    // As palavras chegam como parcial ~250 ms depois do fim da voz, e o ruído mantém a pausa local presa em fala durante toda a espera.
    const noise = speech(100, 2500, 11);
    let sent = 0;
    const until = (ms: number): void => {
      while (time.ms < endAt + ms) {
        session.sendAudio(noise.subarray((sent % 100) * 320, ((sent % 100) + 1) * 320));
        sent++;
        time.advance(20);
      }
    };
    until(250);
    handlers.partial(real.user);
    until(2000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    tts.firstAudio?.("turn-1", 200);
    tts.audio("turn-1", Buffer.alloc(320));
    await session.close();
    const stuck = metrics[0];
    return { endpointMs: stuck?.endpointMs, speculation: stuck?.speculation, endBy: (stuck as { endBy?: string } | undefined)?.endBy };
  }
  if (mode === "cego") {
    time.advance(350);
    handlers.final(real.user, false);
    // O ruído mantém o detector local em "falando" durante toda a espera.
    const noise = speech(60, 2500, 11);
    for (let i = 0; i < 60; i++) {
      session.sendAudio(noise.subarray(i * 320, (i + 1) * 320));
      time.advance(20);
    }
    time.advance(Math.max(0, endAt + real.endpointMs - time.ms));
    handlers.utteranceEnd();
    time.advance(1500);
    await new Promise((resolve) => setTimeout(resolve, 5));
    tts.firstAudio?.("turn-1", 200);
    tts.audio("turn-1", Buffer.alloc(320));
    await session.close();
    const blind = metrics[0];
    return { endpointMs: blind?.endpointMs, speculation: blind?.speculation, endBy: (blind as { endBy?: string } | undefined)?.endBy };
  }
  // A pausa local de 100 ms; o `Finalize` devolve o texto com speech_final ~300 ms depois do fim da fala.
  for (let i = 0; i < 5; i++) {
    session.sendAudio(silence(1));
    time.advance(20);
  }
  time.advance(Math.max(0, endAt + 300 - time.ms));
  handlers.final(real.user, true);
  if (mode === "cancelado") {
    handlers.speechStarted();
    time.advance(Math.max(0, endAt + real.endpointMs - time.ms));
    handlers.utteranceEnd();
  }
  time.advance(1500);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // O primeiro áudio da resposta fecha a medida do turno.
  const turnId = `turn-1`;
  tts.firstAudio?.(turnId, 200);
  tts.audio(turnId, Buffer.alloc(320));
  await session.close();
  const measured = metrics[0];
  return { endpointMs: measured?.endpointMs, speculation: measured?.speculation, endBy: (measured as { endBy?: string } | undefined)?.endBy };
}

const pct = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

async function main(): Promise<void> {
  const turns = JSON.parse(readFileSync(arg("turnos") ?? new URL("./ligacoes-25nov-fala.json", import.meta.url), "utf8")) as RealTurn[];
  const rows: Array<{ turn: number; text: string; real: number; realSpec: string | null; mode: Mode; endpointMs?: number; speculation?: string; endBy?: string; kind: string; rtt: number; rttReal: number; depois?: string }> = [];
  for (const real of turns) {
    // O que a ligação mostrou: ~1.250 ms (só o UtteranceEnd fechou) ou um pedido adiantado descartado é o fim de turno cancelado.
    const cancelledInCall = real.speculation === "miss" || (real.endpointMs >= 1189 && real.endpointMs <= 1300);
    const blindScenario = arg("cenario") === "cego";
    const stuckInCall = real.endBy === "quiet" && real.endpointMs >= 900;
    const mode: Mode = stuckInCall ? "preso" : cancelledInCall ? (blindScenario ? "cego" : "cancelado") : "saudavel";
    const out = await playTurn(real, mode);
    rows.push({ turn: real.turn, text: real.user.slice(0, 38), real: real.endpointMs, realSpec: real.speculation, mode, endpointMs: out.endpointMs, speculation: out.speculation, endBy: out.endBy, kind: assessTurnEnd(real.user).kind, rtt: Math.round((out.endpointMs ?? 0) + FIRST_SOUND_AFTER_DECISION_MS), rttReal: real.rttMs, depois: real.depois });
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return;
  }
  process.stdout.write("turno  condição   classe      ligação(ms)  replay(ms)  percebido(ms) real→replay  esp.   fechou por   depois      texto\n");
  for (const row of rows) {
    process.stdout.write(`${String(row.turn).padStart(5)}  ${row.mode.padEnd(9)}  ${row.kind.padEnd(10)}  ${String(row.real).padStart(10)}  ${String(Math.round(row.endpointMs ?? -1)).padStart(9)}  ${String(row.rttReal).padStart(6)} → ${String(row.rtt).padEnd(6)}  ${(row.speculation ?? "-").padEnd(5)}  ${(row.endBy ?? "-").padEnd(11)}  ${(row.depois ?? "-").slice(0, 10).padEnd(10)}  ${row.text}\n`);
  }
  const replay = rows.map((row) => row.endpointMs ?? 0);
  const real = rows.map((row) => row.real);
  const hits = rows.filter((row) => row.speculation === "hit").length;
  const misses = rows.filter((row) => row.speculation === "miss").length;
  process.stdout.write(`\nfim de turno (ms)  ligação real: p50 ${pct(real, 0.5)} p90 ${pct(real, 0.9)}  |  replay: p50 ${pct(replay, 0.5)} p90 ${pct(replay, 0.9)}\n`);
  const rttReal = rows.map((row) => row.rttReal);
  const rttNew = rows.map((row) => row.rtt);
  const under = (values: number[]): string => `${values.filter((v) => v < 1000).length}/${values.length}`;
  process.stdout.write(`percebido projetado (ms): real p50 ${pct(rttReal, 0.5)} p90 ${pct(rttReal, 0.9)} (<1 s: ${under(rttReal)})  |  replay p50 ${pct(rttNew, 0.5)} p90 ${pct(rttNew, 0.9)} (<1 s: ${under(rttNew)})\n`);
  process.stdout.write(`especulação no replay: ${hits} aproveitadas, ${misses} descartadas, ${rows.length - hits - misses} sem pedido adiantado (de ${rows.length} turnos)\n`);
}

void main();
