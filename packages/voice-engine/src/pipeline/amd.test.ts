import { describe, expect, it } from "vitest";
import type { AnsweringMachineDetection } from "../types";
import { silence, speech, tone } from "../testing/audio";
import { AnsweringMachineDetector, toneRatio } from "./amd";

const detector = () => {
  const decisions: AnsweringMachineDetection[] = [];
  const amd = new AnsweringMachineDetector((detection) => decisions.push(detection));
  return { amd, decisions };
};

describe("AnsweringMachineDetector", () => {
  it("o tamanho do chunk não muda a classificação de saudação longa", () => {
    const audio = Buffer.concat([silence(10), speech(150), silence(20)]);
    const a = detector();
    const b = detector();
    a.amd.pushAudio(audio);
    for (let offset = 0; offset < audio.length; offset += 97) b.amd.pushAudio(audio.subarray(offset, offset + 97));
    expect(a.decisions).toEqual(b.decisions);
    expect(a.decisions).toEqual([{ verdict: "machine", reason: "long_greeting" }]);
  });

  it("'alô?' curto seguido de silêncio é gente", () => {
    const { amd, decisions } = detector();
    amd.pushAudio(Buffer.concat([silence(10), speech(30), silence(20)]));
    expect(decisions).toEqual([{ verdict: "human", reason: "short_greeting" }]);
  });

  it("saudação longa sem pausa é caixa postal", () => {
    const { amd, decisions } = detector();
    amd.pushAudio(Buffer.concat([silence(10), speech(140)]));
    expect(decisions).toEqual([{ verdict: "machine", reason: "long_greeting" }]);
  });

  it("frase típica na transcrição é caixa postal, em pt, en e es", () => {
    for (const text of ["Deixe sua mensagem após o sinal", "Please leave a message after the tone", "Deje su mensaje después del tono"]) {
      const { amd, decisions } = detector();
      amd.pushTranscript(text);
      expect(decisions).toEqual([{ verdict: "machine", reason: "phrase" }]);
    }
  });

  it("bipe é caixa postal", () => {
    const { amd, decisions } = detector();
    amd.pushAudio(Buffer.concat([silence(5), tone(12, 1000)]));
    expect(decisions).toEqual([{ verdict: "machine", reason: "beep" }]);
  });

  it("sem sinal no prazo, `unknown`", () => {
    const { amd, decisions } = detector();
    amd.pushAudio(silence(260));
    expect(decisions).toEqual([{ verdict: "unknown", reason: "timeout" }]);
  });

  it("decide uma vez só", () => {
    const { amd, decisions } = detector();
    amd.pushTranscript("caixa postal");
    amd.pushTranscript("caixa postal");
    amd.pushAudio(silence(300));
    expect(decisions).toHaveLength(1);
    expect(amd.decided).toBe(true);
  });

  it("toneRatio: senoide pura perto de 1, ruído perto de 0", () => {
    expect(toneRatio(tone(1, 1000), 1000)).toBeGreaterThan(0.9);
    expect(toneRatio(speech(1), 1000)).toBeLessThan(0.3);
  });
});
