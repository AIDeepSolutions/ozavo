import { withOrg } from "@ozavo/core";
import { afterAll, expect, it } from "vitest";
import { call, createOrganization, createUser, startPanel } from "../../../../test/kit";
import { GET, PUT } from "./privacy/recordings-retention/route";
const panel = startPanel();
afterAll(() => panel.close());

it("prazo do áudio exige administrador, valida piso, isola organizações e audita a troca", async () => {
  const org = await createOrganization(panel.app, "recording retention API");
  const foreign = await createOrganization(panel.app, "foreign retention API");
  const owner = await createUser(panel.app, org, "owner");
  const other = await createUser(panel.app, foreign, "owner");
  const operator = await createUser(panel.app, org, "operator");
  expect((await call(GET, { cookie: owner.cookie })).data).toEqual({ days: 90 });
  expect((await call(GET, { cookie: operator.cookie })).status).toBe(403);
  expect((await call(PUT, { method: "PUT", cookie: operator.cookie, body: { days: 180 } })).status).toBe(403);
  for (const days of [89, null, "90", 3651]) expect((await call(PUT, { method: "PUT", cookie: owner.cookie, body: { days } })).status).toBe(400);
  expect((await call(PUT, { method: "PUT", cookie: owner.cookie, body: { days: 180 } })).data).toEqual({ days: 180 });
  expect((await call(GET, { cookie: other.cookie })).data).toEqual({ days: 90 });
  const events = await withOrg(panel.app, org, q => q.many<{ payload: unknown }>("select payload from organization_events where kind = 'recording_retention_changed'"));
  expect(events).toEqual([{ payload: { from: 90, to: 180 } }]);
  await call(PUT, { method: "PUT", cookie: owner.cookie, body: { days: 90 } });
  const tasks = await withOrg(panel.app, org, q => q.many("select id from tasks where kind = 'maintain_recordings' and status = 'queued'"));
  expect(tasks).toHaveLength(1);
});
