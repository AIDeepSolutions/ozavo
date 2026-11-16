import type { AnsweringMachineDetection } from "../types";
import { EnergyVad, FRAME_BYTES, frameDb } from "./vad";

/**
 * Detecção de caixa postal (AMD) nos primeiros segundos da ligação atendida.
 *
 * Quatro sinais, o primeiro que aparecer decide:
 * - frase típica de caixa postal na transcrição ("deixe sua mensagem", "após o sinal");
 * - bipe: um tom puro sustentado (a secretária pedindo o recado);
 * - saudação longa sem pausa: pessoa atende com "alô?", gravação fala uma frase inteira;
 * - saudação curta seguida de silêncio: é gente.
 * Sem decisão no prazo, `unknown`: quem conduz a chamada decide encerrar por falta de resposta.
 *
 * Tudo é contado em quadros de 20 ms do áudio, sem relógio. Os limiares são ponto de partida
 * de mercado (saudação humana costuma durar menos de 1,5 s), não medidos em ligação real daqui.
 */

const MACHINE_PHRASES = [
  /deix(e|a) (a |o )?(sua |seu )?(mensagem|recado)/i,
  /ap[oó]s o (sinal|bipe|bip)/i,
  /caixa postal/i,
  /n[aã]o (est[aá]|pode) (dispon[ií]vel|atender)/i,
  /fora da [aá]rea de cobertura/i,
  /desligado ou fora/i,
  /grave (a |o )?(sua |seu )?(mensagem|recado)/i,
  /leave (a |your )?message/i,
  /after the (tone|beep)/i,
  /not available/i,
  /deje (su |un )?mensaje/i,
  /despu[eé]s del tono/i,
];

export interface AmdOptions {
  /** Fala contínua, em quadros, que já é gravação. Padrão: 125 (2,5 s). */
  longGreetingFrames?: number;
  /** Fala, em quadros, que ainda é atendimento de gente. Padrão: 75 (1,5 s). */
  shortGreetingFrames?: number;
  /** Quadros de tom puro seguidos que formam um bipe. Padrão: 10 (200 ms). */
  beepFrames?: number;
  /** Prazo total, em quadros. Padrão: 250 (5 s). */
  maxFrames?: number;
}

/** Fração da energia do quadro concentrada numa frequência (1 = senoide pura). Goertzel. */
export function toneRatio(frame: Buffer, hz: number, sampleRate = 8000): number {
  const n = frame.length >> 1;
  if (n === 0) return 0;
  const k = Math.round((n * hz) / sampleRate);
  const coeff = 2 * Math.cos((2 * Math.PI * k) / n);
  let s1 = 0;
  let s2 = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const x = frame.readInt16LE(i * 2);
    energy += x * x;
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  if (energy === 0) return 0;
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / ((n / 2) * energy);
}

const BEEP_FREQUENCIES = Array.from({ length: 33 }, (_, i) => 400 + i * 50);

export class AnsweringMachineDetector {
  private readonly vad = new EnergyVad();
  private readonly longGreetingFrames: number;
  private readonly shortGreetingFrames: number;
  private readonly beepFrames: number;
  private readonly maxFrames: number;
  private pending = Buffer.alloc(0);
  private frames = 0;
  private speechRun = 0;
  private toneRun = 0;
  private toneHz = 0;
  private result: AnsweringMachineDetection | undefined;

  constructor(
    private readonly onDecision: (detection: AnsweringMachineDetection) => void,
    options: AmdOptions = {},
  ) {
    this.longGreetingFrames = options.longGreetingFrames ?? 125;
    this.shortGreetingFrames = options.shortGreetingFrames ?? 75;
    this.beepFrames = options.beepFrames ?? 10;
    this.maxFrames = options.maxFrames ?? 250;
  }

  get decided(): boolean {
    return this.result !== undefined;
  }

  pushAudio(pcm16: Buffer): void {
    if (this.result) return;
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, pcm16]) : pcm16;
    while (data.length >= FRAME_BYTES && !this.result) {
      const frame = data.subarray(0, FRAME_BYTES);
      const events = this.vad.push(frame);
      // Processa cada quadro antes do seguinte: o tamanho do chunk não muda o veredito.
      this.frame(frame);
      if (!this.result && events.some((event) => event.type === "speech_end" && event.speechFrames > 0 && event.speechFrames <= this.shortGreetingFrames)) {
        this.decide({ verdict: "human", reason: "short_greeting" });
      }
      data = data.subarray(FRAME_BYTES);
    }
    this.pending = Buffer.from(data);
  }

  pushTranscript(text: string): void {
    if (this.result) return;
    if (MACHINE_PHRASES.some((phrase) => phrase.test(text))) this.decide({ verdict: "machine", reason: "phrase" });
  }

  private frame(frame: Buffer): void {
    this.frames++;
    this.speechRun = this.vad.speaking ? this.speechRun + 1 : 0;
    if (this.speechRun >= this.longGreetingFrames) return this.decide({ verdict: "machine", reason: "long_greeting" });
    if (frameDb(frame) > -35) {
      let bestHz = 0;
      let best = 0;
      for (const hz of BEEP_FREQUENCIES) {
        const ratio = toneRatio(frame, hz);
        if (ratio > best) {
          best = ratio;
          bestHz = hz;
        }
      }
      const sameTone = this.toneRun > 0 && Math.abs(bestHz - this.toneHz) <= 50;
      this.toneRun = best > 0.6 ? (sameTone ? this.toneRun + 1 : 1) : 0;
      this.toneHz = bestHz;
      if (this.toneRun >= this.beepFrames) return this.decide({ verdict: "machine", reason: "beep" });
    } else {
      this.toneRun = 0;
    }
    if (this.frames >= this.maxFrames) this.decide({ verdict: "unknown", reason: "timeout" });
  }

  private decide(detection: AnsweringMachineDetection): void {
    if (this.result) return;
    this.result = detection;
    this.onDecision(detection);
  }
}

