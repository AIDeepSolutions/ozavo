import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { getFinopsSummary } from "./finops";
import { checkUsageAlerts, getPeriodUsage } from "./metering";
import { saveOperationSettings } from "./operation-settings";
import { checkPacingAllowed } from "./pacing";
import { getPlanSubscription, setPlanSubscription } from "./plans";
import { WATCH_SHORT_CALLS_TASK, activeCadenceBreakers, watchShortCalls } from "./short-calls";
import { provisionTenant, type ProvisionInput } from "./tenants";
import { withOrg } from "./with-org";

/**
 * Planos, franquia, concorrência e cadência contra o Postgres de verdade (Fase 3). O fuso é o
 * padrão (America/Sao_Paulo): os horários abaixo ficam no meio do dia, longe da virada.
 */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const at = (day: number, hour = 15, minute = 0): Date => new Date(Date.UTC(2030, 4, day, hour, minute));
const LINE = "+553133330000";

/** Uma ligação atendida de `seconds` segundos, começada em `start`. */
async function answeredCall(organizationId: string, start: Date, seconds: number, extra: { direction?: string; channel?: string; from?: string | null; status?: string; ended?: boolean } = {}): Promise<void> {
  await owner.pool.query(
    `insert into calls (organization_id, direction, channel, status, from_e164, started_at, answered_at, ended_at)
     values ($1, $2, $3, $4, $5, $6, $6, $7)`,
    [organizationId, extra.direction ?? "inbound", extra.channel ?? "phone", extra.status ?? "completed", extra.from ?? null, start, extra.ended === false ? null : new Date(start.getTime() + seconds * 1000)],
  );
}

const starter = { plan: "starter" as const, overageRule: "pause_outbound" as const, overagePriceCentsPerMinute: 0 };

describe("plano e franquia", () => {
  it("organização sem plano não é limitada nem alertada", async () => {
    const org = await createOrganization(app, "finops sem plano");
    await answeredCall(org, at(10), 400 * 60);
    await withOrg(app, org, async (q) => {
      expect(await getPlanSubscription(q)).toBeNull();
      expect(await getPeriodUsage(q, at(11))).toBeNull();
      expect(await checkUsageAlerts(q, at(11))).toEqual([]);
      expect(await checkPacingAllowed(q, at(11), { db: app, lineE164: LINE })).toEqual({ allowed: true });
    });
  });

  it("contrata pelo catálogo, registra a troca e mantém o ciclo ao trocar de plano", async () => {
    const org = await createOrganization(app, "finops plano");
    await withOrg(app, org, async (q) => {
      const first = await setPlanSubscription(q, starter, at(5), "2030-05-05");
      expect(first).toEqual({ plan: "starter", monthlyPriceCents: 49_700, includedMinutes: 300, overageRule: "pause_outbound", overagePriceCentsPerMinute: 0, maxConcurrentCalls: 2, cycleStartedOn: "2030-05-05" });
      const second = await setPlanSubscription(q, { ...starter, plan: "pro", overageRule: "bill_overage", overagePriceCentsPerMinute: 150 }, at(20), "2030-05-20");
      expect(second).toMatchObject({ plan: "pro", includedMinutes: 750, cycleStartedOn: "2030-05-05", overageRule: "bill_overage" });
    });
    const events = await owner.pool.query("select payload from organization_events where organization_id = $1 and kind = 'plan_changed' order by id", [org]);
    expect(events.rows.map((row: { payload: { from: string | null; to: string } }) => [row.payload.from, row.payload.to])).toEqual([
      [null, "starter"],
      ["starter", "pro"],
    ]);
  });

  it("mede a franquia pelas ligações atendidas do ciclo e avisa uma vez em 80% e uma em 100%", async () => {
    const org = await createOrganization(app, "finops alertas");
    await withOrg(app, org, (q) => setPlanSubscription(q, starter, at(5), "2030-05-05"));
    // Fora do ciclo, simulada e não atendida não contam.
    await answeredCall(org, at(2), 100 * 60);
    await answeredCall(org, at(10), 100 * 60, { channel: "simulated" });
    await owner.pool.query("insert into calls (organization_id, direction, channel, status, started_at) values ($1, 'inbound', 'phone', 'failed', $2)", [org, at(10)]);
    await answeredCall(org, at(10), 230 * 60);

    await withOrg(app, org, async (q) => {
      expect(await getPeriodUsage(q, at(11))).toMatchObject({ period: { start: "2030-05-05", end: "2030-06-05" }, consumedSeconds: 230 * 60, includedSeconds: 300 * 60, overageSeconds: 0, answeredCalls: 1 });
      expect(await checkUsageAlerts(q, at(11))).toEqual([]);
    });

    // Uma ligação em curso conta até agora: 230 + 10 = 240 minutos, 80%.
    await answeredCall(org, at(11, 15, 0), 0, { ended: false, status: "in_progress" });
    await withOrg(app, org, async (q) => {
      expect(await checkUsageAlerts(q, at(11, 15, 10))).toEqual([80]);
      expect(await checkUsageAlerts(q, at(11, 15, 11))).toEqual([]);
      expect(await checkUsageAlerts(q, at(11, 16, 10))).toEqual([100]);
      expect(await checkUsageAlerts(q, at(11, 16, 30))).toEqual([]);
    });

    const notices = await owner.pool.query("select body from notifications where organization_id = $1 order by created_at", [org]);
    expect(notices.rows).toHaveLength(2);
    expect(notices.rows[0].body).toMatch(/chegou a 80%/);
    expect(notices.rows[1].body).toMatch(/franquia do plano acabou/);
    const events = await owner.pool.query("select payload->>'threshold' as threshold from organization_events where organization_id = $1 and kind = 'plan_usage_alert' order by id", [org]);
    expect(events.rows.map((row: { threshold: string }) => row.threshold)).toEqual(["80", "100"]);
    const deliveries = await owner.pool.query("select count(*)::int as n from tasks where organization_id = $1 and kind = 'deliver_notification'", [org]);
    expect(deliveries.rows[0].n).toBe(2);
  });
});

describe("ligação de saída: franquia, concorrência e cadência", () => {
  it("franquia esgotada pausa a saída, e a regra de tarifar deixa passar", async () => {
    const org = await createOrganization(app, "finops franquia esgotada");
    await withOrg(app, org, (q) => setPlanSubscription(q, starter, at(5), "2030-05-05"));
    await answeredCall(org, at(10), 301 * 60);
    await withOrg(app, org, async (q) => {
      expect(await checkPacingAllowed(q, at(11), { db: app, lineE164: LINE })).toMatchObject({ allowed: false, code: "plan_quota_exhausted" });
      await setPlanSubscription(q, { ...starter, overageRule: "bill_overage", overagePriceCentsPerMinute: 150 }, at(11), "2030-05-11");
      expect(await checkPacingAllowed(q, at(11), { db: app, lineE164: LINE })).toEqual({ allowed: true });
      // A tentativa de ligar também confere a franquia: os dois avisos saíram.
      expect((await getFinopsSummary(q, at(11))).alerts.map((alert) => alert.threshold)).toEqual([80, 100]);
    });
  });

  it("segura no teto de chamadas do plano e no teto da conta do provedor de síntese", async () => {
    const org = await createOrganization(app, "finops concorrência");
    await withOrg(app, org, (q) => setPlanSubscription(q, starter, at(5), "2030-05-05"));
    await answeredCall(org, at(11), 0, { ended: false, status: "in_progress" });
    await withOrg(app, org, async (q) => {
      expect(await checkPacingAllowed(q, at(11, 15, 1), { db: app, lineE164: LINE })).toEqual({ allowed: true });
      // Com o teto do provedor em 1, a chamada em curso já ocupa a única vaga.
      await saveOperationSettings(q, { ttsConcurrencyLimit: 1, reducedCallsPerHour: 60, telephonyBrlPerMinute: null, usdBrlRate: null }, at(11));
      expect(await checkPacingAllowed(q, at(11, 15, 1), { db: app, lineE164: LINE })).toMatchObject({ allowed: false, code: "concurrency_limit", message: expect.stringContaining("speech provider") });
      await saveOperationSettings(q, { ttsConcurrencyLimit: null, reducedCallsPerHour: 60, telephonyBrlPerMinute: null, usdBrlRate: null }, at(11));
    });
    await answeredCall(org, at(11), 0, { ended: false, status: "in_progress" });
    await withOrg(app, org, async (q) => {
      expect(await checkPacingAllowed(q, at(11, 15, 1), { db: app, lineE164: LINE })).toMatchObject({ allowed: false, code: "concurrency_limit" });
    });
  });

  it("a ligação liberada põe a rotina das chamadas curtas na fila, uma só", async () => {
    const org = await createOrganization(app, "finops corrente");
    await withOrg(app, org, async (q) => {
      await checkPacingAllowed(q, at(11), { db: app, lineE164: LINE });
      await checkPacingAllowed(q, at(11, 15, 5), { db: app, lineE164: LINE });
    });
    const tasks = await owner.pool.query("select run_at from tasks where organization_id = $1 and kind = $2", [org, WATCH_SHORT_CALLS_TASK]);
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0].run_at).toEqual(at(11, 15, 15));
  });

  it("75% de mais de 1.000 ligações curtas no dia reduz a cadência da linha e avisa uma vez", async () => {
    const org = await createOrganization(app, "finops chamadas curtas");
    const other = "+553144440000";
    // 1.200 ligações de saída hoje pela linha: 950 atendidas com 3 s, 250 com 60 s. Espalhadas em 4 horas.
    await owner.pool.query(
      `insert into calls (organization_id, direction, channel, status, from_e164, started_at, answered_at, ended_at)
       select $1, 'outbound', 'phone', 'completed', $2, s.start, s.start, s.start + make_interval(secs => case when n <= 950 then 3 else 60 end)
         from generate_series(1, 1200) n cross join lateral (select $3::timestamptz + make_interval(secs => n * 12) as start) s`,
      [org, LINE, at(11, 12, 0)],
    );
    // A outra linha tem volume alto e ligações longas: não dispara.
    await owner.pool.query(
      `insert into calls (organization_id, direction, channel, status, from_e164, started_at, answered_at, ended_at)
       select $1, 'outbound', 'phone', 'completed', $2, $3::timestamptz, $3::timestamptz, $3::timestamptz + interval '60 seconds' from generate_series(1, 1100)`,
      [org, other, at(11, 12, 0)],
    );
    const now = at(11, 16, 30);
    await withOrg(app, org, async (q) => {
      expect(await watchShortCalls(q, now)).toEqual([{ lineE164: LINE, total: 1200, short: 950 }]);
      expect(await watchShortCalls(q, now)).toEqual([]);
      expect(await activeCadenceBreakers(q, now)).toMatchObject([{ lineE164: LINE, totalCalls: 1200, shortCalls: 950 }]);
      // Na última hora a linha fez bem mais que as 60 ligações da cadência reduzida.
      expect(await checkPacingAllowed(q, now, { db: app, lineE164: LINE })).toMatchObject({ allowed: false, code: "cadence_reduced" });
      expect(await checkPacingAllowed(q, now, { db: app, lineE164: other })).toEqual({ allowed: true });
      // Uma hora depois sem ligar, a linha volta a caber na cadência reduzida.
      expect(await checkPacingAllowed(q, at(11, 17, 30), { db: app, lineE164: LINE })).toEqual({ allowed: true });
      // No dia seguinte a redução não vale mais.
      expect(await activeCadenceBreakers(q, at(12))).toEqual([]);
    });
    const notices = await owner.pool.query("select body from notifications where organization_id = $1", [org]);
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0].body).toMatch(/ALERTA CRÍTICO: A linha \+553133330000 fez 1200 ligações de saída hoje e 79% delas/);
    const events = await owner.pool.query("select payload from organization_events where organization_id = $1 and kind = 'cadence_reduced'", [org]);
    expect(events.rows).toHaveLength(1);
  });
});

describe("provisionamento", () => {
  const input = (ref: string, code: string): ProvisionInput => ({
    source: "finops-test",
    externalRef: ref,
    company: { legalName: `Empresa ${ref} Ltda`, tradeName: null, cnpj: null },
    owner: { name: "Dona", email: `${ref}@finops.example.com` },
    plan: { code, monthlyMinutes: null },
    agent: { name: "Nico", personaName: "Nico", voiceId: null, basePrompt: "", instructions: "", greeting: null, engine: "simulated", tools: [] },
    secrets: [],
    requestedBy: "00000000-0000-4000-8000-000000000000",
  });

  it("empresa provisionada com plano do catálogo já nasce com a franquia; código de fora fica sem plano", async () => {
    const pro = await provisionTenant(app, input("prov-pro", "pro"), at(7));
    if (!("created" in pro) || !pro.created) throw new Error("tenant was not provisioned");
    expect(await withOrg(app, pro.organizationId, (q) => getPlanSubscription(q))).toEqual({
      plan: "pro",
      monthlyPriceCents: 99_700,
      includedMinutes: 750,
      overageRule: "pause_outbound",
      overagePriceCentsPerMinute: 0,
      maxConcurrentCalls: 3,
      cycleStartedOn: "2030-05-07",
    });
    const other = await provisionTenant(app, input("prov-outro", "enterprise-2030"), at(7));
    if (!("created" in other) || !other.created) throw new Error("tenant was not provisioned");
    expect(await withOrg(app, other.organizationId, (q) => getPlanSubscription(q))).toBeNull();
  });
});

describe("resumo de FinOps", () => {
  it("junta consumo, caracteres de síntese, custo e margem do ciclo", async () => {
    const org = await createOrganization(app, "finops resumo");
    await withOrg(app, org, async (q) => {
      await setPlanSubscription(q, starter, at(5), "2030-05-05");
      await saveOperationSettings(q, { ttsConcurrencyLimit: 4, reducedCallsPerHour: 60, telephonyBrlPerMinute: 0.06, usdBrlRate: 5 }, at(5));
    });
    await answeredCall(org, at(10), 100 * 60);
    const call = await owner.pool.query("select id from calls where organization_id = $1", [org]);
    // US$ 3,00 de provedores e 12.000 caracteres de síntese.
    await owner.pool.query(
      "insert into usage_ledger (organization_id, call_id, engine, seconds, cost_cents, cost_microcents, tts_characters, at) values ($1, $2, 'deepgram-openrouter-cartesia', 6000, 300, 300000000, 12000, $3)",
      [org, call.rows[0].id, at(10)],
    );
    const summary = await withOrg(app, org, (q) => getFinopsSummary(q, at(11)));
    expect(summary).toMatchObject({
      period: { start: "2030-05-05", end: "2030-06-05" },
      consumedSeconds: 6000,
      includedSeconds: 18_000,
      overageSeconds: 0,
      answeredCalls: 1,
      ttsCharacters: 12_000,
      providerCostUsdCents: 300,
      costTargetCentsPerMinute: 28,
      byDay: [{ day: "2030-05-10", seconds: 6000, calls: 1, ttsCharacters: 12_000, providerCostUsdCents: 300 }],
    });
    // R$ 15,00 de provedores + R$ 6,00 de telefonia em 100 minutos: R$ 0,21 por minuto.
    expect(summary.margin).toMatchObject({ revenueCents: 49_700, providerCostCents: 1500, telephonyCostCents: 600, variableCostCents: 2100, grossMarginCents: 47_600, costPerMinuteCents: 21, withinTarget: true });
  });
});
