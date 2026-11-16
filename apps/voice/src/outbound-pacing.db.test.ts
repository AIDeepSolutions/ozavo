// A ligação de saída passa pela franquia do plano e pelo teto de chamadas simultâneas, depois da
// política de saída. A recusa fica auditável como qualquer outra.
import { setPlanSubscription, withOrg, withSystem } from "@ozavo/core";
import { afterAll, describe, expect, it } from "vitest";
import { openTestDbs } from "../../../packages/core/test/helpers";
import { AsteriskCalls } from "./asterisk-transport";
import { startOutboundCall } from "./outbound";
import { callsOf, createAgent, createOrganization, createPhoneNumber, createTrunk, eventsOf, fakeAri, fakeClock } from "./testing/db";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const LINE = "+553133334444";
const TO = "+5531999998888";

async function scene(label: string) {
  const organizationId = await createOrganization(app, label);
  const agentId = await createAgent(app, organizationId);
  const trunkId = await createTrunk(app, organizationId, { callerId: LINE });
  await createPhoneNumber(app, organizationId, trunkId, LINE, agentId);
  await withSystem(app, (q) => q.exec("insert into outbound_policy (organization_id, enabled, window_start, window_end, timezone) values ($1, true, '00:00', '23:59', 'UTC')", [organizationId]));
  const ari = fakeAri();
  const clock = fakeClock();
  const calls = new AsteriskCalls({ ari, db: app, clock, log: () => undefined });
  const today = clock.now().toISOString().slice(0, 10);
  const subscribe = (overageRule: "pause_outbound" | "bill_overage") =>
    withOrg(app, organizationId, (q) => setPlanSubscription(q, { plan: "starter", overageRule, overagePriceCentsPerMinute: 150 }, clock.now(), today));
  const dial = (toE164 = TO) => startOutboundCall({ db: app, ari, clock, calls, log: () => undefined }, { organizationId, agentId, toE164 });
  /** Uma ligação recebida e atendida, de `minutes` minutos, terminada agora. */
  const spend = (minutes: number) =>
    withSystem(app, (q) =>
      q.exec("insert into calls (organization_id, direction, channel, status, started_at, answered_at, ended_at) values ($1, 'inbound', 'phone', 'completed', $2, $2, $3)", [
        organizationId,
        new Date(clock.now().getTime() - minutes * 60_000),
        clock.now(),
      ]),
    );
  return { organizationId, ari, clock, calls, subscribe, dial, spend };
}

describe("ligação de saída com plano", { timeout: 120_000 }, () => {
  it("franquia esgotada com a regra de pausar: não origina, e a recusa fica na linha do tempo", async () => {
    const { organizationId, ari, subscribe, dial, spend } = await scene("pacing-quota");
    await subscribe("pause_outbound");
    await spend(301);
    expect(await dial()).toEqual({ code: "plan_quota_exhausted", message: expect.stringContaining("300 minutes") });
    expect(ari.originated).toEqual([]);
    const refused = (await callsOf(app, organizationId)).filter((call) => call.direction === "outbound");
    expect(refused).toMatchObject([{ status: "refused", end_reason: "plan_quota_exhausted", to_e164: TO }]);
    expect(await eventsOf(app, refused[0]?.id ?? "")).toEqual([{ kind: "call_refused", payload: { reason: "plan_quota_exhausted", message: expect.any(String), to: TO } }]);
    // Quem opera foi avisado dos dois limiares pela própria tentativa.
    const notices = await withSystem(app, (q) => q.many("select body from notifications where organization_id = $1 order by created_at, body", [organizationId]));
    expect(notices).toHaveLength(2);
  });

  it("franquia esgotada com a regra de tarifar o excedente: a ligação sai", async () => {
    const { ari, subscribe, dial, spend } = await scene("pacing-overage");
    await subscribe("bill_overage");
    await spend(301);
    expect(await dial()).toEqual({ callId: expect.any(String) });
    expect(ari.originated).toHaveLength(1);
  });

  it("o teto de chamadas do plano segura a ligação a mais", async () => {
    const { organizationId, ari, subscribe, dial } = await scene("pacing-concurrency");
    await subscribe("pause_outbound");
    // Starter: duas ao mesmo tempo.
    expect(await dial("+5531999990001")).toEqual({ callId: expect.any(String) });
    expect(await dial("+5531999990002")).toEqual({ callId: expect.any(String) });
    expect(await dial("+5531999990003")).toMatchObject({ code: "concurrency_limit" });
    expect(ari.originated).toHaveLength(2);
    expect((await callsOf(app, organizationId)).map((call) => call.status).sort()).toEqual(["refused", "ringing", "ringing"]);
  });

});
