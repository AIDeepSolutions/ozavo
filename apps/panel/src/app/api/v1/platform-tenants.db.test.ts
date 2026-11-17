import { randomUUID } from "node:crypto";
import { withOrg, withSystem } from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createOrganization, createUser, startPanel } from "../../../../test/kit";
import { GET as getInvite } from "./invites/[token]/route";
import { GET as platformFinops } from "./platform/finops/route";
import { POST as renewInvite } from "./platform/tenants/[id]/owner-invite/route";
import { PUT as setPlan } from "./platform/tenants/[id]/plan/route";
import { GET as getTenant } from "./platform/tenants/[id]/route";
import { POST as setStatus } from "./platform/tenants/[id]/status/route";
import { GET as listTenants, POST as createTenant } from "./platform/tenants/route";
import { GET as tenantProfile } from "./tenant-profile/route";

/**
 * A área de plataforma do painel. Só dono ou administrador da organização da plataforma entra; uma
 * empresa cliente não lê nem altera outra, nem com o id na mão.
 */
const panel = startPanel();
let platformOwner: string;
let platformOperator: string;
let clientOwner: string;
let client: string;
let neighbour: string;

const newCompany = (extra: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  companyName: `Clínica ${randomUUID().slice(0, 6)}`,
  owner: { name: "Dona", email: `dona-${randomUUID()}@example.test` },
  plan: "pro",
  initialStatus: "active",
  ...extra,
});

beforeAll(async () => {
  const platform = await createOrganization(panel.app, "plataforma do painel");
  await withSystem(panel.app, (q) => q.exec("update organizations set platform = true where id = $1", [platform]));
  platformOwner = (await createUser(panel.app, platform, "admin")).cookie;
  platformOperator = (await createUser(panel.app, platform, "operator")).cookie;
  client = await createOrganization(panel.app, "cliente curiosa");
  clientOwner = (await createUser(panel.app, client, "owner")).cookie;
  neighbour = await createOrganization(panel.app, "cliente vizinha");
});
afterAll(() => panel.close());

describe("nova empresa pela tela", () => {
  it("cria, devolve o link de convite uma vez e a empresa aparece na lista", async () => {
    const body = newCompany();
    const created = await call(createTenant, { method: "POST", cookie: platformOwner, body });
    expect(created.status).toBe(200);
    const data = created.data as { created: boolean; organizationId: string; ownerInviteUrl: string };
    expect(data.created).toBe(true);
    const token = data.ownerInviteUrl.split("/invite/")[1] ?? "";
    expect((await call(getInvite, { params: { token } })).status).toBe(200);

    const list = await call(listTenants, { cookie: platformOwner });
    const row = (list.data as Array<{ organizationId: string; planCode: string; status: string; origin: { kind: string } }>).find((tenant) => tenant.organizationId === data.organizationId);
    expect(row).toMatchObject({ planCode: "pro", status: "active", origin: { kind: "panel" } });

    const again = await call(createTenant, { method: "POST", cookie: platformOwner, body });
    expect(again.data).toMatchObject({ created: false, organizationId: data.organizationId });
  });

  it("aceita nome fantasia e CNPJ válido, e recusa CNPJ com dígito errado", async () => {
    expect(await call(createTenant, { method: "POST", cookie: platformOwner, body: newCompany({ cnpj: "11.222.333/0001-82" }) })).toMatchObject({ status: 400, code: "validation_error" });
    const ok = await call(createTenant, { method: "POST", cookie: platformOwner, body: newCompany({ tradeName: "Fantasia", cnpj: "11.222.333/0001-81" }) });
    const id = (ok.data as { organizationId: string }).organizationId;
    expect((await call(getTenant, { cookie: platformOwner, params: { id } })).data).toMatchObject({ name: "Fantasia", tradeName: "Fantasia", cnpj: "11222333000181" });
  });

  it("o plano Personalizado exige preço, minutos e canais", async () => {
    const refused = await call(createTenant, { method: "POST", cookie: platformOwner, body: newCompany({ plan: "custom" }) });
    expect(refused).toMatchObject({ status: 400, code: "validation_error" });
    const ok = await call(createTenant, {
      method: "POST",
      cookie: platformOwner,
      body: newCompany({ plan: "custom", custom: { monthlyPriceCents: 250_000, includedMinutes: 3_000, maxConcurrentCalls: 6 }, initialStatus: "suspended" }),
    });
    const id = (ok.data as { organizationId: string }).organizationId;
    expect((await call(getTenant, { cookie: platformOwner, params: { id } })).data).toMatchObject({ status: "suspended", planCode: "custom", finops: { subscription: { includedMinutes: 3_000 } } });
  });
});

describe("detalhe, status e convite", () => {
  it("suspende, reativa e renova o convite, com o registro no detalhe", async () => {
    const created = await call(createTenant, { method: "POST", cookie: platformOwner, body: newCompany() });
    const id = (created.data as { organizationId: string }).organizationId;
    expect((await call(setStatus, { method: "POST", cookie: platformOwner, params: { id }, body: { status: "suspended" } })).status).toBe(200);
    expect(await withOrg(panel.app, id, async (q) => (await q.one<{ status: string }>("select status from tenant_profiles where organization_id = $1", [id]))?.status)).toBe("suspended");
    expect((await call(setStatus, { method: "POST", cookie: platformOwner, params: { id }, body: { status: "active" } })).status).toBe(200);

    const renewed = await call(renewInvite, { method: "POST", cookie: platformOwner, params: { id } });
    expect(renewed.data).toMatchObject({ ownerInviteUrl: expect.stringContaining("/invite/") });

    const detail = (await call(getTenant, { cookie: platformOwner, params: { id } })).data as { events: Array<{ kind: string }> };
    expect(detail.events.map((event) => event.kind)).toEqual(expect.arrayContaining(["tenant_status_changed", "tenant_owner_invite_renewed", "tenant_provisioned"]));
  });

  it("empresa que não existe é 404, e status fora do vocabulário é recusado", async () => {
    const id = randomUUID();
    expect(await call(getTenant, { cookie: platformOwner, params: { id } })).toMatchObject({ status: 404 });
    expect(await call(setStatus, { method: "POST", cookie: platformOwner, params: { id }, body: { status: "suspended" } })).toMatchObject({ status: 404 });
    expect(await call(setStatus, { method: "POST", cookie: platformOwner, params: { id: neighbour }, body: { status: "cancelled" } })).toMatchObject({ status: 400 });
  });
});

describe("plano por empresa", () => {
  it("a plataforma troca para o Personalizado com excedente tarifado; o detalhe e a lista leem de plan_subscriptions", async () => {
    const created = await call(createTenant, { method: "POST", cookie: platformOwner, body: newCompany() });
    const id = (created.data as { organizationId: string }).organizationId;
    const custom = { plan: "custom", overageRule: "bill_overage", overagePriceCentsPerMinute: 120, monthlyPriceCents: 350_000, includedMinutes: 5_000, maxConcurrentCalls: 12 };
    const changed = await call(setPlan, { method: "PUT", cookie: platformOwner, params: { id }, body: custom });
    expect(changed).toMatchObject({ status: 200, data: { subscription: { plan: "custom", includedMinutes: 5_000, overageRule: "bill_overage", overagePriceCentsPerMinute: 120, maxConcurrentCalls: 12 } } });
    expect((await call(getTenant, { cookie: platformOwner, params: { id } })).data).toMatchObject({ planCode: "custom", finops: { subscription: { plan: "custom", monthlyPriceCents: 350_000 } } });
    const row = (await call(listTenants, { cookie: platformOwner })).data as Array<{ organizationId: string; planCode: string }>;
    expect(row.find((tenant) => tenant.organizationId === id)?.planCode).toBe("custom");
    // O perfil da empresa lê o plano da mesma fonte.
    expect(await withOrg(panel.app, id, (q) => q.one("select plan_code from tenant_profiles"))).toEqual({ plan_code: null });
  });

  it("Personalizado sem os três valores é recusado; empresa que não existe é 404", async () => {
    expect(await call(setPlan, { method: "PUT", cookie: platformOwner, params: { id: neighbour }, body: { plan: "custom", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 } })).toMatchObject({ status: 400, code: "validation_error" });
    expect(await call(setPlan, { method: "PUT", cookie: platformOwner, params: { id: randomUUID() }, body: { plan: "pro", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 } })).toMatchObject({ status: 404 });
  });

  it("empresa cliente e operador da plataforma não trocam o plano de ninguém", async () => {
    const body = { plan: "scale", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 };
    expect(await call(setPlan, { method: "PUT", cookie: clientOwner, params: { id: neighbour }, body })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(setPlan, { method: "PUT", cookie: clientOwner, params: { id: client }, body })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(setPlan, { method: "PUT", cookie: platformOperator, params: { id: neighbour }, body })).toMatchObject({ status: 403, code: "forbidden" });
    expect(await withSystem(panel.app, (q) => q.one("select plan from plan_subscriptions where organization_id = $1", [neighbour]))).toBeNull();
  });
});

describe("acesso cruzado negado", () => {
  it("empresa cliente não lista, não lê, não cria, não suspende e não renova convite de outra", async () => {
    const asClient = { cookie: clientOwner };
    expect(await call(listTenants, asClient)).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(getTenant, { ...asClient, params: { id: neighbour } })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(createTenant, { ...asClient, method: "POST", body: newCompany() })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(setStatus, { ...asClient, method: "POST", params: { id: neighbour }, body: { status: "suspended" } })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(renewInvite, { ...asClient, method: "POST", params: { id: neighbour } })).toMatchObject({ status: 403, code: "platform_only" });
    // Nada mudou na vizinha.
    expect(await withSystem(panel.app, (q) => q.one("select status from tenant_profiles where organization_id = $1", [neighbour]))).toBeNull();
  });

  it("pelo papel de aplicação, a empresa cliente só enxerga o próprio perfil e nenhuma outra organização", async () => {
    expect((await call(tenantProfile, { cookie: clientOwner })).status).toBe(200);
    const seen = await withOrg(panel.app, client, (q) => q.many<{ id: string }>("select id from organizations"));
    expect(seen.map((row) => row.id)).toEqual([client]);
    const profiles = await withOrg(panel.app, client, (q) => q.many<{ organizationId: string }>('select organization_id as "organizationId" from tenant_profiles'));
    expect(profiles.every((row) => row.organizationId === client)).toBe(true);
  });

  it("operador da plataforma também não entra", async () => {
    expect(await call(listTenants, { cookie: platformOperator })).toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("FinOps da plataforma", () => {
  it("a plataforma lê; empresa cliente e operador da plataforma não", async () => {
    const result = await call(platformFinops, { cookie: platformOwner });
    expect(result.status).toBe(200);
    const data = result.data as { tenants: Array<{ organizationId: string }>; totals: { tenants: number }; critical: unknown[] };
    expect(data.tenants.some((tenant) => tenant.organizationId === neighbour)).toBe(true);
    expect(data.totals.tenants).toBe(data.tenants.length);
    expect(await call(platformFinops, { cookie: clientOwner })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(platformFinops, { cookie: platformOperator })).toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("prontidão da empresa pela API", () => {
  it("a plataforma lê a prontidão na lista e no detalhe, sem segredo; quem não é plataforma recebe 403", async () => {
    const secret = "enc:v1:SEGREDO-DA-ROTA";
    await withSystem(panel.app, (q) => q.exec("insert into settings (organization_id, key, value, secret) values ($1, 'engine.gemini_live.api_key', $2::jsonb, true)", [neighbour, JSON.stringify(secret)]));
    type Readiness = { items: Array<{ key: string; status: string; required: boolean }>; ready: boolean; missingRequired: number };
    const detail = await call(getTenant, { cookie: platformOwner, params: { id: neighbour } });
    expect(detail.status).toBe(200);
    const readiness = (detail.data as { readiness: Readiness }).readiness;
    expect(readiness.items.find((item) => item.key === "engineKey")).toMatchObject({ status: "configured" });
    expect(readiness.items.map((item) => item.key)).toEqual(["ownerAccepted", "engineKey", "voiceAgent", "line", "outboundPolicy", "plan"]);
    expect(JSON.stringify(detail.data)).not.toContain(secret);
    const list = await call(listTenants, { cookie: platformOwner });
    expect(JSON.stringify(list.data)).not.toContain(secret);
    expect((list.data as Array<{ organizationId: string; readiness: Readiness }>).find((row) => row.organizationId === neighbour)?.readiness.items).toHaveLength(6);

    expect(await call(getTenant, { cookie: clientOwner, params: { id: neighbour } })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(listTenants, { cookie: clientOwner })).toMatchObject({ status: 403, code: "platform_only" });
    expect(await call(getTenant, { cookie: platformOperator, params: { id: neighbour } })).toMatchObject({ status: 403, code: "forbidden" });
  });
});
