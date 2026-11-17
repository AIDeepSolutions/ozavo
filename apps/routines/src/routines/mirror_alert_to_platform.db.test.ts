import { MIRROR_ALERT_TASK, withSystem } from "@ozavo/core";
import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, depsFor, openTestDbs, task } from "../../test/helpers";
import mirror from "./mirror_alert_to_platform";

/** A rotina que leva o alerta crítico de uma empresa à plataforma. */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

describe("mirror_alert_to_platform", () => {
  it("entrega o aviso na plataforma e recusa corpo inválido", async () => {
    const platform = await createOrganization(app, "plataforma da rotina de alertas");
    await withSystem(app, (q) => q.exec("update organizations set platform = true where id = $1", [platform]));
    const tenant = await createOrganization(app, "Loja da Rotina");
    const payload = { kind: "usage", threshold: 80, periodStart: "2031-03-01", consumedSeconds: 14_400, includedSeconds: 18_000 };
    await mirror.run(task(tenant, MIRROR_ALERT_TASK, payload), depsFor(app));
    const notices = await withSystem(app, (q) => q.many<{ body: string }>("select body from notifications where organization_id = $1", [platform]));
    expect(notices.some((row) => row.body.startsWith("Loja da Rotina chegou a 80% da franquia"))).toBe(true);
    await expect(mirror.run(task(tenant, MIRROR_ALERT_TASK, { kind: "other" }), depsFor(app))).rejects.toThrow("Invalid platform alert payload");
  });
});
