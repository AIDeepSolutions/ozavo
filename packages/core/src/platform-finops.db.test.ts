import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { checkUsageAlerts } from "./metering";
import { saveOperationSettings, OPERATION_DEFAULTS } from "./operation-settings";
import { getPlatformFinops } from "./platform-finops";
import { PlatformOnlyError, createPlatformTenant, type PanelTenantInput } from "./platform-tenants";
import { withOrg, withSystem } from "./with-org";

/** O FinOps da plataforma: por empresa e consolidado, só para a organização da plataforma. */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const now = new Date(Date.UTC(2031, 2, 10, 15));
let platform: string;
let busy: string;
let idle: string;

const agent = { name: "Nico", personaName: "Nico", voiceId: null, basePrompt: "", instructions: "Atenda.", greeting: null, engine: "simulated", tools: [] };
const form = (name: string): PanelTenantInput => ({ requestId: randomUUID(), companyName: name, owner: { name: "Dona", email: `dona-${randomUUID()}@example.test` }, plan: "starter", initialStatus: "active", agent });

beforeAll(async () => {
  // Banco compartilhado com outros testes: a plataforma deste arquivo é só uma entre as que existirem.
  platform = await createOrganization(app, "plataforma do finops");
  await withSystem(app, (q) => q.exec("update organizations set platform = true where id = $1", [platform]));
  const actor = randomUUID();
  await withSystem(app, (q) => q.exec("insert into users (id, organization_id, email, name, role, password_hash) values ($1, $2, $3, 'Admin', 'owner', 'h')", [actor, platform, `fin-${actor}@example.test`]));
  await withOrg(app, platform, (q) => saveOperationSettings(q, { ...OPERATION_DEFAULTS, usdBrlRate: 5, telephonyBrlPerMinute: 0.05 }, now));
  const created = async (name: string): Promise<string> => {
    const result = await createPlatformTenant(app, platform, actor, form(name), new Date(Date.UTC(2031, 2, 1, 15)));
    if ("refused" in result) throw new Error("refused");
    return result.organizationId;
  };
  busy = await created(`Ocupada ${randomUUID().slice(0, 4)}`);
  idle = await created(`Parada ${randomUUID().slice(0, 4)}`);
  // 250 minutos atendidos (83% da franquia do Starter) e 1 dólar de provedor no extrato.
  const start = new Date(Date.UTC(2031, 2, 5, 15));
  const call = await owner.pool.query<{ id: string }>(
    "insert into calls (organization_id, direction, channel, status, started_at, answered_at, ended_at) values ($1, 'inbound', 'phone', 'completed', $2, $2, $3) returning id",
    [busy, start, new Date(start.getTime() + 250 * 60_000)],
  );
  await owner.pool.query("insert into usage_ledger (organization_id, call_id, engine, cost_microcents, tts_characters, at) values ($1, $2, 'simulated', 100000000, 500, $3)", [busy, call.rows[0]?.id, start]);
  await withOrg(app, busy, (q) => checkUsageAlerts(q, now));
});

describe("getPlatformFinops", () => {
  it("por empresa: minutos contra a franquia, custo com a cotação da plataforma e o alerta de 80%", async () => {
    const finops = await getPlatformFinops(app, platform, now);
    const row = finops.tenants.find((tenant) => tenant.organizationId === busy);
    expect(row).toMatchObject({ plan: "starter", consumedSeconds: 250 * 60, includedSeconds: 300 * 60, ratesFrom: "platform", status: "active" });
    // Telefonia: 250 minutos a R$ 0,05.
    expect(row?.margin.telephonyCostCents).toBe(1_250);
    // Provedores: 1 dólar a R$ 5,00.
    expect(row?.margin.providerCostCents).toBe(500);
    expect(row?.margin.variableCostCents).toBe(1_750);
    expect(row).toMatchObject({ providerCostUsdCents: 100, ttsCharacters: 500 });
    expect(finops.critical.find((alert) => alert.organizationId === busy)).toMatchObject({ kind: "usage", threshold: 80 });
    expect(finops.tenants.find((tenant) => tenant.organizationId === idle)).toMatchObject({ consumedSeconds: 0, alerts: [] });
    expect(finops.tenants.some((tenant) => tenant.organizationId === platform)).toBe(false);
    expect(finops.totals.mrrCents).toBeGreaterThanOrEqual(2 * 49_700);
  });

  it("empresa parada (sem plano e sem nada a medir) entra com zero e o mês do calendário dela", async () => {
    const quiet = await createOrganization(app, "empresa sem plano e sem uso");
    const row = (await getPlatformFinops(app, platform, now)).tenants.find((tenant) => tenant.organizationId === quiet);
    expect(row).toMatchObject({ plan: null, period: { start: "2031-03-01", end: "2031-04-01" }, consumedSeconds: 0, includedSeconds: null, answeredCalls: 0, monthlyPriceCents: 0, ratesFrom: "platform" });
    expect(row?.margin).toMatchObject({ revenueCents: 0, variableCostCents: 0 });
  });

  it("empresa cliente não lê", async () => {
    await expect(getPlatformFinops(app, busy, now)).rejects.toBeInstanceOf(PlatformOnlyError);
  });
});
