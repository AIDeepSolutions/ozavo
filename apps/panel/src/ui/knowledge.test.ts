import { describe, expect, it } from "vitest";
import { chosenTokens, formatCompactCount, formatUsd, hasPendingSource, resolveMode, similarityPercent } from "./knowledge";

describe("custo da base de conhecimento", () => {
  it("converte microcentavos de dólar (1 US$ = 100.000.000) e mostra mais casas quando o valor é pequeno", () => {
    expect(formatUsd(0, "en")).toBe("$0.00");
    expect(formatUsd(100_000_000, "en")).toBe("$1.00");
    expect(formatUsd(2_000, "en")).toBe("$0.00002");
    expect(formatUsd(150_000, "en")).toBe("$0.0015");
    expect(formatUsd(2_000_000, "en")).toBe("$0.02");
    expect(formatUsd(250_000_000, "pt-BR")).toMatch(/^US\$\s2,50$/);
    expect(formatUsd(100, "es")).toMatch(/0,000001/);
  });

  it("escreve os tetos sem a fileira de zeros", () => {
    expect(formatCompactCount(1_000_000, "en")).toBe("1 million");
    expect(formatCompactCount(5_000_000, "pt-BR")).toBe("5 milhões");
    expect(formatCompactCount(5_000_000, "es")).toMatch(/5 millones/);
  });
});

describe("atualização do estado", () => {
  it("só há o que atualizar enquanto uma fonte está na fila ou indexando", () => {
    expect(hasPendingSource([])).toBe(false);
    expect(hasPendingSource([{ status: "ready" }, { status: "failed" }])).toBe(false);
    expect(hasPendingSource([{ status: "ready" }, { status: "queued" }])).toBe(true);
    expect(hasPendingSource([{ status: "processing" }])).toBe(true);
  });
});

describe("bases do agente", () => {
  const sources = [
    { id: "a", tokenCount: 2000, currentVersionId: "v1" },
    { id: "b", tokenCount: 3000, currentVersionId: "v2" },
    { id: "c", tokenCount: 9000, currentVersionId: null },
  ];

  it("soma só as bases escolhidas que já respondem", () => {
    expect(chosenTokens(sources, new Set(["a", "b"]))).toBe(5000);
    expect(chosenTokens(sources, new Set(["a", "c"]))).toBe(2000);
    expect(chosenTokens(sources, new Set())).toBe(0);
  });

  it("o modo automático escolhe como o núcleo: cabe inteira até o teto, acima busca", () => {
    expect(resolveMode("auto", 6000, 6000)).toBe("full");
    expect(resolveMode("auto", 6001, 6000)).toBe("rag");
    expect(resolveMode("rag", 10, 6000)).toBe("rag");
    expect(resolveMode("full", 99_000, 6000)).toBe("full");
  });

  it("a similaridade vira porcentagem inteira entre 0 e 100", () => {
    expect(similarityPercent(0.634)).toBe(63);
    expect(similarityPercent(-0.2)).toBe(0);
    expect(similarityPercent(1.4)).toBe(100);
  });
});
