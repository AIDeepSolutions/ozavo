import { FRAME_SAMPLES } from "../pipeline/vad";

/** Silêncio de `frames` quadros de 20 ms (PCM16 8 kHz). */
export function silence(frames: number): Buffer {
  return Buffer.alloc(frames * FRAME_SAMPLES * 2);
}

/** Senoide pura (um bipe), `frames` quadros de 20 ms. */
export function tone(frames: number, hz: number, amplitude = 12_000): Buffer {
  const samples = frames * FRAME_SAMPLES;
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 8000)), i * 2);
  return buffer;
}

/**
 * "Fala" sintética: ruído com envoltória, sem tom dominante (o detector de bipe não a confunde).
 * Determinística: o mesmo `seed` dá o mesmo áudio.
 */
export function speech(frames: number, amplitude = 9_000, seed = 7): Buffer {
  const samples = frames * FRAME_SAMPLES;
  const buffer = Buffer.alloc(samples * 2);
  let state = seed;
  for (let i = 0; i < samples; i++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const noise = state / 1_073_741_824 - 1;
    const envelope = 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / 8000);
    buffer.writeInt16LE(Math.round(amplitude * noise * envelope), i * 2);
  }
  return buffer;
}
