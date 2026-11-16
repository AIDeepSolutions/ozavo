import { describe, expect, it } from "vitest";
import { TURN_TARGET_MAX_CHARACTERS, TURN_TOLERANCE_CHARACTERS, createTurnLimiter } from "./turn-guard";

/** Passa o texto em pedaços de `size` caracteres, como o modelo entrega, e junta o que foi liberado. */
function feed(text: string, size = 7): { spoken: string; truncated: boolean } {
  const limiter = createTurnLimiter();
  let spoken = "";
  for (let at = 0; at < text.length; at += size) spoken += limiter.push(text.slice(at, at + size));
  spoken += limiter.flush();
  return { spoken, truncated: limiter.truncated };
}

const words = (count: number): string => Array.from({ length: count }, (_, i) => `palavra${i}`).join(" ");

describe("limitador suave do turno", () => {
  it("resposta dentro do alvo passa inteira", () => {
    const text = "Claro, posso agendar. Qual horário fica melhor para você, de manhã ou à tarde?";
    expect(feed(text)).toEqual({ spoken: text, truncated: false });
  });

  it("deixa terminar a frase que passou do alvo, dentro da tolerância", () => {
    const first = `${words(15)}.`;
    const second = ` ${words(4)}.`;
    const text = `${first}${second} Esta terceira frase não cabe mais no turno e fica de fora.`;
    expect(first.length).toBeLessThan(TURN_TARGET_MAX_CHARACTERS);
    expect((first + second).length).toBeGreaterThan(TURN_TARGET_MAX_CHARACTERS);
    expect((first + second).length).toBeLessThanOrEqual(TURN_TOLERANCE_CHARACTERS);
    expect(feed(text)).toEqual({ spoken: first + second, truncated: true });
  });

  it("frase que não termina na tolerância é cortada na última palavra inteira antes do alvo", () => {
    const text = words(60);
    const { spoken, truncated } = feed(text);
    expect(truncated).toBe(true);
    expect(spoken.length).toBeLessThanOrEqual(TURN_TARGET_MAX_CHARACTERS);
    expect(spoken.length).toBeGreaterThan(TURN_TARGET_MAX_CHARACTERS - 12);
    expect(text.startsWith(spoken)).toBe(true);
    // Corta entre palavras: o que vem logo depois do corte é um espaço.
    expect(text[spoken.length]).toBe(" ");
  });

  it("resposta sem ponto final que termina dentro da tolerância vai inteira", () => {
    const text = words(18);
    expect(text.length).toBeGreaterThan(TURN_TARGET_MAX_CHARACTERS);
    expect(text.length).toBeLessThanOrEqual(TURN_TOLERANCE_CHARACTERS);
    expect(feed(text)).toEqual({ spoken: text, truncated: false });
  });

  it("o resultado não depende do tamanho dos pedaços", () => {
    const text = `${words(15)}. ${words(4)}. ${words(30)}`;
    const reference = feed(text, 1);
    for (const size of [2, 5, 13, 40, 500]) expect(feed(text, size)).toEqual(reference);
  });

  it("depois do corte, nada mais passa", () => {
    const limiter = createTurnLimiter();
    limiter.push(words(60));
    expect(limiter.push(" mais texto.")).toBe("");
    expect(limiter.flush()).toBe("");
  });
});
