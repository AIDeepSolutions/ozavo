/**
 * Detecção de fala local (VAD por energia), contínua, sobre o áudio de quem ligou.
 *
 * Roda aqui, sem rede: é o que permite cortar a fala do agente (barge-in) na hora em que a pessoa
 * começa a falar, sem esperar o provedor de transcrição. O piso de ruído se adapta ao fundo da
 * linha, então um ambiente barulhento não fica "falando" o tempo todo.
 *
 * O tempo é contado em quadros de 20 ms do próprio áudio, nunca no relógio: o mesmo áudio dá
 * sempre a mesma decisão.
 */

/** 20 ms de PCM16 mono a 8 kHz. */
export const FRAME_SAMPLES = 160;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
export const FRAME_MS = 20;

export interface VadOptions {
  /** Quantos dB acima do piso de ruído contam como fala. Padrão: 12 dB. */
  marginDb?: number;
  /** Quadros seguidos de fala para declarar início. Padrão: 6 (120 ms), o que ignora estalos. */
  startFrames?: number;
  /** Quadros seguidos de silêncio para declarar fim. Padrão: 15 (300 ms). */
  stopFrames?: number;
  /** Energia mínima absoluta para ser fala, em dBFS. Padrão: -45 dBFS. */
  floorDb?: number;
}

export type VadEvent = { type: "speech_start" } | { type: "speech_end"; speechFrames: number };

/** Energia RMS de um quadro em dBFS (0 é o máximo do PCM16). Silêncio absoluto vale -100. */
export function frameDb(frame: Buffer): number {
  const samples = frame.length >> 1;
  if (samples === 0) return -100;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = frame.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples);
  return rms <= 0 ? -100 : Math.max(-100, 20 * Math.log10(rms));
}

export class EnergyVad {
  private readonly marginDb: number;
  private readonly startFrames: number;
  private readonly stopFrames: number;
  private readonly floorDb: number;
  private noiseDb = -70;
  private stableFrames = 0;
  private stableMin = 0;
  private stableMax = -100;
  private pending = Buffer.alloc(0);
  private voicedRun = 0;
  private silentRun = 0;
  private speechFrames = 0;
  speaking = false;

  constructor(options: VadOptions = {}) {
    this.marginDb = options.marginDb ?? 12;
    this.startFrames = options.startFrames ?? 6;
    this.stopFrames = options.stopFrames ?? 15;
    this.floorDb = options.floorDb ?? -45;
  }

  /** Recebe áudio de qualquer tamanho e devolve as mudanças de estado, na ordem. */
  push(pcm16: Buffer): VadEvent[] {
    const events: VadEvent[] = [];
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, pcm16]) : pcm16;
    while (data.length >= FRAME_BYTES) {
      const event = this.frame(data.subarray(0, FRAME_BYTES));
      if (event) events.push(event);
      data = data.subarray(FRAME_BYTES);
    }
    this.pending = Buffer.from(data);
    return events;
  }

  private frame(frame: Buffer): VadEvent | undefined {
    const db = frameDb(frame);
    this.stableMin = Math.min(this.stableMin, db);
    this.stableMax = Math.max(this.stableMax, db);
    if (++this.stableFrames >= 50) {
      // Energia estável por um segundo é fundo contínuo. Fala modulada tem vales maiores.
      if (this.stableMax - this.stableMin < 3) this.noiseDb = (this.stableMin + this.stableMax) / 2;
      this.stableFrames = 0;
      this.stableMin = 0;
      this.stableMax = -100;
    }
    const voiced = db > this.floorDb && db > this.noiseDb + this.marginDb;
    // O piso só aprende com o que não é fala: sobe devagar, desce rápido.
    if (!voiced) this.noiseDb = db > this.noiseDb ? this.noiseDb * 0.95 + db * 0.05 : this.noiseDb * 0.7 + db * 0.3;
    if (voiced) {
      this.voicedRun++;
      this.silentRun = 0;
    } else {
      this.silentRun++;
      this.voicedRun = 0;
    }
    if (this.speaking) {
      this.speechFrames++;
      if (this.silentRun >= this.stopFrames) {
        this.speaking = false;
        const speechFrames = this.speechFrames - this.silentRun;
        this.speechFrames = 0;
        return { type: "speech_end", speechFrames };
      }
      return undefined;
    }
    if (this.voicedRun >= this.startFrames) {
      this.speaking = true;
      this.speechFrames = this.voicedRun;
      return { type: "speech_start" };
    }
    return undefined;
  }
}
