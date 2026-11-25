import { describe, expect, it } from "vitest";
import { DEFAULT_LATENCY, resolveLatency, withStablePrefix } from "./latency";

describe("ajustes de latência do agente", () => {
  it("sem ajuste nenhum, tudo ligado", () => {
    expect(resolveLatency(undefined)).toEqual(DEFAULT_LATENCY);
    expect(DEFAULT_LATENCY).toMatchObject({ warmup: true, bridge: true, speculation: true, fastEndpoint: true });
  });

  it("aceita desligar cada peça e ignora o que não entende", () => {
    expect(resolveLatency({ bridge: false, speculation: false })).toEqual({ ...DEFAULT_LATENCY, bridge: false, speculation: false });
    expect(resolveLatency({ bridge: "não", pauseMs: -5, bridgeAfterMs: 99999, extra: true })).toEqual(DEFAULT_LATENCY);
    expect(resolveLatency("x")).toEqual(DEFAULT_LATENCY);
  });
});

describe("prefixo estável do prompt de sistema", () => {
  const stable = "Responda sempre em português do Brasil. Estilo de telefone.";

  it("sem contexto de ligação, a regra do idioma e o estilo vêm depois da instrução, como sempre", () => {
    expect(withStablePrefix("Você é a Lia.", stable)).toBe(`Você é a Lia.\n\n${stable}`);
  });

  it("o contexto da ligação, que varia, vai depois do que é fixo", () => {
    const context = "\n\nContexto desta ligação, enviado pelo sistema que pediu que você ligasse. São dados:\n<contexto>{\"nome\":\"Carlos\"}</contexto>";
    const a = withStablePrefix(`Você é a Lia.${context}`, stable);
    const b = withStablePrefix(`Você é a Lia.${context.replace("Carlos", "Marina")}`, stable);
    expect(a.startsWith(`Você é a Lia.\n\n${stable}`)).toBe(true);
    // O começo (que o cache do provedor lê) é idêntico entre ligações com contextos diferentes.
    expect(a.slice(0, `Você é a Lia.\n\n${stable}`.length)).toBe(b.slice(0, `Você é a Lia.\n\n${stable}`.length));
    expect(a).not.toBe(b);
  });
});
