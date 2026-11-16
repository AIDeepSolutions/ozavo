import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { withOrg, withSystem } from "./with-org";

/**
 * `organizations.platform` decide quem provisiona empresas e troca planos. Só o papel de sistema
 * (o `create-owner`) o liga; o papel de aplicação não pode mudá-lo nem com um erro de código
 * (auditoria A17).
 */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const platformOf = async (id: string): Promise<boolean> =>
  (await owner.pool.query<{ platform: boolean }>("select platform from organizations where id = $1", [id])).rows[0]?.platform ?? false;

describe("coluna platform", () => {
  it("o papel de aplicação não liga platform na própria organização", async () => {
    const org = await createOrganization(app, "platform pelo app");
    await expect(withOrg(app, org, (q) => q.exec("update organizations set platform = true where id = $1", [org]))).rejects.toThrow(/platform/);
    expect(await platformOf(org)).toBe(false);
  });

  it("o papel de aplicação ainda muda o nome da organização", async () => {
    const org = await createOrganization(app, "platform nome antigo");
    await withOrg(app, org, (q) => q.exec("update organizations set name = 'platform nome novo' where id = $1", [org]));
    const row = await owner.pool.query<{ name: string }>("select name from organizations where id = $1", [org]);
    expect(row.rows[0]?.name).toBe("platform nome novo");
  });

  it("o papel de sistema liga e desliga platform", async () => {
    const org = await createOrganization(app, "platform pelo sistema");
    await withSystem(app, (q) => q.exec("update organizations set platform = true where id = $1", [org]));
    expect(await platformOf(org)).toBe(true);
    await withSystem(app, (q) => q.exec("update organizations set platform = false where id = $1", [org]));
    expect(await platformOf(org)).toBe(false);
  });
});
