import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { checkPacingAllowed } from "./pacing";
import { setPlanSubscription } from "./plans";
import { withOrg } from "./with-org";

/**
 * Franquia zero com a regra de pausar: nenhum minuto incluído quer dizer que a saída já começa
 * pausada. Antes, `includedSeconds > 0` tratava zero como ilimitado (auditoria A15).
 */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const at = (day: number): Date => new Date(Date.UTC(2030, 4, day, 15, 0));
const custom = { plan: "custom" as const, monthlyPriceCents: 0, includedMinutes: 0, maxConcurrentCalls: 2, overagePriceCentsPerMinute: 0 };

describe("franquia zero", () => {
  it("com pausar a saída, nenhuma ligação de saída é permitida", async () => {
    const org = await createOrganization(app, "franquia zero pausa");
    await withOrg(app, org, async (q) => {
      await setPlanSubscription(q, { ...custom, overageRule: "pause_outbound" }, at(5), "2030-05-05");
      expect(await checkPacingAllowed(q, at(6), { db: app })).toMatchObject({ allowed: false, code: "plan_quota_exhausted" });
    });
  });

  it("com tarifar o excedente, a ligação passa e vira excedente", async () => {
    const org = await createOrganization(app, "franquia zero tarifa");
    await withOrg(app, org, async (q) => {
      await setPlanSubscription(q, { ...custom, overageRule: "bill_overage", overagePriceCentsPerMinute: 30 }, at(5), "2030-05-05");
      expect(await checkPacingAllowed(q, at(6), { db: app })).toEqual({ allowed: true });
    });
  });
});
