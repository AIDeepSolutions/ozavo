import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { getConsolidatedFinops } from "./finops-consolidated";
import { getFinopsSummary } from "./finops";
import { saveOperationSettings } from "./operation-settings";
import { setPlanSubscription } from "./plans";
import { withOrg } from "./with-org";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const at = (day: number, hour = 15): Date => new Date(Date.UTC(2030, 4, day, hour));
const MODEL = "openai/text-embedding-3-small";

describe("FinOps e a base de conhecimento", () => {
  it("soma o embedding da base no custo dos provedores do ciclo, separado, e deixa de fora o de outro ciclo", async () => {
    const org = await createOrganization(app, "finops conhecimento");
    await withOrg(app, org, async (q) => {
      await setPlanSubscription(q, { plan: "starter", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 }, at(5), "2030-05-05");
      await saveOperationSettings(q, { ttsConcurrencyLimit: 4, reducedCallsPerHour: 60, telephonyBrlPerMinute: 0.06, usdBrlRate: 5 }, at(5));
    });
    // US$ 0,50 de indexação (1 milhão de tokens a 50 centavos, só para o número ficar visível) e US$ 0,10 de busca de teste, no ciclo; US$ 9 fora.
    await owner.pool.query(
      `insert into knowledge_usage (organization_id, kind, model, tokens, cost_microcents, at) values
       ($1, 'index', $2, 1000000, 50000000, $3), ($1, 'search', $2, 20, 10000000, $4), ($1, 'index', $2, 5, 900000000, $5)`,
      [org, MODEL, at(10), at(12), new Date(Date.UTC(2030, 3, 20))],
    );
    const summary = await withOrg(app, org, (q) => getFinopsSummary(q, at(15)));
    expect(summary.knowledgeCostUsdCents).toBe(60);
    expect(summary.knowledgeTokens).toEqual({ index: 1_000_000, search: 20 });
    expect(summary.providerCostUsdCents).toBe(60);
    // O custo entra na margem: 60 centavos de dólar a R$ 5,00 = R$ 3,00.
    expect(summary.margin.providerCostCents).toBe(300);

    const consolidated = await getConsolidatedFinops(app, at(15));
    expect(consolidated.organizations.find((row) => row.organizationId === org)?.providerCostUsdCents).toBe(60);
  });
});
