import { describe, expect, it } from "vitest";
import { ENDPOINT_CLOSED_MS, ENDPOINT_DEFAULT_MS, ENDPOINT_NOISY_EXTRA_MS, ENDPOINT_OPEN_MS, endpointDelayMs } from "./endpointing";

describe("endpointDelayMs", () => {
  it("frase fechada responde logo", () => {
    expect(endpointDelayMs("Quero marcar uma consulta.")).toBe(ENDPOINT_CLOSED_MS);
    expect(endpointDelayMs("Vocês abrem sábado?")).toBe(ENDPOINT_CLOSED_MS);
  });

  it("frase que termina em conjunção ou hesitação espera mais", () => {
    expect(endpointDelayMs("Quero marcar para")).toBe(ENDPOINT_OPEN_MS);
    expect(endpointDelayMs("Eu queria saber se")).toBe(ENDPOINT_OPEN_MS);
    expect(endpointDelayMs("é que tipo, né")).toBe(ENDPOINT_OPEN_MS);
    expect(endpointDelayMs("então,")).toBe(ENDPOINT_OPEN_MS);
    expect(endpointDelayMs("deixa eu ver...")).toBe(ENDPOINT_OPEN_MS);
  });

  it("frase sem pontuação fica no meio", () => {
    expect(endpointDelayMs("sexta de manhã")).toBe(ENDPOINT_DEFAULT_MS);
    expect(endpointDelayMs("")).toBe(ENDPOINT_DEFAULT_MS);
  });

  it("ambiente barulhento dá mais folga", () => {
    expect(endpointDelayMs("Pode ser.", "noisy")).toBe(ENDPOINT_CLOSED_MS + ENDPOINT_NOISY_EXTRA_MS);
  });

  it("o prazo mais longo cabe no orçamento de 500 ms só com frase fechada", () => {
    expect(ENDPOINT_CLOSED_MS).toBeLessThan(200);
  });
});
