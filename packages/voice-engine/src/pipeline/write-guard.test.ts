import { describe, expect, it } from "vitest";
import { claimsDone } from "./write-guard";

describe("claimsDone: a negação ou a condição só vale no trecho do verbo", () => {
  it("afirma quando o 'não' ou o 'se' são de outro trecho da frase (achado 6 da revisão)", () => {
    expect(claimsDone("Marquei, e não precisa fazer nada.", "pt")).toBe(true);
    expect(claimsDone("Marquei para segunda, se precisar remarcar é só ligar.", "pt")).toBe(true);
    expect(claimsDone("Não se preocupe, marquei para segunda.", "pt")).toBe(true);
    expect(claimsDone("Pronto, cancelei, mas você pode marcar outro quando quiser.", "pt")).toBe(true);
    expect(claimsDone("Sua consulta está marcada, e não é preciso confirmar de novo.", "pt")).toBe(true);
    expect(claimsDone("I booked it, and you do not need to do anything.", "en")).toBe(true);
    expect(claimsDone("Agendé, y no hace falta que haga nada.", "es")).toBe(true);
  });

  it("não afirma negação, promessa, hipótese nem pergunta no trecho do verbo", () => {
    expect(claimsDone("Não marquei nada ainda.", "pt")).toBe(false);
    expect(claimsDone("Ainda não marquei, mas vou marcar assim que você confirmar.", "pt")).toBe(false);
    expect(claimsDone("Se eu marquei errado, me avise.", "pt")).toBe(false);
    expect(claimsDone("Posso confirmar essa consulta?", "pt")).toBe(false);
    expect(claimsDone("Você quer que eu marque? Posso marcar agora.", "pt")).toBe(false);
    expect(claimsDone("I have not booked it yet.", "en")).toBe(false);
    expect(claimsDone("Vou agendar para el lunes.", "es")).toBe(false);
    expect(claimsDone("Tenho quinta às nove horas.", "pt")).toBe(false);
    expect(claimsDone("", "pt")).toBe(false);
  });

  it("as frases de confirmação de sempre continuam reconhecidas", () => {
    for (const frase of ["Pronto, sua consulta está marcada para sexta.", "Remarquei para segunda às nove.", "Cancelei a consulta de sexta.", "Fica confirmado, então."]) expect(claimsDone(frase, "pt"), frase).toBe(true);
  });
});
