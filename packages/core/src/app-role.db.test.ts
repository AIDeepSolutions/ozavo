import { afterAll, describe, expect, it } from "vitest";
import { openTestDbs } from "../test/helpers";
import { appRoleBypassesRls, createDb } from "./db";

const { app, owner } = openTestDbs();
// Uma instalação mal configurada: a conexão de aplicação aponta para o papel de sistema.
const misconfigured = createDb(process.env.TEST_SYSTEM_DATABASE_URL ?? "");
afterAll(async () => {
  await Promise.all([app.close(), owner.close(), misconfigured.close()]);
});

describe("appRoleBypassesRls", () => {
  it("ozavo_app respeita o RLS", async () => {
    expect(await appRoleBypassesRls(app)).toBe(false);
  });

  it("o papel de sistema e o dono do banco contornam o RLS", async () => {
    expect(await appRoleBypassesRls(misconfigured)).toBe(true);
    expect(await appRoleBypassesRls(owner)).toBe(true);
  });
});
