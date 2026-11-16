import { describe, expect, it } from "vitest";
import { COST_TARGET_CENTS_PER_MINUTE, computeMargin, type MarginInput } from "./finops";
import { reachedThresholds } from "./metering";
import { operationSettingsInput } from "./operation-settings";
import { concurrencyAllows } from "./pacing";
import { PLAN_CATALOG, billingPeriod, planSubscriptionInput, resolvePlan } from "./plans";
import { SHORT_CALL_MIN_DAILY_CALLS, shortCallsTripped } from "./short-calls";

describe("catálogo de planos", () => {
  it("traz preço e franquia da especificação comercial", () => {
    expect(PLAN_CATALOG.starter).toMatchObject({ monthlyPriceCents: 49_700, includedMinutes: 300 });
    expect(PLAN_CATALOG.pro).toMatchObject({ monthlyPriceCents: 99_700, includedMinutes: 750 });
    expect(PLAN_CATALOG.growth).toMatchObject({ monthlyPriceCents: 149_700, includedMinutes: 1500 });
    expect(PLAN_CATALOG.scale).toMatchObject({ monthlyPriceCents: 199_700, includedMinutes: 2500 });
  });

  it("plano do catálogo ignora valores mandados; o Personalizado exige os três", () => {
    const base = { overageRule: "pause_outbound" as const, overagePriceCentsPerMinute: 0 };
    const pro = planSubscriptionInput.parse({ ...base, plan: "pro", monthlyPriceCents: 1, includedMinutes: 1, maxConcurrentCalls: 99 });
    expect(resolvePlan(pro)).toEqual(PLAN_CATALOG.pro);

    const missing = planSubscriptionInput.safeParse({ ...base, plan: "custom", monthlyPriceCents: 250_000 });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path.join("."))).toEqual(["includedMinutes", "maxConcurrentCalls"]);

    const custom = planSubscriptionInput.parse({ ...base, plan: "custom", monthlyPriceCents: 250_000, includedMinutes: 4000, maxConcurrentCalls: 20 });
    expect(resolvePlan(custom)).toEqual({ monthlyPriceCents: 250_000, includedMinutes: 4000, maxConcurrentCalls: 20 });
  });
});

describe("ciclo de cobrança", () => {
  it("renova todo mês no dia em que começou", () => {
    expect(billingPeriod("2026-11-10", "2026-11-10")).toEqual({ start: "2026-11-10", end: "2026-12-10" });
    expect(billingPeriod("2026-11-10", "2026-12-09")).toEqual({ start: "2026-11-10", end: "2026-12-10" });
    expect(billingPeriod("2026-11-10", "2026-12-10")).toEqual({ start: "2026-12-10", end: "2027-01-10" });
    expect(billingPeriod("2026-11-10", "2027-03-02")).toEqual({ start: "2027-02-10", end: "2027-03-10" });
  });

  it("quem começou no dia 31 renova no último dia dos meses mais curtos", () => {
    expect(billingPeriod("2026-01-31", "2026-02-27")).toEqual({ start: "2026-01-31", end: "2026-02-28" });
    expect(billingPeriod("2026-01-31", "2026-02-28")).toEqual({ start: "2026-02-28", end: "2026-03-31" });
    expect(billingPeriod("2026-01-31", "2026-04-30")).toEqual({ start: "2026-04-30", end: "2026-05-31" });
    // Ano bissexto.
    expect(billingPeriod("2028-01-31", "2028-02-29")).toEqual({ start: "2028-02-29", end: "2028-03-31" });
  });

  it("antes do começo, vale o primeiro ciclo", () => {
    expect(billingPeriod("2026-11-10", "2026-10-01")).toEqual({ start: "2026-11-10", end: "2026-12-10" });
  });
});

describe("alertas da franquia", () => {
  const included = 300 * 60;
  it("avisa em 80% e em 100%", () => {
    expect(reachedThresholds(included * 0.79, included)).toEqual([]);
    expect(reachedThresholds(included * 0.8, included)).toEqual([80]);
    expect(reachedThresholds(included - 1, included)).toEqual([80]);
    expect(reachedThresholds(included, included)).toEqual([80, 100]);
    expect(reachedThresholds(included * 3, included)).toEqual([80, 100]);
  });

  it("franquia zero não tem do que avisar", () => {
    expect(reachedThresholds(500, 0)).toEqual([]);
  });
});

describe("semáforo de chamadas simultâneas", () => {
  it("segura no teto do plano", () => {
    expect(concurrencyAllows({ tenantActive: 1, globalActive: 1, tenantLimit: 2, providerLimit: null })).toBe("ok");
    expect(concurrencyAllows({ tenantActive: 2, globalActive: 2, tenantLimit: 2, providerLimit: null })).toBe("tenant");
  });

  it("segura no teto da conta do provedor, contando as chamadas de todas as organizações", () => {
    expect(concurrencyAllows({ tenantActive: 1, globalActive: 3, tenantLimit: 8, providerLimit: 4 })).toBe("ok");
    expect(concurrencyAllows({ tenantActive: 1, globalActive: 4, tenantLimit: 8, providerLimit: 4 })).toBe("provider");
    // Chamada que o processo ainda não registrou conta pelo banco.
    expect(concurrencyAllows({ tenantActive: 4, globalActive: 0, tenantLimit: null, providerLimit: 4 })).toBe("provider");
  });

  it("sem teto, não limita", () => {
    expect(concurrencyAllows({ tenantActive: 500, globalActive: 900, tenantLimit: null, providerLimit: null })).toBe("ok");
  });
});

describe("disjuntor de chamadas curtas", () => {
  it("só dispara acima de 1.000 ligações no dia e com 75% delas curtas", () => {
    expect(shortCallsTripped({ total: SHORT_CALL_MIN_DAILY_CALLS, short: SHORT_CALL_MIN_DAILY_CALLS })).toBe(false);
    expect(shortCallsTripped({ total: 1001, short: 750 })).toBe(false);
    expect(shortCallsTripped({ total: 1001, short: 751 })).toBe(true);
    expect(shortCallsTripped({ total: 2000, short: 1500 })).toBe(true);
    expect(shortCallsTripped({ total: 2000, short: 1499 })).toBe(false);
    expect(shortCallsTripped({ total: 50, short: 50 })).toBe(false);
  });
});

describe("margem", () => {
  const base: MarginInput = {
    monthlyPriceCents: 49_700,
    overageRule: "pause_outbound",
    overagePriceCentsPerMinute: 150,
    consumedSeconds: 300 * 60,
    overageSeconds: 0,
    // US$ 9,00 de provedores.
    providerCostUsdMicrocents: 900 * 1_000_000,
    usdBrlRate: 5,
    telephonyBrlPerMinute: 0.06,
  };

  it("soma provedores (convertidos) e telefonia, e compara o custo por minuto com a meta", () => {
    const margin = computeMargin(base);
    expect(margin.providerCostCents).toBe(4500);
    expect(margin.telephonyCostCents).toBe(1800);
    expect(margin.variableCostCents).toBe(6300);
    expect(margin.revenueCents).toBe(49_700);
    expect(margin.grossMarginCents).toBe(43_400);
    expect(margin.grossMarginPercent).toBe(87.32);
    expect(margin.costPerMinuteCents).toBe(21);
    expect(margin.withinTarget).toBe(true);
    expect(COST_TARGET_CENTS_PER_MINUTE).toBe(28);
  });

  it("acima da meta de custo por minuto, diz que está acima", () => {
    const margin = computeMargin({ ...base, telephonyBrlPerMinute: 0.2 });
    expect(margin.costPerMinuteCents).toBe(35);
    expect(margin.withinTarget).toBe(false);
  });

  it("só tarifa excedente na regra de tarifar, por minuto começado", () => {
    expect(computeMargin({ ...base, overageSeconds: 61 }).overageRevenueCents).toBe(0);
    const billed = computeMargin({ ...base, overageRule: "bill_overage", overageSeconds: 61 });
    expect(billed.overageRevenueCents).toBe(300);
    expect(billed.revenueCents).toBe(50_000);
  });

  it("sem cotação ou sem custo de telefonia, a margem fica sem número em vez de errada", () => {
    const noRate = computeMargin({ ...base, usdBrlRate: null });
    expect(noRate).toMatchObject({ providerCostCents: null, telephonyCostCents: 1800, variableCostCents: null, grossMarginCents: null, costPerMinuteCents: null, withinTarget: null });
    const noTelephony = computeMargin({ ...base, telephonyBrlPerMinute: null });
    expect(noTelephony).toMatchObject({ providerCostCents: 4500, telephonyCostCents: null, variableCostCents: null, grossMarginPercent: null });
  });

  it("sem minuto falado não há custo por minuto", () => {
    expect(computeMargin({ ...base, consumedSeconds: 0 })).toMatchObject({ costPerMinuteCents: null, withinTarget: null });
  });
});

describe("limites de operação", () => {
  it("aceita vazio (não informado) e recusa teto zero", () => {
    expect(operationSettingsInput.parse({ ttsConcurrencyLimit: null, reducedCallsPerHour: 60, telephonyBrlPerMinute: null, usdBrlRate: null }).ttsConcurrencyLimit).toBeNull();
    expect(operationSettingsInput.safeParse({ ttsConcurrencyLimit: 0, reducedCallsPerHour: 60, telephonyBrlPerMinute: null, usdBrlRate: null }).success).toBe(false);
    expect(operationSettingsInput.safeParse({ ttsConcurrencyLimit: 4, reducedCallsPerHour: 60, telephonyBrlPerMinute: 0.06, usdBrlRate: 0 }).success).toBe(false);
  });
});
