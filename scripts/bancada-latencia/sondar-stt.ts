/**
 * Sonda do STT: quando cada parcial, final e `speech_final` da Deepgram chega, contado a partir do FIM REAL da fala
 * (o último quadro com voz enviado). Serve para escolher os prazos da especulação e do fim de turno dinâmico.
 * Uso: DEEPGRAM_API_KEY=… pnpm tsx scripts/bancada-latencia/sondar-stt.ts --cache <pasta do áudio de run.ts>
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { openDeepgramStt } from "../../packages/voice-engine/src/pipeline/deepgram-stt";

const FRAME_BYTES = 320;
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dir = arg("cache");
  const key = process.env.DEEPGRAM_API_KEY;
  if (!dir || !key) throw new Error("Use --cache <pasta> e DEEPGRAM_API_KEY");
  const files = readdirSync(dir).filter((f) => f.endsWith(".pcm")).slice(0, Number(arg("n") ?? "12"));
  const rows: string[] = [];
  for (const file of files) {
    const pcm = readFileSync(path.join(dir, file));
    const events: { at: number; kind: string; text?: string }[] = [];
    const t0 = performance.now();
    const stt = await openDeepgramStt(
      { apiKey: key, language: "pt-BR" },
      {
        partial: (text) => events.push({ at: performance.now() - t0, kind: "partial", text }),
        final: (text, speechFinal) => events.push({ at: performance.now() - t0, kind: speechFinal ? "final+speech" : "final", text }),
        speechStarted: () => events.push({ at: performance.now() - t0, kind: "speechStarted" }),
        utteranceEnd: () => events.push({ at: performance.now() - t0, kind: "utteranceEnd" }),
        failed: (error) => process.stderr.write(`${error.message}\n`),
      },
    );
    const start = performance.now();
    let next = start;
    const frames = Math.ceil(pcm.length / FRAME_BYTES);
    const finalizeAt = Number(arg("finalize-at") ?? "0");
    let finalizeSent = false;
    for (let i = 0; i < frames + 75; i++) {
      if (finalizeAt > 0 && !finalizeSent && i >= frames + Math.round(finalizeAt / 20)) {
        finalizeSent = true;
        events.push({ at: performance.now() - t0, kind: "FINALIZE_SENT" });
        stt.finalize();
      }
      next += 20;
      const frame = Buffer.alloc(FRAME_BYTES);
      if (i < frames) pcm.copy(frame, 0, i * FRAME_BYTES, Math.min(pcm.length, (i + 1) * FRAME_BYTES));
      stt.sendAudio(frame);
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    }
    const endOfSpeech = start - t0 + frames * 20;
    await stt.close();
    const rel = events.filter((e) => e.kind !== "speechStarted" && e.kind !== "utteranceEnd").map((e) => `${e.kind}@${Math.round(e.at - endOfSpeech)}${e.text ? `:"${e.text.slice(-28)}"` : ""}`);
    rows.push(`${file} dur=${frames * 20}ms\n  ${rel.slice(-8).join("\n  ")}`);
  }
  process.stdout.write(`${rows.join("\n")}\n`);
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
