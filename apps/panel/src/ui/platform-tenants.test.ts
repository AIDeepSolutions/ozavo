import { describe, expect, it } from "vitest";
import { minutesOf, reaisToCents, usagePercent, wholeNumber } from "./platform-tenants";

describe("conta da franquia", () => {
  it("conta minuto começado e limita a barra em 100%", () => {
    expect(minutesOf(0)).toBe(0);
    expect(minutesOf(61)).toBe(2);
    expect(usagePercent(9_000, 18_000)).toBe(50);
    expect(usagePercent(30_000, 18_000)).toBe(100);
    expect(usagePercent(0, 0)).toBe(0);
    expect(usagePercent(10, 0)).toBe(100);
  });
});

describe("entrada do formulário", () => {
  it("aceita reais com e sem separador de milhar", () => {
    expect(reaisToCents("1.997,00")).toBe(199_700);
    expect(reaisToCents("1997,5")).toBe(199_750);
    expect(reaisToCents("1997")).toBe(199_700);
    expect(reaisToCents("1.997")).toBe(199_700);
    expect(reaisToCents("12.000.000")).toBe(1_200_000_000);
    expect(reaisToCents("1997.90")).toBe(199_790);
    expect(reaisToCents("abc")).toBeNull();
    expect(reaisToCents("-5")).toBeNull();
  });

  it("aceita só inteiro sem separador", () => {
    expect(wholeNumber("4000")).toBe(4_000);
    expect(wholeNumber("4.000")).toBeNull();
    expect(wholeNumber("")).toBeNull();
  });
});
