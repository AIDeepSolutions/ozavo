import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { checkUsageAlerts, localDay } from "./metering";
import { MIRROR_ALERT_TASK, mirrorAlertToPlatform, type PlatformAlertPayload } from "./platform-alerts";
import { setPlanSubscription } from "./plans";
import { withOrg, withSystem } from "./with-org";

/** O alerta crítico de uma empresa cliente chega à plataforma, uma vez, e nunca a outra empresa. */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const now = new Date(Date.UTC(2032, 4, 10, 15));
let platform: string;
let tenant: string;
let neighbour: string;

const rows = (sql: string, params: unknown[]) => withSystem(app, (q) => q.many<Record<string, unknown>>(sql, params));
const usage = (threshold: number): PlatformAlertPayload => ({ kind: "usage", threshold, periodStart: "2032-05-01", consumedSeconds: 18_000, includedSeconds: 18_000 });

beforeAll(async () => {
  platform = await createOrganization(app, "plataforma dos alertas");
  await withSystem(app, (q) => q.exec("update organizations set platform = true where id = $1", [platform]));
  tenant = await createOrganization(app, "Clínica dos Alertas");
  neighbour = await createOrganization(app, "vizinha dos alertas");
});

describe("na empresa", () => {
  it("o alerta de franquia põe na fila, na mesma transação, a tarefa que leva o alerta à plataforma", async () => {
    await withOrg(app, tenant, async (q) => {
      const { day } = await localDay(q, now);
      await setPlanSubscription(q, { plan: "starter", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0, cycleStartedOn: "2032-05-01" }, now, day);
    });
    await owner.pool.query(
      "insert into calls (organization_id, direction, channel, status, started_at, answered_at, ended_at) values ($1, 'inbound', 'phone', 'completed', $2, $2, $3)",
      [tenant, new Date(Date.UTC(2032, 4, 5, 15)), new Date(Date.UTC(2032, 4, 5, 15) + 300 * 60_000)],
    );
    expect(await withOrg(app, tenant, (q) => checkUsageAlerts(q, now))).toEqual([80, 100]);
    const queued = await rows("select payload from tasks where organization_id = $1 and kind = $2 order by id", [tenant, MIRROR_ALERT_TASK]);
    expect(queued.map((row) => (row.payload as { threshold: number }).threshold).sort()).toEqual([100, 80]);
  });
});

describe("mirrorAlertToPlatform", () => {
  it("avisa a plataforma com o nome da empresa e registra tenant_critical_alert; repetir não dobra", async () => {
    expect(await mirrorAlertToPlatform(app, tenant, usage(100), now)).toBeGreaterThanOrEqual(1);
    expect(await mirrorAlertToPlatform(app, tenant, usage(100), now)).toBe(0);
    const notices = await rows("select body from notifications where organization_id = $1 and channel = 'panel'", [platform]);
    expect(notices.filter((row) => String(row.body).includes("Clínica dos Alertas esgotou a franquia"))).toHaveLength(1);
    const events = await rows("select payload from organization_events where organization_id = $1 and kind = 'tenant_critical_alert'", [platform]);
    expect(events.filter((row) => (row.payload as { tenantId: string }).tenantId === tenant)).toHaveLength(1);
  });

  it("o disjuntor também chega; outra empresa não recebe nada", async () => {
    const breaker: PlatformAlertPayload = { kind: "breaker", lineE164: "+553133330000", totalCalls: 1_200, shortCalls: 950, reducedCallsPerHour: 20, day: "2032-05-10" };
    await mirrorAlertToPlatform(app, tenant, breaker, now);
    const notices = await rows("select body from notifications where organization_id = $1", [platform]);
    expect(notices.some((row) => String(row.body).includes("ALERTA CRÍTICO: Clínica dos Alertas fez 1200 ligações"))).toBe(true);
    expect(await rows("select 1 from notifications where organization_id = $1", [neighbour])).toEqual([]);
    expect(await rows("select 1 from organization_events where organization_id = $1 and kind = 'tenant_critical_alert'", [neighbour])).toEqual([]);
  });

  it("o alerta da própria plataforma ou de empresa que não existe não é espelhado", async () => {
    expect(await mirrorAlertToPlatform(app, platform, usage(80), now)).toBe(0);
    expect(await mirrorAlertToPlatform(app, "00000000-0000-4000-8000-000000000000", usage(80), now)).toBe(0);
  });
});
