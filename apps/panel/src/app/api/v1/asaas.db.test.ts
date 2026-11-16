import { randomUUID } from "node:crypto";
import { asaasEvent, getPlanSubscription, processAsaasEvent, provisionTenant, readTenantProfile, receiveAsaasEvent, withOrg, withSystem } from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createOrganization, createUser, startPanel } from "../../../../test/kit";
import { GET, PUT, POST as retry } from "./asaas/route";
import { POST as webhook } from "./webhooks/asaas/route";
import { GET as genericSetting, PUT as genericPut } from "./settings/[key]/route";

const panel = startPanel();
const at = panel.deps.clock.now();
const token = "fixture-webhook-token-32-characters-long";
let platform: string;
let owner: Awaited<ReturnType<typeof createUser>>;
let customerOwner: Awaited<ReturnType<typeof createUser>>;
let operator: Awaited<ReturnType<typeof createUser>>;
let subscriptionValue = 497;
let subscriptionStatus = "ACTIVE";
let broken = false;
const sub = `sub_${randomUUID()}`;
const event = (kind: string, paymentId = "pay_fixture", id = `evt_${randomUUID()}`) => ({ id, event: kind, dateCreated: "2026-11-16 10:00:00", ...(kind.startsWith("PAYMENT_") ? { payment: { id: paymentId, subscription: sub, cardNumber: "PII must be stripped" } } : { subscription: { id: sub } }) });
const send = (body: unknown, secret = token) => call(webhook, { method: "POST", body, headers: { "asaas-access-token": secret } });
const read = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => withOrg(panel.app, platform, (q) => q.many<T>(sql, values));
async function drain() {
  const pending = await read<{ id: string }>("select id from asaas_events where processed_at is null order by received_at, id");
  for (const row of pending) await processAsaasEvent(panel.deps, platform, row.id, at);
}
async function state() {
  const [binding] = await read<{ tenant_id: string; owner_invite_enc: string }>("select tenant_id, owner_invite_enc from asaas_subscriptions where subscription_id = $1", [sub]);
  if (!binding) throw new Error("Missing binding");
  return withOrg(panel.app, binding.tenant_id, async (q) => ({ binding, profile: await readTenantProfile(q), plan: await getPlanSubscription(q), events: await q.many<{ kind: string; payload: unknown }>("select kind, payload from organization_events order by id"), outbound: await q.one<{ enabled: boolean }>("select enabled from outbound_policy") }));
}
beforeAll(async () => {
  platform = await createOrganization(panel.app, "Asaas platform fixture");
  // The route resolves the single platform in this isolated database test, restored afterwards.
  await withSystem(panel.app, async (q) => {
    await q.exec("update organizations set platform = false where platform");
    await q.exec("update organizations set platform = true where id = $1", [platform]);
  });
  owner = await createUser(panel.app, platform, "owner");
  operator = await createUser(panel.app, platform, "operator");
  const other = await createOrganization(panel.app, "Other company");
  customerOwner = await createUser(panel.app, other, "owner");
  panel.voice.respond = (url) => {
    if (broken) throw new Error("provider leaked owner@example.test");
    if (url.includes("/subscriptions/")) return Response.json({ id: sub, customer: "cus_fixture", value: subscriptionValue, cycle: "MONTHLY", status: subscriptionStatus });
    return Response.json({ id: "cus_fixture", name: "Empresa Fixture", email: `asaas-${sub}@example.test`, cpfCnpj: "not persisted" });
  };
});
afterAll(() => panel.close());

describe("native Asaas webhook", () => {
  it("only platform administrators can configure/read/retry, and generic settings cannot bypass it", async () => {
    expect((await send(event("PAYMENT_RECEIVED"))).status).toBe(401);
    const body = { environment: "sandbox", apiKey: "fake-api-key", webhookToken: token, mappings: [] };
    for (const cookie of [customerOwner.cookie, operator.cookie]) {
      expect((await call(PUT, { method: "PUT", cookie, body })).status).toBe(403);
      expect((await call(GET, { cookie })).status).toBe(403);
      expect((await call(retry, { method: "POST", cookie })).status).toBe(403);
    }
    expect((await call(PUT, { method: "PUT", cookie: owner.cookie, body })).status).toBe(200);
    expect((await call(genericSetting, { cookie: owner.cookie, params: { key: "asaas.config" } })).status).toBe(400);
    expect((await call(genericPut, { cookie: customerOwner.cookie, method: "PUT", params: { key: "asaas.config" }, body: { value: body } })).status).toBe(400);
    const [stored] = await read<{ value: unknown; secret: boolean }>("select value, secret from settings where key = 'asaas.config'");
    expect(stored?.secret).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain("fake-api-key");
    for (const secret of ["", "wrong", token + "x"]) expect((await send(event("PAYMENT_RECEIVED"), secret)).status).toBe(401);
    expect((await send({})).status).toBe(400);
  });
  it("stores before ACK, deduplicates concurrent deliveries and strips PII", async () => {
    const body = event("SUBSCRIPTION_CREATED");
    const results = await Promise.all([send(body), send(body), send(body)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => (r.data as { repeated: boolean }).repeated === false)).toHaveLength(1);
    expect(await read("select id from tasks where kind = 'process_asaas_event'")).toHaveLength(1);
    await drain();
    expect((await state()).profile.status).toBe("suspended");
    expect((await state()).plan).toMatchObject({ plan: "starter", includedMinutes: 300, monthlyPriceCents: 49700 });
  });
  it("activates once per payment and exposes the stable owner invite only to platform", async () => {
    await send(event("PAYMENT_CONFIRMED")); await drain();
    const initial = await state();
    expect(initial.profile.status).toBe("active");
    expect(initial.outbound?.enabled).toBe(false);
    const view = await call(GET, { cookie: owner.cookie });
    const invite = (view.data as { subscriptions: Array<{ ownerInviteUrl: string }> }).subscriptions[0]?.ownerInviteUrl;
    expect(invite).toMatch(/^https:\/\/panel.test\/invite\//);
    expect(initial.binding.owner_invite_enc).not.toContain(invite?.split("/").at(-1));
    await send(event("PAYMENT_RECEIVED")); await drain();
    expect((await state()).binding.owner_invite_enc).toBe(initial.binding.owner_invite_enc);
    expect(await read("select * from asaas_payments")).toHaveLength(1);
    expect((await state()).events.filter((e) => e.kind === "tenant_provisioned")).toHaveLength(1);
    expect(JSON.stringify(await read("select payload from asaas_events"))).not.toContain("PII");
    expect(JSON.stringify((await state()).events)).not.toContain("@example.test");
  });
  it("overdue blocks until paid; late overdue for an already paid payment cannot suspend", async () => {
    await send(event("PAYMENT_OVERDUE", "pay_next")); await drain();
    expect((await state()).profile.status).toBe("suspended");
    await send(event("PAYMENT_RECEIVED", "pay_fixture")); await drain();
    expect((await state()).profile.status).toBe("suspended");
    await send(event("PAYMENT_CONFIRMED", "pay_next")); await drain();
    expect((await state()).profile.status).toBe("active");
    await send(event("PAYMENT_OVERDUE", "pay_next")); await drain();
    expect((await state()).profile.status).toBe("active");
  });
  it("updates catalog allowances and supports explicit custom mapping", async () => {
    subscriptionValue = 997;
    await send(event("SUBSCRIPTION_UPDATED")); await drain();
    expect((await state()).plan).toMatchObject({ plan: "pro", includedMinutes: 750 });
    subscriptionValue = 1234;
    await call(PUT, { method: "PUT", cookie: owner.cookie, body: { environment: "sandbox", mappings: [{ subscriptionId: sub, plan: "custom", includedMinutes: 900, maxConcurrentCalls: 5 }] } });
    await send(event("SUBSCRIPTION_UPDATED")); await drain();
    expect((await state()).plan).toMatchObject({ plan: "custom", includedMinutes: 900, monthlyPriceCents: 123400, maxConcurrentCalls: 5 });
  });
  it("retains API failures, emits sanitized errors and allows replay", async () => {
    broken = true;
    await send(event("SUBSCRIPTION_UPDATED"));
    await expect(drain()).rejects.toThrow("Asaas event processing failed");
    expect(await read("select id from asaas_events where processed_at is null")).toHaveLength(1);
    const before = (await state()).plan;
    expect(before?.plan).toBe("custom");
    broken = false; await drain();
    expect(await read("select id from asaas_events where processed_at is null")).toHaveLength(0);
    // Failed queue tasks are re-enqueued only once even for concurrent retry actions.
    const body = asaasEvent.parse(event("SUBSCRIPTION_UPDATED"));
    await withOrg(panel.app, platform, (q) => receiveAsaasEvent(q, "sandbox", body, at));
    await withOrg(panel.app, platform, (q) => q.exec("update tasks set status = 'failed' where kind = 'process_asaas_event'"));
    const retries = await Promise.all([call(retry, { cookie: owner.cookie, method: "POST" }), call(retry, { cookie: owner.cookie, method: "POST" })]);
    expect(retries.map((r) => (r.data as { queued: number }).queued).reduce((a, b) => a + b, 0)).toBe(1);
    await drain();
  });
  it("concurrent processing creates a single receipt effect", async () => {
    const body = asaasEvent.parse(event("SUBSCRIPTION_UPDATED"));
    await withOrg(panel.app, platform, (q) => receiveAsaasEvent(q, "sandbox", body, at));
    const [receipt] = await read<{ id: string }>("select id from asaas_events where event_id = $1", [body.id]);
    if (!receipt) throw new Error("Missing receipt");
    const count = (await state()).events.length;
    await Promise.all([processAsaasEvent(panel.deps, platform, receipt.id, at), processAsaasEvent(panel.deps, platform, receipt.id, at)]);
    expect((await state()).events).toHaveLength(count + 1);
  });
  it("deletion before creation prevents late provisioning without calling API", async () => {
    const missingSub = `sub_deleted_${randomUUID()}`;
    const deleted = { ...event("SUBSCRIPTION_DELETED"), subscription: { id: missingSub } };
    await send(deleted); await drain();
    const [binding] = await read<{ cancelled: boolean; tenant_id: string | null }>("select cancelled, tenant_id from asaas_subscriptions where subscription_id = $1", [missingSub]);
    expect(binding).toEqual({ cancelled: true, tenant_id: null });
    broken = true;
    await send({ ...event("SUBSCRIPTION_CREATED"), subscription: { id: missingSub } }); await drain();
    broken = false;
    expect(await read("select id from asaas_events where processed_at is null")).toHaveLength(0);
  });
  it("inactivation suspends and deletion is terminal even after a late payment", async () => {
    subscriptionStatus = "INACTIVE";
    await send(event("SUBSCRIPTION_INACTIVATED")); await drain();
    expect((await state()).profile.status).toBe("suspended");
    await send(event("SUBSCRIPTION_DELETED")); await drain();
    subscriptionStatus = "ACTIVE";
    await send(event("PAYMENT_RECEIVED", "pay_after_delete")); await drain();
    expect((await state()).profile.status).toBe("suspended");
    const [binding] = await read<{ cancelled: boolean }>("select cancelled from asaas_subscriptions");
    expect(binding?.cancelled).toBe(true);
  });
  it("adopts and cancels a Phase 2 tenant when deletion is its first native production event", async () => {
    const legacySub = `sub_legacy_${randomUUID()}`;
    const provisioned = await provisionTenant(panel.app, { source: "asaas", externalRef: legacySub,
      company: { legalName: "Legacy fixture", tradeName: null, cnpj: null }, owner: { name: "Legacy owner", email: `${legacySub}@example.test` },
      plan: { code: "pro", monthlyMinutes: 750 }, agent: { name: "Nico", personaName: "Nico", voiceId: null, basePrompt: "", instructions: "Fixture", greeting: null, engine: "simulated", tools: [] }, secrets: [], requestedBy: platform,
    }, at);
    if ("refused" in provisioned) throw new Error("Fixture refused");
    await call(PUT, { method: "PUT", cookie: owner.cookie, body: { environment: "production", apiKey: "fake-production-key", webhookToken: token, mappings: [] } });
    await send({ ...event("SUBSCRIPTION_DELETED"), subscription: { id: legacySub } }); await drain();
    expect(await withOrg(panel.app, provisioned.organizationId, readTenantProfile)).toMatchObject({ status: "suspended" });
    expect(await read("select tenant_id, cancelled from asaas_subscriptions where subscription_id = $1", [legacySub])).toEqual([{ tenant_id: provisioned.organizationId, cancelled: true }]);
  });
});
