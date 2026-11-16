import { describe, expect, it } from "vitest";
import { silence, speech } from "../testing/audio";
import { EnergyVad, frameDb } from "./vad";

describe("EnergyVad", () => {
  it("aprende ruído branco realmente constante, sem envoltória de fala", () => {
    const vad = new EnergyVad();
    const audio = Buffer.alloc(8 * 16000);
    let state = 7;
    for (let i = 0; i < audio.length; i += 2) {
      state = (state * 1103515245 + 12345) % 2147483648;
      audio.writeInt16LE(Math.round((state / 1073741824 - 1) * 1500), i);
    }
    vad.push(audio);
    expect(vad.speaking).toBe(false);
  });

  it("silêncio não vira fala", () => {
    const vad = new EnergyVad();
    expect(vad.push(silence(100))).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  it("fala sustentada dispara início depois de 120 ms, e o silêncio dispara fim", () => {
    const vad = new EnergyVad();
    vad.push(silence(20));
    expect(vad.push(speech(5))).toEqual([]);
    expect(vad.push(speech(1))).toEqual([{ type: "speech_start" }]);
    const end = vad.push(silence(15));
    expect(end).toEqual([{ type: "speech_end", speechFrames: 6 }]);
  });

  it("um estalo curto não interrompe ninguém", () => {
    const vad = new EnergyVad();
    vad.push(silence(20));
    expect(vad.push(Buffer.concat([speech(3), silence(10)]))).toEqual([]);
  });

  it("aceita pedaços de qualquer tamanho, sem perder amostras", () => {
    const vad = new EnergyVad();
    const audio = Buffer.concat([silence(10), speech(10)]);
    const events = [];
    for (let i = 0; i < audio.length; i += 97) events.push(...vad.push(audio.subarray(i, i + 97)));
    expect(events).toEqual([{ type: "speech_start" }]);
  });

  it("ruído de fundo constante sobe o piso e para de contar como fala", () => {
    const vad = new EnergyVad();
    const events = vad.push(speech(400, 1_500));
    // Pode abrir no começo, antes de aprender o piso, mas fecha e não fica falando.
    expect(vad.speaking).toBe(false);
    expect(events.filter((event) => event.type === "speech_start").length).toBeLessThanOrEqual(1);
  });

  it("frameDb: silêncio é -100, cheio é perto de 0", () => {
    expect(frameDb(silence(1))).toBe(-100);
    const full = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) full.writeInt16LE(i % 2 === 0 ? 32767 : -32768, i * 2);
    expect(frameDb(full)).toBeGreaterThan(-0.1);
  });
});
