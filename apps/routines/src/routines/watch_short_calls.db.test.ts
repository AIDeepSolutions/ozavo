import { WATCH_SHORT_CALLS_TASK, withSystem } from "@ozavo/core";
import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, depsFor, notificationsOf, openTestDbs, t0, task, tasksOf } from "../../test/helpers";
import watchShortCalls from "./watch_short_calls";

/**
 * A rotina das chamadas curtas, com relógio injetado: reagenda a si mesma enquanto a organização
 * faz ligações de saída, para quando ela passa um dia sem ligar, e reduz a cadência da linha que
 * passou do limite.
 */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const LINE = "+553133330000";
const minutesAgo = (minutes: number): Date => new Date(t0.getTime() - minutes * 60_000);
const run = (org: string): Promise<void> => watchShortCalls.run(task(org, WATCH_SHORT_CALLS_TASK), depsFor(app));
const queued = async (org: string) => (await tasksOf(app, org)).filter((row) => row.kind === WATCH_SHORT_CALLS_TASK && row.status === "queued");

/** `count` ligações de saída atendidas pela linha, de `seconds` segundos, começadas há `minutes` minutos. */
const outbound = (org: string, count: number, seconds: number, minutes: number) =>
  withSystem(app, (q) =>
    q.exec(
      `insert into calls (organization_id, direction, channel, status, from_e164, started_at, answered_at, ended_at)
       select $1, 'outbound', 'phone', 'completed', $2, $3::timestamptz, $3::timestamptz, $3::timestamptz + make_interval(secs => $4) from generate_series(1, $5)`,
      [org, LINE, minutesAgo(minutes), seconds, count],
    ),
  );
const rowsOf = (sql: string, org: string) => withSystem(app, (q) => q.many(sql, [org]));

describe("watch_short_calls", () => {
  it("sem ligação de saída no último dia, a corrente para", async () => {
    const org = await createOrganization(app, "short calls idle");
    await outbound(org, 3, 60, 25 * 60);
    await run(org);
    expect(await queued(org)).toEqual([]);
  });

  it("com ligações de saída, marca a próxima passagem em 15 minutos e não avisa abaixo do limite", async () => {
    const org = await createOrganization(app, "short calls calm");
    await outbound(org, 50, 2, 30);
    await run(org);
    const next = await queued(org);
    expect(next).toHaveLength(1);
    const row = await withSystem(app, (q) => q.one<{ run_at: Date }>("select run_at from tasks where organization_id = $1 and kind = $2", [org, WATCH_SHORT_CALLS_TASK]));
    expect(row?.run_at).toEqual(new Date(t0.getTime() + 15 * 60_000));
    expect(await notificationsOf(app, org)).toEqual([]);
  });

  it("75% de mais de 1.000 ligações curtas: reduz a cadência, avisa uma vez e registra o evento", async () => {
    const org = await createOrganization(app, "short calls tripped");
    await outbound(org, 900, 3, 60);
    await outbound(org, 200, 90, 60);
    await run(org);
    await run(org);
    const breakers = await rowsOf("select line_e164, total_calls, short_calls from cadence_breakers where organization_id = $1", org);
    expect(breakers).toEqual([{ line_e164: LINE, total_calls: 1100, short_calls: 900 }]);
    const notices = await rowsOf("select body from notifications where organization_id = $1", org);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toMatch(/ALERTA CRÍTICO/);
    const events = await rowsOf("select payload from organization_events where organization_id = $1 and kind = 'cadence_reduced'", org);
    expect(events).toEqual([{ payload: { lineE164: LINE, totalCalls: 1100, shortCalls: 900, reducedCallsPerHour: 60 } }]);
  });
});
