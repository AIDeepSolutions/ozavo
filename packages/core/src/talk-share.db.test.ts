import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { getAgentTalkShare } from "./talk-share";
import { withOrg } from "./with-org";

/** A fala da IA abaixo de 50% do tempo da ligação: a meta da spec, medida no FinOps (auditoria A23). */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const at = (day: number, hour = 15): Date => new Date(Date.UTC(2030, 4, day, hour));

async function endedCall(org: string, start: Date, seconds: number, agentSpeechSeconds: number | null, channel = "phone"): Promise<void> {
  const row = await owner.pool.query<{ id: string }>(
    `insert into calls (organization_id, direction, channel, status, started_at, answered_at, ended_at)
     values ($1, 'inbound', $2, 'completed', $3, $3, $4) returning id`,
    [org, channel, start, new Date(start.getTime() + seconds * 1000)],
  );
  const payload = agentSpeechSeconds === null ? { status: "completed", seconds } : { status: "completed", seconds, agentSpeechSeconds };
  await owner.pool.query("insert into call_events (organization_id, call_id, kind, payload, at) values ($1, $2, 'call_ended', $3, $4)", [org, row.rows[0]?.id, payload, start]);
}

describe("fala da IA", () => {
  it("soma a fala e o tempo das ligações do período e conta as que passaram da metade", async () => {
    const org = await createOrganization(app, "fala da ia");
    await endedCall(org, at(3), 100, 40);
    await endedCall(org, at(4), 100, 70);
    // Antes da medição (sem o campo) e simulada: ficam de fora.
    await endedCall(org, at(5), 100, null);
    await endedCall(org, at(6), 100, 90, "simulated");
    const share = await withOrg(app, org, (q) => getAgentTalkShare(q, at(10)));
    expect(share).toMatchObject({ calls: 2, callSeconds: 200, agentSeconds: 110, share: 0.55, callsOverTarget: 1, target: 0.5 });
  });

  it("sem ligação medida não inventa proporção", async () => {
    const org = await createOrganization(app, "fala da ia vazia");
    expect(await withOrg(app, org, (q) => getAgentTalkShare(q, at(10)))).toMatchObject({ calls: 0, share: null, callsOverTarget: 0 });
  });
});
