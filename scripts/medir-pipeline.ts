/** Bancada opt-in: mede serviços reais; só escreve métricas, nunca credenciais ou áudio. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { systemClock } from "../packages/core/src/clock";
import { CARTESIA_DEFAULT_VOICE } from "../packages/voice-engine/src/engines/deepgram-openrouter-cartesia";
import { openCartesiaTts } from "../packages/voice-engine/src/pipeline/cartesia-tts";
import { streamChat } from "../packages/voice-engine/src/pipeline/openrouter-llm";

async function readKey(file: string, name: string): Promise<string> {
  const environment = process.env[name];
  if (environment) return environment;
  const content = await readFile(file, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line.trim());
    if (match?.[1] === name && match[2]) return match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  throw new Error(`Credencial ausente: ${name}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes("--live")) throw new Error("Use --live para medir serviços pagos; testes locais: pnpm vitest run --project unit packages/voice-engine");
  const configDir = path.join(homedir(), ".config", "dev-hub");
  const cartesiaKey = await readKey(path.join(configDir, "supabase.env"), "CARTESIA_API_KEY");
  const routerKey = await readKey(path.join(configDir, "openrouter.env"), "OPENROUTER_API_KEY");
  const samples: number[] = [];
  let complete: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const tts = await openCartesiaTts({ apiKey: cartesiaKey, voiceId: CARTESIA_DEFAULT_VOICE, language: "pt-BR", clock: systemClock }, {
    audio: () => undefined,
    firstAudio: (_id, ms) => samples.push(ms),
    done: () => complete?.(),
    error: (error) => reject?.(error),
    failed: (error) => reject?.(error),
  });
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, fail) => {
        const timer = setTimeout(() => fail(new Error("Cartesia: prazo de síntese excedido")), 15000);
        complete = () => { clearTimeout(timer); resolve(); };
        reject = (error) => { clearTimeout(timer); fail(error); };
        tts.speak(`benchmark-${i}`, "Olá, em que posso ajudar?", true);
      });
    }
  } finally {
    await tts.close();
  }
  let firstTokenMs: number | undefined;
  const start = systemClock.now().getTime();
  for await (const event of streamChat({ apiKey: routerKey, messages: [{ role: "system", content: "Responda em português, em uma frase de até 160 caracteres." }, { role: "user", content: "Diga bom dia e pergunte como pode ajudar." }], tools: [], signal: AbortSignal.timeout(20000) })) {
    if (event.type === "text") firstTokenMs ??= systemClock.now().getTime() - start;
  }
  process.stdout.write(JSON.stringify({ cartesiaTtfbMs: samples, cartesiaTargetMs: 100, openrouterFirstTokenMs: firstTokenMs, fullRttMeasured: false, note: "RTT completo depende da chave Deepgram e áudio de entrada; estes valores medem TTS e LLM separadamente." }, null, 2) + "\n");
}

main().catch(() => {
  process.stderr.write("Bancada falhou; verifique credenciais, acesso aos modelos e conectividade. Nenhum segredo foi registrado.\n");
  process.exitCode = 1;
});
