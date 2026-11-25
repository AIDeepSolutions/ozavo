import { describe, expect, it } from "vitest";
import { ENDPOINT_CLOSED_MS, ENDPOINT_DEFAULT_MS, ENDPOINT_NOISY_EXTRA_MS, ENDPOINT_OPEN_MS, assessTurnEnd, endpointDelayMs } from "./endpointing";

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

describe("assessTurnEnd: fim de turno pela pausa", () => {
  const kind = (text: string, env?: "normal" | "noisy") => assessTurnEnd(text, env).kind;

  it("regressão da chamada do dono: 'E quais são suas' (mesmo com o ? que a Deepgram põe) não fecha o turno; a continuação fecha", () => {
    expect(kind("E quais são suas")).toBe("open");
    expect(kind("E quais são suas?")).toBe("open");
    expect(kind("empreitadas aí nessa empresa?")).toBe("closed");
    expect(kind("E quais são suas? empreitadas aí nessa empresa?")).toBe("closed");
  });

  it("frase fechada e resposta curta fecham na hora; a espera do silêncio é pequena", () => {
    expect(kind("Quero marcar uma consulta.")).toBe("closed");
    expect(kind("Vocês abrem sábado?")).toBe("closed");
    expect(kind("Sim.")).toBe("short");
    expect(kind("Não")).toBe("short");
    expect(kind("Ok.")).toBe("short");
    expect(kind("Entendi, obrigado.")).toBe("closed");
    expect(assessTurnEnd("Sim.").silenceMs).toBeLessThanOrEqual(350);
  });

  it("conjunção, preposição, artigo, vírgula e reticências deixam a frase aberta", () => {
    for (const text of ["Quero marcar para", "Eu queria saber se", "Pode ser com o", "então,", "Quanto custa a"]) expect(kind(text)).toBe("open");
    expect(kind("deixa eu ver...")).toBe("hesitation");
    expect(assessTurnEnd("Quero marcar para").silenceMs).toBeGreaterThanOrEqual(1000);
  });

  it("hesitação e dado ditado pela metade esperam, mesmo com ponto final", () => {
    expect(kind("Hum, deixa eu pensar.")).toBe("hesitation");
    expect(kind("Espera aí.")).toBe("hesitation");
    expect(kind("Meu telefone é 11 99999")).toBe("dictation");
    expect(kind("Meu cpf é 123 456")).toBe("dictation");
    expect(kind("Meu telefone é 11 99999.")).toBe("dictation");
    expect(kind("Meu telefone é 11 99999 1234.")).toBe("closed");
    expect(kind("Meu cep é 01310 100")).toBe("default");
  });

  it("sem pontuação, nem fechada nem aberta: fica no meio; enchimento no fim abre", () => {
    expect(kind("sexta de manhã")).toBe("default");
    expect(kind("é que tipo")).toBe("open");
    expect(assessTurnEnd("sexta de manhã").silenceMs).toBeGreaterThan(assessTurnEnd("Pode ser.").silenceMs);
  });

  it("ambiente barulhento soma folga a todas as classes", () => {
    expect(assessTurnEnd("Pode ser.", "noisy").silenceMs).toBe(assessTurnEnd("Pode ser.").silenceMs + ENDPOINT_NOISY_EXTRA_MS);
  });
});
