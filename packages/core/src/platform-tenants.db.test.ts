import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization, openTestDbs } from "../test/helpers";
import { findInviteByToken } from "./invites";
import { localDay } from "./metering";
import { getPlanSubscription } from "./plans";
import {
  PlatformOnlyError,
  createPlatformTenant,
  getPlatformTenant,
  listPlatformTenants,
  renewOwnerInvite,
  setPlatformTenantPlan,
  setPlatformTenantStatus,
  type PanelTenantInput,
} from "./platform-tenants";
import { withOrg, withSystem } from "./with-org";

/** A área de plataforma: só a organização da plataforma lê e altera as empresas clientes. */
const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const at = (day: number, hour = 15): Date => new Date(Date.UTC(2030, 5, day, hour));
let platform: string;
let platformUser: string;
let client: string;

const agent = { name: "Nico", personaName: "Nico", voiceId: null, basePrompt: "", instructions: "Atenda.", greeting: null, engine: "simulated", tools: [] };
const form = (extra: Partial<PanelTenantInput> = {}): PanelTenantInput => ({
  requestId: randomUUID(),
  companyName: `Empresa ${randomUUID().slice(0, 8)}`,
  owner: { name: "Dona", email: `dona-${randomUUID()}@example.test` },
  plan: "starter",
  initialStatus: "active",
  agent,
  ...extra,
});
const eventKinds = (organizationId: string): Promise<string[]> =>
  withSystem(app, async (q) => (await q.many<{ kind: string }>("select kind from organization_events where organization_id = $1 order by id", [organizationId])).map((row) => row.kind));

beforeAll(async () => {
  platform = await createOrganization(app, "plataforma das empresas");
  await withSystem(app, (q) => q.exec("update organizations set platform = true where id = $1", [platform]));
  platformUser = randomUUID();
  await withSystem(app, (q) =>
    q.exec("insert into users (id, organization_id, email, name, role, password_hash) values ($1, $2, $3, 'Admin', 'owner', 'h')", [platformUser, platform, `admin-${platformUser}@example.test`]),
  );
  client = await createOrganization(app, "empresa cliente comum");
});

describe("quem não é a plataforma", () => {
  it("não lista, não lê, não cria, não suspende e não renova convite", async () => {
    await expect(listPlatformTenants(app, client, at(1))).rejects.toBeInstanceOf(PlatformOnlyError);
    await expect(getPlatformTenant(app, client, platform, at(1))).rejects.toBeInstanceOf(PlatformOnlyError);
    await expect(createPlatformTenant(app, client, platformUser, form(), at(1))).rejects.toBeInstanceOf(PlatformOnlyError);
    await expect(setPlatformTenantStatus(app, client, platformUser, client, "suspended", at(1))).rejects.toBeInstanceOf(PlatformOnlyError);
    await expect(renewOwnerInvite(app, client, platformUser, client, at(1))).rejects.toBeInstanceOf(PlatformOnlyError);
    await expect(listPlatformTenants(app, randomUUID(), at(1))).rejects.toBeInstanceOf(PlatformOnlyError);
  });
});

describe("criar pela tela", () => {
  it("cria com o plano do catálogo, convite de dono de uso único e origem do painel", async () => {
    const input = form();
    const result = await createPlatformTenant(app, platform, platformUser, input, at(2));
    if ("refused" in result) throw new Error("refused");
    expect(result.created).toBe(true);
    const token = result.ownerInvite?.token ?? "";
    expect(await findInviteByToken(app, token, at(2))).toMatchObject({ organizationId: result.organizationId, role: "owner", email: input.owner.email });

    const row = (await listPlatformTenants(app, platform, at(2))).find((tenant) => tenant.organizationId === result.organizationId);
    expect(row).toMatchObject({
      name: input.companyName,
      planCode: "starter",
      status: "active",
      origin: { kind: "panel" },
      usage: { consumedSeconds: 0, includedSeconds: 300 * 60 },
      ownerInvite: { ownerActive: false, pending: { email: input.owner.email, expired: false } },
    });
    expect(await eventKinds(result.organizationId)).toEqual(["tenant_provisioned", "plan_changed"]);
    expect(await eventKinds(platform)).toContain("tenant_provisioned");
  });

  it("grava razão social, nome fantasia e CNPJ, e o nome fantasia é o nome da empresa", async () => {
    const input = form({ companyName: "Exemplo Comércio Ltda", tradeName: "Exemplo", cnpj: "11222333000181" });
    const result = await createPlatformTenant(app, platform, platformUser, input, at(2));
    if ("refused" in result) throw new Error("refused");
    expect(await getPlatformTenant(app, platform, result.organizationId, at(2))).toMatchObject({ name: "Exemplo", legalName: "Exemplo Comércio Ltda", tradeName: "Exemplo", cnpj: "11222333000181" });
  });

  it("a lista mostra o maior alerta de franquia do ciclo, o disjuntor ativo e as linhas", async () => {
    const result = await createPlatformTenant(app, platform, platformUser, form(), at(2));
    if ("refused" in result) throw new Error("refused");
    const id = result.organizationId;
    const rowOf = async () => (await listPlatformTenants(app, platform, at(2))).find((tenant) => tenant.organizationId === id);
    expect(await rowOf()).toMatchObject({ usageAlert: null, activeBreakers: 0, lines: 0 });
    const start = (await rowOf())?.usage?.period.start ?? "";
    await withSystem(app, async (q) => {
      const { day } = await localDay({ ...q, organizationId: id }, at(2));
      for (const threshold of [80, 100]) {
        await q.exec("insert into usage_alerts (organization_id, period_start, threshold, consumed_seconds, included_seconds, at) values ($1, $2::date, $3, 0, 0, $4)", [id, start, threshold, at(2)]);
      }
      await q.exec("insert into cadence_breakers (organization_id, line_e164, day, total_calls, short_calls, tripped_at) values ($1, '+5511999990000', $2::date, 1200, 950, $3)", [id, day, at(2)]);
      const trunk = await q.one<{ id: string }>("insert into trunks (organization_id, name, host, auth_mode) values ($1, 'Tronco', 'sip.example.test', 'ip') returning id", [id]);
      await q.exec("insert into phone_numbers (organization_id, trunk_id, e164) values ($1, $2, '+5511999990000')", [id, trunk?.id]);
    });
    expect(await rowOf()).toMatchObject({ usageAlert: 100, activeBreakers: 1, lines: 1 });
    // O tronco é lido pelos testes da borda de voz, que olham todas as organizações: não fica para trás.
    await withSystem(app, async (q) => {
      await q.exec("delete from phone_numbers where organization_id = $1", [id]);
      await q.exec("delete from trunks where organization_id = $1", [id]);
    });
  });

  it("o mesmo formulário enviado duas vezes devolve a mesma empresa", async () => {
    const input = form();
    const first = await createPlatformTenant(app, platform, platformUser, input, at(3));
    const again = await createPlatformTenant(app, platform, platformUser, input, at(3));
    if ("refused" in first || "refused" in again) throw new Error("refused");
    expect(again).toMatchObject({ created: false, organizationId: first.organizationId });
    // O convite da primeira resposta foi trocado pelo novo: só um vale.
    expect(await findInviteByToken(app, first.ownerInvite?.token ?? "", at(3))).toBeNull();
    expect(await findInviteByToken(app, again.ownerInvite?.token ?? "", at(3))).not.toBeNull();
  });

  it("plano Personalizado contrata o que foi informado e a empresa pode nascer suspensa", async () => {
    const result = await createPlatformTenant(app, platform, platformUser, form({ plan: "custom", custom: { monthlyPriceCents: 300_000, includedMinutes: 4_000, maxConcurrentCalls: 10 }, initialStatus: "suspended" }), at(4));
    if ("refused" in result) throw new Error("refused");
    expect(await withOrg(app, result.organizationId, getPlanSubscription)).toMatchObject({ plan: "custom", monthlyPriceCents: 300_000, includedMinutes: 4_000, maxConcurrentCalls: 10 });
    const detail = await getPlatformTenant(app, platform, result.organizationId, at(4));
    expect(detail).toMatchObject({ status: "suspended", planCode: "custom", billedByAsaas: false });
    expect(await eventKinds(result.organizationId)).toEqual(["tenant_provisioned", "plan_changed", "tenant_status_changed"]);
  });

  it("recusa e-mail de dono que já é de alguém nesta instalação", async () => {
    const taken = await withSystem(app, async (q) => (await q.one<{ email: string }>("select email from users where id = $1", [platformUser]))?.email ?? "");
    expect(await createPlatformTenant(app, platform, platformUser, form({ owner: { name: "X", email: taken } }), at(5))).toEqual({ refused: "email_taken" });
  });
});

describe("lista e detalhe", () => {
  it("não mostra a própria plataforma e o detalhe de outra organização qualquer é nulo", async () => {
    const rows = await listPlatformTenants(app, platform, at(6));
    expect(rows.some((row) => row.organizationId === platform)).toBe(false);
    expect(await getPlatformTenant(app, platform, platform, at(6))).toBeNull();
    expect(await getPlatformTenant(app, platform, randomUUID(), at(6))).toBeNull();
  });

  it("o detalhe traz só o registro da própria empresa", async () => {
    const a = await createPlatformTenant(app, platform, platformUser, form(), at(6));
    const b = await createPlatformTenant(app, platform, platformUser, form(), at(6));
    if ("refused" in a || "refused" in b) throw new Error("refused");
    await setPlatformTenantStatus(app, platform, platformUser, b.organizationId, "suspended", at(6));
    const detail = await getPlatformTenant(app, platform, a.organizationId, at(6));
    expect(detail?.events.map((event) => event.kind)).toEqual(["plan_changed", "tenant_provisioned"]);
    expect(detail?.finops.subscription?.plan).toBe("starter");
  });

  it("assinatura cancelada no Asaas aparece como cancelada", async () => {
    const result = await createPlatformTenant(app, platform, platformUser, form(), at(7));
    if ("refused" in result) throw new Error("refused");
    await withSystem(app, (q) =>
      q.exec("insert into asaas_subscriptions (organization_id, environment, subscription_id, tenant_id, cancelled) values ($1, 'sandbox', $2, $3, true)", [platform, `sub_${randomUUID()}`, result.organizationId]),
    );
    expect((await getPlatformTenant(app, platform, result.organizationId, at(7)))?.status).toBe("cancelled");
  });
});

describe("suspender e reativar", () => {
  it("registra dos dois lados e não repete o mesmo status", async () => {
    const result = await createPlatformTenant(app, platform, platformUser, form(), at(8));
    if ("refused" in result) throw new Error("refused");
    const tenant = result.organizationId;
    expect(await setPlatformTenantStatus(app, platform, platformUser, tenant, "suspended", at(8))).toBe(true);
    expect(await setPlatformTenantStatus(app, platform, platformUser, tenant, "suspended", at(8))).toBe(true);
    expect(await setPlatformTenantStatus(app, platform, platformUser, tenant, "active", at(9))).toBe(true);
    const events = await withSystem(app, (q) =>
      q.many<{ payload: { status: string; byUserId?: string } }>("select payload from organization_events where organization_id = $1 and kind = 'tenant_status_changed' order by id", [tenant]),
    );
    expect(events.map((event) => event.payload.status)).toEqual(["suspended", "active"]);
    expect(events[0]?.payload.byUserId).toBe(platformUser);
    const mine = await withSystem(app, (q) =>
      q.many<{ actor: string }>("select actor_user_id as actor from organization_events where organization_id = $1 and kind = 'tenant_status_changed' and payload->>'tenantId' = $2", [platform, tenant]),
    );
    expect(mine.map((row) => row.actor)).toEqual([platformUser, platformUser]);
  });

  it("não mexe na plataforma nem em empresa que não existe", async () => {
    expect(await setPlatformTenantStatus(app, platform, platformUser, platform, "suspended", at(8))).toBe(false);
    expect(await setPlatformTenantStatus(app, platform, platformUser, randomUUID(), "suspended", at(8))).toBe(false);
  });

  it("uma empresa antiga, sem perfil, ganha o perfil ao ser suspensa", async () => {
    const legacy = await createOrganization(app, "empresa sem perfil");
    expect(await setPlatformTenantStatus(app, platform, platformUser, legacy, "suspended", at(8))).toBe(true);
    expect((await getPlatformTenant(app, platform, legacy, at(8)))?.status).toBe("suspended");
  });
});

describe("renovar o convite de dono", () => {
  it("troca o convite vencido por um novo e para de valer depois que o dono entra", async () => {
    const result = await createPlatformTenant(app, platform, platformUser, form(), at(10));
    if ("refused" in result) throw new Error("refused");
    const later = at(25);
    expect((await getPlatformTenant(app, platform, result.organizationId, later))?.ownerInvite.pending?.expired).toBe(true);

    const renewed = await renewOwnerInvite(app, platform, platformUser, result.organizationId, later);
    if (!renewed.ok) throw new Error(renewed.reason);
    expect(await findInviteByToken(app, renewed.invite.token, later)).toMatchObject({ organizationId: result.organizationId });
    expect((await getPlatformTenant(app, platform, result.organizationId, later))?.ownerInvite.pending?.expired).toBe(false);
    expect(await eventKinds(result.organizationId)).toContain("tenant_owner_invite_renewed");

    await withSystem(app, (q) =>
      q.exec("insert into users (organization_id, email, name, role, password_hash) values ($1, $2, 'Dona', 'owner', 'h')", [result.organizationId, `outra-${randomUUID()}@example.test`]),
    );
    expect(await renewOwnerInvite(app, platform, platformUser, result.organizationId, later)).toEqual({ ok: false, reason: "owner_active" });
    expect((await getPlatformTenant(app, platform, result.organizationId, later))?.ownerInvite).toEqual({ ownerActive: true, pending: null });
  });

  it("sem convite anterior ou sem empresa, recusa", async () => {
    const bare = await createOrganization(app, "empresa sem convite");
    expect(await renewOwnerInvite(app, platform, platformUser, bare, at(10))).toEqual({ ok: false, reason: "no_invite" });
    expect(await renewOwnerInvite(app, platform, platformUser, randomUUID(), at(10))).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("plano pela plataforma", () => {
  it("troca o plano da empresa, registra nas duas organizações e mantém o ciclo", async () => {
    const result = await createPlatformTenant(app, platform, platformUser, form(), at(7));
    if ("refused" in result) throw new Error("refused");
    const id = result.organizationId;
    const before = await withOrg(app, id, getPlanSubscription);
    const saved = await setPlatformTenantPlan(app, platform, platformUser, id, { plan: "growth", overageRule: "bill_overage", overagePriceCentsPerMinute: 90 }, at(9));
    expect(saved).toMatchObject({ plan: "growth", includedMinutes: 1_500, overageRule: "bill_overage", overagePriceCentsPerMinute: 90, cycleStartedOn: before?.cycleStartedOn });
    const tenantEvent = await withSystem(app, (q) => q.one<{ payload: Record<string, unknown> }>("select payload from organization_events where organization_id = $1 and kind = 'plan_changed' order by id desc limit 1", [id]));
    expect(tenantEvent?.payload).toMatchObject({ from: "starter", to: "growth", byOrganizationId: platform, byUserId: platformUser });
    expect(await eventKinds(platform)).toContain("tenant_plan_changed");
  });

  it("quem não é a plataforma não troca; empresa que não existe devolve null", async () => {
    await expect(setPlatformTenantPlan(app, client, platformUser, client, { plan: "scale", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 }, at(9))).rejects.toBeInstanceOf(PlatformOnlyError);
    expect(await setPlatformTenantPlan(app, platform, platformUser, randomUUID(), { plan: "scale", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 }, at(9))).toBeNull();
    expect(await setPlatformTenantPlan(app, platform, platformUser, platform, { plan: "scale", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0 }, at(9))).toBeNull();
  });
});
