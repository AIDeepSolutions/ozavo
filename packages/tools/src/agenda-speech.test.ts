import { describe, expect, it } from "vitest";
import { agendaFailureDiagnostic } from "./agenda-speech";

describe("agendaFailureDiagnostic", () => {
  it("conta a cadeia de erros com o código de rede, em uma linha", () => {
    const rede = Object.assign(new Error("connect ENETUNREACH 2606:4700::6812:13e:443"), { code: "ENETUNREACH" });
    const erro = new TypeError("fetch failed", { cause: rede });

    expect(agendaFailureDiagnostic(erro)).toBe("TypeError: fetch failed <- Error: connect ENETUNREACH 2606:4700::6812:13e:443 [ENETUNREACH]");
  });

  it("nunca deixa passar chave de API nem token", () => {
    const texto = agendaFailureDiagnostic(new Error("Cal.com answered HTTP 401: Bearer abcdef1234 cal_live_0123456789abcdef0123456789abcdef"));

    expect(texto).not.toContain("abcdef1234");
    expect(texto).not.toContain("cal_live_");
    expect(texto).toContain("<oculto>");
  });

  it("nunca deixa passar e-mail nem telefone", () => {
    const texto = agendaFailureDiagnostic(new Error("recusou fulano.teste@mailinator.com com +55 11 96493-9976"));

    expect(texto).not.toMatch(/mailinator|96493/);
  });

  it("limita o tamanho e aceita o que não é Error", () => {
    expect(agendaFailureDiagnostic("falhou").length).toBeGreaterThan(0);
    expect(agendaFailureDiagnostic(new Error("x".repeat(2000))).length).toBeLessThanOrEqual(400);
  });
});
