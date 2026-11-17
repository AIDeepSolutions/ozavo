import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { READINESS_KEYS, createPlatformTenant, getPlatformTenant, listPlatformTenants, type PanelTenantInput, type ReadinessKey } from "./platform-tenants";
import { withSystem } from "./with-org";

/** A lista de prontidão: o que falta para a empresa operar, sem nunca devolver um valor secreto. */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const now = new Date(Date.UTC(2030, 6, 10, 15));
const SECRET_VALUE = "enc:v1:SEGREDO-QUE-NAO-PODE-SAIR";
let platform: string;
let platformUser: string;

const form = (): PanelTenantInput => ({
  requestId: randomUUID(),
  companyName: `Empresa ${randomUUID().slice(0, 8)}`,
  owner: { name: "Dona", email: `dona-${randomUUID()}@example.test` },
  plan: "starter",
  initialStatus: "active",
  agent: { name: "Nico", personaName: "Nico", voiceId: null, basePrompt: "", instructions: "Atenda.", greeting: null, engine: "simulated", tools: [] },
});

async function newTenant(): Promise<string> {
  const result = await createPlatformTenant(app, platform, platformUser, form(), now);
  if ("refused" in result) throw new Error("refused");
  return result.organizationId;
}

const statusOf = async (id: string): Promise<Record<ReadinessKey, "configured" | "missing">> => {
  const detail = await getPlatformTenant(app, platform, id, now);
  if (!detail) throw new Error("tenant not found");
  return Object.fromEntries(detail.readiness.items.map((item) => [item.key, item.status])) as Record<ReadinessKey, "configured" | "missing">;
};

const exec = async (sql: string, params: unknown[]): Promise<void> => {
  await withSystem(app, (q) => q.exec(sql, params));
};

beforeAll(async () => {
  platform = await createOrganization(app, "plataforma da prontidão");
  await exec("update organizations set platform = true where id = $1", [platform]);
  platformUser = randomUUID();
  await exec("insert into users (id, organization_id, email, name, role, password_hash) values ($1, $2, $3, 'Admin', 'owner', 'h')", [platformUser, platform, `admin-${platformUser}@example.test`]);
});

describe("prontidão da empresa", () => {
  it("empresa recém-criada: agente e plano prontos, o resto falta", async () => {
    const id = await newTenant();
    expect(await statusOf(id)).toEqual({ ownerAccepted: "missing", engineKey: "missing", voiceAgent: "configured", line: "missing", outboundPolicy: "missing", plan: "configured" });
    const detail = await getPlatformTenant(app, platform, id, now);
    expect(detail?.readiness).toMatchObject({ ready: false, missingRequired: 3 });
    expect(detail?.readiness.items.map((item) => item.key)).toEqual([...READINESS_KEYS]);
  });

  it("cada item falta sozinho e some da lista de pendências quando é resolvido", async () => {
    const id = await newTenant();
    // Dono aceitou.
    await exec("insert into users (id, organization_id, email, name, role, password_hash) values ($1, $2, $3, 'Dona', 'owner', 'h')", [randomUUID(), id, `dona-${randomUUID()}@example.test`]);
    expect((await statusOf(id)).ownerAccepted).toBe("configured");
    // Dono desativado não conta.
    await exec("update users set disabled_at = $2 where organization_id = $1", [id, now]);
    expect((await statusOf(id)).ownerAccepted).toBe("missing");
    await exec("update users set disabled_at = null where organization_id = $1", [id]);
    expect((await statusOf(id)).ownerAccepted).toBe("configured");

    // Chave do motor: só a que é segredo e tem o formato engine.<id>.api_key.
    await exec("insert into settings (organization_id, key, value, secret) values ($1, 'engine.gemini_live.model', '\"x\"', false)", [id]);
    await exec("insert into settings (organization_id, key, value, secret) values ($1, 'engineXgemini.api_key', '\"x\"', true)", [id]);
    expect((await statusOf(id)).engineKey).toBe("missing");
    await exec("insert into settings (organization_id, key, value, secret) values ($1, 'engine.gemini_live.api_key', $2::jsonb, true)", [id, JSON.stringify(SECRET_VALUE)]);
    expect((await statusOf(id)).engineKey).toBe("configured");

    // Agente: desligado não conta.
    await exec("update agents set enabled = false where organization_id = $1", [id]);
    expect((await statusOf(id)).voiceAgent).toBe("missing");
    await exec("update agents set enabled = true where organization_id = $1", [id]);
    expect((await statusOf(id)).voiceAgent).toBe("configured");

    // Linha.
    await exec("insert into trunks (id, organization_id, name, host, auth_mode) values ($1, $2, 'Tronco', 'sip.example.test', 'ip')", [id.replace(/^./, "a"), id]);
    await exec("insert into phone_numbers (organization_id, trunk_id, e164) values ($1, $2, '+5511999990001')", [id, id.replace(/^./, "a")]);
    expect((await statusOf(id)).line).toBe("configured");

    // Política de saída: informativa, não segura a prontidão.
    expect((await getPlatformTenant(app, platform, id, now))?.readiness).toMatchObject({ ready: true, missingRequired: 0 });
    expect((await statusOf(id)).outboundPolicy).toBe("missing");
    await exec("update outbound_policy set enabled = true where organization_id = $1", [id]);
    expect((await statusOf(id)).outboundPolicy).toBe("configured");

    // Limpeza: o tronco é lido pelos testes da borda de voz.
    await exec("delete from phone_numbers where organization_id = $1", [id]);
    await exec("delete from trunks where organization_id = $1", [id]);
  });

  it("todos prontos: pronta, nenhum item obrigatório faltando", async () => {
    const id = await newTenant();
    await exec("insert into users (id, organization_id, email, name, role, password_hash) values ($1, $2, $3, 'Dona', 'owner', 'h')", [randomUUID(), id, `dona-${randomUUID()}@example.test`]);
    await exec("insert into settings (organization_id, key, value, secret) values ($1, 'engine.openai_realtime.api_key', $2::jsonb, true)", [id, JSON.stringify(SECRET_VALUE)]);
    await exec("insert into trunks (id, organization_id, name, host, auth_mode) values ($1, $2, 'Tronco', 'sip.example.test', 'ip')", [id.replace(/^./, "b"), id]);
    await exec("insert into phone_numbers (organization_id, trunk_id, e164) values ($1, $2, '+5511999990002')", [id, id.replace(/^./, "b")]);
    await exec("update outbound_policy set enabled = true where organization_id = $1", [id]);
    const detail = await getPlatformTenant(app, platform, id, now);
    expect(detail?.readiness.ready).toBe(true);
    expect(detail?.readiness.items.every((item) => item.status === "configured")).toBe(true);
    await exec("delete from phone_numbers where organization_id = $1", [id]);
    await exec("delete from trunks where organization_id = $1", [id]);
  });

  it("empresa sem nada (sem plano, agente, política): tudo falta", async () => {
    const bare = await createOrganization(app, "empresa vazia da prontidão");
    expect(await statusOf(bare)).toEqual({ ownerAccepted: "missing", engineKey: "missing", voiceAgent: "missing", line: "missing", outboundPolicy: "missing", plan: "missing" });
  });

  it("nenhuma chave de segredo sai: lista e detalhe só têm itens configurada/falta", async () => {
    const id = await newTenant();
    await exec("insert into settings (organization_id, key, value, secret) values ($1, 'engine.gemini_live.api_key', $2::jsonb, true)", [id, JSON.stringify(SECRET_VALUE)]);
    const detail = await getPlatformTenant(app, platform, id, now);
    const row = (await listPlatformTenants(app, platform, now)).find((tenant) => tenant.organizationId === id);
    for (const readiness of [detail?.readiness, row?.readiness]) {
      expect(readiness?.items.find((item) => item.key === "engineKey")).toEqual({ key: "engineKey", status: "configured", required: true });
      for (const item of readiness?.items ?? []) expect(Object.keys(item).sort()).toEqual(["key", "required", "status"]);
      expect(Object.keys(readiness ?? {}).sort()).toEqual(["items", "missingRequired", "ready"]);
    }
    expect(JSON.stringify(detail)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(detail)).not.toContain("SEGREDO");
  });

  it("uma empresa não herda a prontidão de outra", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await exec("insert into settings (organization_id, key, value, secret) values ($1, 'engine.gemini_live.api_key', $2::jsonb, true)", [a, JSON.stringify(SECRET_VALUE)]);
    expect((await statusOf(a)).engineKey).toBe("configured");
    expect((await statusOf(b)).engineKey).toBe("missing");
  });
});
