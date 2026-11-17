import { describe, expect, it } from "vitest";
import { computeMargin } from "./finops";
import { criticalOf, totalsOf, type PlatformFinopsTenant } from "./platform-finops";

const at = (day: number): Date => new Date(Date.UTC(2030, 5, day, 15));
const tenant = (extra: Partial<PlatformFinopsTenant> & { usdBrlRate?: number | null }): PlatformFinopsTenant => {
  const consumedSeconds = extra.consumedSeconds ?? 600;
  const monthlyPriceCents = extra.monthlyPriceCents ?? 49_700;
  return {
    organizationId: crypto.randomUUID(),
    name: "Empresa",
    status: "active",
    plan: "starter",
    period: { start: "2030-06-01", end: "2030-07-01" },
    consumedSeconds,
    includedSeconds: 18_000,
    answeredCalls: 3,
    ttsCharacters: 1_000,
    providerCostUsdCents: 200,
    monthlyPriceCents,
    margin: computeMargin({ monthlyPriceCents, overageRule: "pause_outbound", overagePriceCentsPerMinute: 0, consumedSeconds, overageSeconds: 0, providerCostUsdMicrocents: 200_000_000, usdBrlRate: extra.usdBrlRate === undefined ? 5 : extra.usdBrlRate, telephonyBrlPerMinute: 0.05 }),
    ratesFrom: "platform",
    alerts: [],
    cadenceBreakers: [],
    ...extra,
  };
};

describe("totalsOf", () => {
  it("soma receita e custo, e o MRR conta só empresas ativas", () => {
    const totals = totalsOf([tenant({}), tenant({ status: "suspended", monthlyPriceCents: 99_700 })]);
    expect(totals).toMatchObject({ tenants: 2, activeTenants: 1, mrrCents: 49_700, consumedSeconds: 1_200 });
    // Cada uma: 2 dólares a 5 reais (1.000) e 10 minutos a 5 centavos (50).
    expect(totals.variableCostCents).toBe(2_100);
    expect(totals.grossMarginCents).toBe(totals.revenueCents - 2_100);
  });

  it("sem cotação para quem consumiu, o custo consolidado fica desconhecido; quem não consumiu não atrapalha", () => {
    expect(totalsOf([tenant({}), tenant({ usdBrlRate: null })]).variableCostCents).toBeNull();
    const idle = tenant({ usdBrlRate: null, consumedSeconds: 0, providerCostUsdCents: 0 });
    expect(totalsOf([tenant({}), idle]).variableCostCents).toBe(1_050);
  });
});

describe("criticalOf", () => {
  it("mostra só o maior limiar de franquia de cada empresa e põe 100% antes do disjuntor e do 80%", () => {
    const full = tenant({ name: "Cheia", alerts: [{ threshold: 80, at: at(2) }, { threshold: 100, at: at(5) }] });
    const near = tenant({ name: "Quase", alerts: [{ threshold: 80, at: at(9) }] });
    const breaker = tenant({ name: "Disjuntor", cadenceBreakers: [{ lineE164: "+553133330000", totalCalls: 1_200, shortCalls: 1_000, trippedAt: at(3) }] });
    expect(criticalOf([near, breaker, full]).map((alert) => [alert.name, alert.kind, alert.threshold])).toEqual([
      ["Cheia", "usage", 100],
      ["Disjuntor", "breaker", null],
      ["Quase", "usage", 80],
    ]);
  });
});
