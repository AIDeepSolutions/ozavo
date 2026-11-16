import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { acceptInvite, findInviteByToken } from "./invites";
import { hashToken } from "./password";
import { withSystem } from "./with-org";

/**
 * O convite de dono do provisionamento não tem criador na equipe. Ele vale enquanto a empresa não
 * tem dono ativo e para de valer assim que um dono entra (auditoria A18).
 */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const now = new Date(Date.UTC(2030, 4, 10, 15));
async function provisionedInvite(org: string, email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withSystem(app, (q) =>
    q.exec("insert into invites (organization_id, email, name, role, token_hash, expires_at, provisioned) values ($1, $2, 'Dona', 'owner', $3, $4, true)", [
      org, email, hashToken(token), new Date(now.getTime() + 86_400_000),
    ]),
  );
  return token;
}

describe("convite de dono provisionado", () => {
  it("vale sem dono ativo e deixa de valer depois que o dono entra", async () => {
    const org = await createOrganization(app, "convite provisionado");
    const first = await provisionedInvite(org, `dona-${crypto.randomUUID()}@example.test`);
    expect(await findInviteByToken(app, first, now)).toMatchObject({ organizationId: org, role: "owner" });
    expect((await acceptInvite(app, first, { name: "Dona", passwordHash: "h" }, now)).ok).toBe(true);

    const second = await provisionedInvite(org, `outra-${crypto.randomUUID()}@example.test`);
    expect(await findInviteByToken(app, second, now)).toBeNull();
    expect(await acceptInvite(app, second, { name: "Outra", passwordHash: "h" }, now)).toEqual({ ok: false, reason: "invalid" });
  });

  it("o banco recusa convite provisionado que não seja de dono", async () => {
    const org = await createOrganization(app, "convite provisionado operador");
    await expect(withSystem(app, (q) =>
      q.exec("insert into invites (organization_id, email, name, role, token_hash, expires_at, provisioned) values ($1, 'x@example.test', 'X', 'operator', $2, $3, true)", [
        org, hashToken("t"), now,
      ]),
    )).rejects.toThrow(/invites_provisioned_is_owner/);
  });
});
