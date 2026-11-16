import { withSystem } from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createOrganization, createUser, startPanel } from "../../../../test/kit";
import { GET as getPlan, PUT as putPlan } from "./finops/plan/route";
import { GET as getSummary } from "./finops/route";
import { GET as getLimits, PUT as putLimits } from "./finops/settings/route";
import { GET as getSetting, PUT as putSetting } from "./settings/[key]/route";

const panel = startPanel();
let org: string;
let owner: string;
let operator: string;
let tenantOwner: string;
let tenantAdmin: string;

// Plano e limites são comerciais: só a organização que administra a instalação (`platform`) os grava.
beforeAll(async () => {
  org = await createOrganization(panel.app, "finops api");
  await withSystem(panel.app, (q) => q.exec("update organizations set platform = true where id = $1", [org]));
  owner = (await createUser(panel.app, org, "owner")).cookie;
  operator = (await createUser(panel.app, org, "operator")).cookie;
  const tenant = await createOrganization(panel.app, "finops tenant");
  tenantOwner = (await createUser(panel.app, tenant, "owner")).cookie;
  tenantAdmin = (await createUser(panel.app, tenant, "admin")).cookie;
});
// O teto do provedor da plataforma vale para a instalação inteira: o banco é de todos os testes.
afterAll(async () => {
  await withOrg(panel.app, org, (q) => q.exec("update organizations set platform = false where id = $1", [org]));
  await panel.close();
});

const limits = { ttsConcurrencyLimit: 4, reducedCallsPerHour: 30, telephonyBrlPerMinute: 0.06, usdBrlRate: 5.4 };

describe("FinOps pela API", () => {
  it("sem plano, o resumo vem do mês do calendário, sem franquia", async () => {
    const summary = await call(getSummary, { cookie: operator });
    expect(summary.data).toMatchObject({ subscription: null, includedSeconds: null, consumedSeconds: 0, period: { start: "2026-03-01", end: "2026-04-01" }, alerts: [], cadenceBreakers: [] });
    expect((await call(getPlan, { cookie: operator })).data).toMatchObject({ subscription: null, catalog: { starter: { monthlyPriceCents: 49_700, includedMinutes: 300 } } });
  });

  it("operador lê, mas não troca o plano nem os limites", async () => {
    expect(await call(putPlan, { cookie: operator, method: "PUT", body: { plan: "pro", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 } })).toMatchObject({ status: 403, code: "forbidden" });
    expect(await call(putLimits, { cookie: operator, method: "PUT", body: limits })).toMatchObject({ status: 403, code: "forbidden" });
    expect((await call(getLimits, { cookie: operator })).data).toEqual({ ttsConcurrencyLimit: null, reducedCallsPerHour: 60, telephonyBrlPerMinute: null, usdBrlRate: null });
  });

  it("dono ou admin de uma empresa comum não troca o próprio plano nem afrouxa os limites", async () => {
    const custom = { plan: "custom", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0, monthlyPriceCents: 0, includedMinutes: 1_000_000, maxConcurrentCalls: 500 };
    for (const cookie of [tenantOwner, tenantAdmin]) {
      expect(await call(putPlan, { cookie, method: "PUT", body: custom })).toMatchObject({ status: 403, code: "platform_only" });
      expect(await call(putPlan, { cookie, method: "PUT", body: { plan: "scale", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 } })).toMatchObject({ status: 403, code: "platform_only" });
      expect(await call(putLimits, { cookie, method: "PUT", body: { ...limits, reducedCallsPerHour: 10_000 } })).toMatchObject({ status: 403, code: "platform_only" });
    }
    // A leitura continua: a tela da empresa mostra o plano e os limites, sem poder gravar.
    expect((await call(getPlan, { cookie: tenantOwner })).data).toMatchObject({ subscription: null, platform: false });
    expect((await call(getLimits, { cookie: tenantOwner })).data).toEqual({ ttsConcurrencyLimit: null, reducedCallsPerHour: 60, telephonyBrlPerMinute: null, usdBrlRate: null });
    expect((await call(getPlan, { cookie: owner })).data).toMatchObject({ platform: true });
  });

  it("dono contrata o plano do catálogo, e o ciclo começa hoje no calendário da organização", async () => {
    const saved = await call(putPlan, { cookie: owner, method: "PUT", body: { plan: "growth", overageRule: "bill_overage", overagePriceCentsPerMinute: 120, monthlyPriceCents: 1 } });
    expect(saved.data).toMatchObject({
      subscription: { plan: "growth", monthlyPriceCents: 149_700, includedMinutes: 1500, overageRule: "bill_overage", overagePriceCentsPerMinute: 120, maxConcurrentCalls: 4, cycleStartedOn: "2026-03-01" },
    });
    expect((await call(getSummary, { cookie: owner })).data).toMatchObject({ subscription: { plan: "growth" }, includedSeconds: 90_000, period: { start: "2026-03-01", end: "2026-04-01" }, margin: { revenueCents: 149_700, variableCostCents: null } });
  });

  it("o plano Personalizado exige preço, franquia e chamadas simultâneas", async () => {
    const base = { plan: "custom", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 };
    expect(await call(putPlan, { cookie: owner, method: "PUT", body: base })).toMatchObject({ status: 400, code: "validation_error" });
    const saved = await call(putPlan, { cookie: owner, method: "PUT", body: { ...base, monthlyPriceCents: 350_000, includedMinutes: 6000, maxConcurrentCalls: 20, cycleStartedOn: "2026-02-10" } });
    expect(saved.data).toMatchObject({ subscription: { plan: "custom", monthlyPriceCents: 350_000, includedMinutes: 6000, maxConcurrentCalls: 20, cycleStartedOn: "2026-02-10" } });
  });

  it("dono grava os limites de operação, e o resumo passa a ter custo de telefonia", async () => {
    expect((await call(putLimits, { cookie: owner, method: "PUT", body: limits })).data).toEqual(limits);
    expect(await call(putLimits, { cookie: owner, method: "PUT", body: { ...limits, ttsConcurrencyLimit: 0 } })).toMatchObject({ status: 400, code: "validation_error" });
    expect((await call(getSummary, { cookie: owner })).data).toMatchObject({ settings: limits, margin: { providerCostCents: 0, telephonyCostCents: 0, variableCostCents: 0 } });
  });

  it("a própria empresa escolhe por onde mais sai o aviso de franquia, e o padrão é só o painel", async () => {
    expect((await call(getSetting, { cookie: tenantOwner, params: { key: "plan.alert_whatsapp" } })).data).toEqual({ key: "plan.alert_whatsapp", value: false });
    expect((await call(putSetting, { cookie: tenantOwner, method: "PUT", params: { key: "plan.alert_whatsapp" }, body: { value: true } })).data).toMatchObject({ value: true });
    expect((await call(putSetting, { cookie: tenantAdmin, method: "PUT", params: { key: "plan.alert_webhook" }, body: { value: "n8n" } })).data).toMatchObject({ value: "n8n" });
    expect(await call(putSetting, { cookie: tenantOwner, method: "PUT", params: { key: "plan.alert_webhook" }, body: { value: "" } })).toMatchObject({ status: 400, code: "validation_error" });
    expect(await call(putSetting, { cookie: operator, method: "PUT", params: { key: "plan.alert_whatsapp" }, body: { value: true } })).toMatchObject({ status: 403 });
  });
});
