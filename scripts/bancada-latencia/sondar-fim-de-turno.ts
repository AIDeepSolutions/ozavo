/**
 * Sonda do fim de turno com a Deepgram real: reproduz o que a sessão faz (pausa local de 100 ms + `Finalize`) sobre áudio de
 * quem liga já gravado (`--cache`, os `.pcm` PCM16 8 kHz de `run.ts`) e registra, para cada fala, TUDO o que a Deepgram manda depois do
 * fim real da fala: parciais, finais, `speech_final`, `SpeechStarted` e `UtteranceEnd`, com o tempo desde o fim real.
 * Serve para ver que sinais chegam logo depois do `Finalize` (o `SpeechStarted` que cancelava o fim de turno) e quando o
 * `UtteranceEnd` fecharia sozinho. Custa só a transcrição (US$ 0,0077/min); não usa voz nem modelo.
 * Uso: DEEPGRAM_API_KEY=… pnpm tsx scripts/bancada-latencia/sondar-fim-de-turno.ts --cache <pasta> [--n 8] [--noise <dB>]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { openDeepgramStt } from "../../packages/voice-engine/src/pipeline/deepgram-stt";
import { EnergyVad, FRAME_BYTES } from "../../packages/voice-engine/src/pipeline/vad";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Ruído branco de baixa energia (a linha nunca é silêncio digital): amplitude de pico em PCM16. */
function noiseFrame(amplitude: number): Buffer {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 2; i++) frame.writeInt16LE(Math.round((Math.random() * 2 - 1) * amplitude), i * 2);
  return frame;
}

async function main(): Promise<void> {
  const dir = arg("cache");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!dir || !key) throw new Error("Use --cache <pasta> e DEEPGRAM_API_KEY");
  const noise = Number(arg("noise") ?? "0");
  const files = readdirSync(dir).filter((f) => f.endsWith(".pcm")).slice(0, Number(arg("n") ?? "8"));
  for (const file of files) {
    const pcm = readFileSync(path.join(dir, file));
    const t0 = performance.now();
    const events: Array<{ at: number; label: string }> = [];
    const stt = await openDeepgramStt(
      { apiKey: key, language: "pt-BR" },
      {
        partial: (text) => events.push({ at: performance.now() - t0, label: `partial "${text.slice(-24)}"` }),
        final: (text, speechFinal) => events.push({ at: performance.now() - t0, label: `final${speechFinal ? "+speech_final" : ""} "${text.slice(-24)}"` }),
        speechStarted: () => events.push({ at: performance.now() - t0, label: "SpeechStarted" }),
        utteranceEnd: () => events.push({ at: performance.now() - t0, label: "UtteranceEnd" }),
        failed: (error) => process.stderr.write(`${error.message}\n`),
      },
    );
    const vad = new EnergyVad({ stopFrames: 5 });
    const frames = Math.ceil(pcm.length / FRAME_BYTES);
    let next = performance.now();
    let lastVoiceAt = 0;
    let pauseAt: number | undefined;
    for (let i = 0; i < frames + 100; i++) {
      next += 20;
      let frame: Buffer = Buffer.alloc(FRAME_BYTES);
      if (i < frames) pcm.copy(frame, 0, i * FRAME_BYTES, Math.min(pcm.length, (i + 1) * FRAME_BYTES));
      else if (noise > 0) frame = noiseFrame(noise);
      stt.sendAudio(frame);
      if (i < frames) lastVoiceAt = performance.now() - t0;
      for (const event of vad.push(frame)) {
        if (event.type === "speech_end" && i >= frames - 5) {
          pauseAt = performance.now() - t0;
          events.push({ at: pauseAt, label: "FINALIZE (pausa local)" });
          stt.finalize();
        }
      }
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    }
    await stt.close();
    const end = lastVoiceAt;
    process.stdout.write(`\n${file} (${frames * 20} ms)\n`);
    for (const e of events.filter((x) => x.at >= end - 50)) process.stdout.write(`  ${String(Math.round(e.at - end)).padStart(6)} ms  ${e.label}\n`);
  }
}
void main();
