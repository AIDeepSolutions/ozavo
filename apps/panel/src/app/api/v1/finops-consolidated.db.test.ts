import { withSystem } from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createOrganization, createUser, insert, startPanel } from "../../../../test/kit";
import { GET as consolidated } from "./finops/consolidated/route";

/** FinOps consolidado: a plataforma vê o consumo de todas as empresas; uma empresa cliente não (auditoria A23). */
const panel = startPanel();
let platformOwner: string;
let platformOperator: string;
let tenantOwner: string;
let tenant: string;

beforeAll(async () => {
  const platform = await createOrganization(panel.app, "consolidado plataforma");
  await withSystem(panel.app, (q) => q.exec("update organizations set platform = true where id = $1", [platform]));
  platformOwner = (await createUser(panel.app, platform, "owner")).cookie;
  platformOperator = (await createUser(panel.app, platform, "operator")).cookie;
  tenant = await createOrganization(panel.app, "consolidado cliente");
  tenantOwner = (await createUser(panel.app, tenant, "owner")).cookie;
  const answered = new Date("2026-03-01T12:00:00Z");
  await insert(panel.app, tenant, "insert into calls (organization_id, direction, channel, status, started_at, answered_at, ended_at) values ($1, 'inbound', 'phone', 'completed', $2, $2, $3) returning id", [
    tenant, answered, new Date(answered.getTime() + 120_000),
  ]);
});
afterAll(() => panel.close());

describe("GET /api/v1/finops/consolidated", () => {
  it("a plataforma vê cada empresa e os totais do mês", async () => {
    const result = await call(consolidated, { cookie: platformOwner });
    expect(result.status).toBe(200);
    const data = result.data as { period: { start: string }; organizations: Array<{ organizationId: string; answeredCalls: number; seconds: number }>; totals: { answeredCalls: number } };
    expect(data.period.start).toBe("2026-03-01");
    expect(data.organizations.find((row) => row.organizationId === tenant)).toMatchObject({ answeredCalls: 1, seconds: 120 });
    expect(data.totals.answeredCalls).toBeGreaterThanOrEqual(1);
  });

  it("empresa cliente e operador da plataforma não leem", async () => {
    expect(await call(consolidated, { cookie: tenantOwner })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(consolidated, { cookie: platformOperator })).toMatchObject({ status: 403, code: "forbidden" });
  });
});
