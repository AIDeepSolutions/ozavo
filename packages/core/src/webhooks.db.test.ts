import { afterAll, describe, expect, it } from "vitest";
import { createCall, createOrganization, openTestDbs } from "../test/helpers";
import { recordEvent } from "./events";
import { decryptSecret } from "./secrets";
import { DELIVER_SUBSCRIPTION_TASK, queueWebhookEvent } from "./webhook-events";
import { createWebhookSubscription, listWebhookDeliveries, listWebhookSubscriptions, removeWebhookSubscription, rotateWebhookSecret, setWebhookEnabled } from "./webhooks";
import { withOrg } from "./with-org";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const key = Buffer.alloc(32, 9);
const now = new Date("2031-03-01T09:00:00Z");
const tasksOf = async (org: string): Promise<Array<{ kind: string; payload: { subscriptionId: string; envelope: { event: string; data: Record<string, unknown> } }; call_id: string | null }>> =>
  (await owner.pool.query("select kind, payload, call_id from tasks where organization_id = $1 and kind = $2 order by created_at", [org, DELIVER_SUBSCRIPTION_TASK])).rows;

describe("assinaturas de webhook por empresa", () => {
  it("guarda o segredo cifrado, mostra uma vez e nenhuma leitura o devolve", async () => {
    const org = await createOrganization(app, "webhook secret");
    const created = await withOrg(app, org, (q) => createWebhookSubscription(q, { url: "https://hooks.example.com/a", events: ["call.ended"], createdBy: null }, key, now));
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const stored = (await owner.pool.query("select secret_enc from webhook_subscriptions where id = $1", [created.id])).rows[0] as { secret_enc: string };
    expect(stored.secret_enc).not.toContain(created.secret);
    expect(decryptSecret(stored.secret_enc, key)).toBe(created.secret);

    const listed = JSON.stringify(await withOrg(app, org, (q) => listWebhookSubscriptions(q)));
    expect(listed).not.toContain(created.secret);
    expect(listed).not.toContain(stored.secret_enc);
    expect(listed).not.toContain("secret_enc");
    // Nem os eventos do cadastro nem a linha do tempo das entregas carregam o segredo.
    const events = JSON.stringify((await owner.pool.query("select payload from organization_events where organization_id = $1", [org])).rows);
    expect(events).not.toContain(created.secret);
    expect(events).not.toContain(stored.secret_enc);
    expect(JSON.stringify(await withOrg(app, org, (q) => listWebhookDeliveries(q, created.id)))).not.toContain(created.secret);
  });

  it("troca o segredo (o antigo deixa de valer) e registra sem mostrar nenhum dos dois", async () => {
    const org = await createOrganization(app, "webhook rotate");
    const created = await withOrg(app, org, (q) => createWebhookSubscription(q, { url: "https://hooks.example.com/r", events: ["call.ended"], createdBy: null }, key, now));
    const fresh = await withOrg(app, org, (q) => rotateWebhookSecret(q, created.id, key, null, now));
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(created.secret);
    const stored = (await owner.pool.query("select secret_enc from webhook_subscriptions where id = $1", [created.id])).rows[0] as { secret_enc: string };
    expect(decryptSecret(stored.secret_enc, key)).toBe(fresh);
    const events = (await owner.pool.query("select kind, payload from organization_events where organization_id = $1 order by id", [org])).rows as Array<{ kind: string; payload: object }>;
    expect(events.map((event) => event.kind)).toEqual(["webhook_subscription_created", "webhook_secret_rotated"]);
    expect(JSON.stringify(events)).not.toContain(created.secret);
    expect(JSON.stringify(events)).not.toContain(fresh ?? "-");
  });

  it("isolamento: a empresa A não lê, liga, troca nem remove a assinatura da B, e não herda o evento dela", async () => {
    const a = await createOrganization(app, "webhook A");
    const b = await createOrganization(app, "webhook B");
    const subA = await withOrg(app, a, (q) => createWebhookSubscription(q, { url: "https://a.example.com/hook", events: ["usage.alert"], createdBy: null }, key, now));
    const subB = await withOrg(app, b, (q) => createWebhookSubscription(q, { url: "https://b.example.com/hook", events: ["usage.alert"], createdBy: null }, key, now));

    expect((await withOrg(app, a, (q) => listWebhookSubscriptions(q))).map((sub) => sub.id)).toEqual([subA.id]);
    expect(await withOrg(app, a, (q) => setWebhookEnabled(q, subB.id, false, null, now))).toBe(false);
    expect(await withOrg(app, a, (q) => rotateWebhookSecret(q, subB.id, key, null, now))).toBeNull();
    expect(await withOrg(app, a, (q) => removeWebhookSubscription(q, subB.id, null, now))).toBe(false);
    expect((await owner.pool.query("select enabled from webhook_subscriptions where id = $1", [subB.id])).rows).toEqual([{ enabled: true }]);

    // Um fato da B enfileira só para a assinatura da B; nunca uma tarefa da B aponta para a assinatura da A.
    await withOrg(app, b, (q) => queueWebhookEvent(q, b, "usage.alert", { threshold: 80 }, now));
    expect(await tasksOf(a)).toEqual([]);
    expect((await tasksOf(b)).map((task) => task.payload.subscriptionId)).toEqual([subB.id]);
    // Mesmo pedindo a organização errada na chamada, o RLS da transação da A não enxerga a B.
    expect(await withOrg(app, a, (q) => queueWebhookEvent(q, b, "usage.alert", {}, now))).toBe(0);
  });

  it("só enfileira para assinatura ligada que assina o evento", async () => {
    const org = await createOrganization(app, "webhook filter");
    const wants = await withOrg(app, org, (q) => createWebhookSubscription(q, { url: "https://w.example.com/1", events: ["call.outcome", "usage.alert"], createdBy: null }, key, now));
    const other = await withOrg(app, org, (q) => createWebhookSubscription(q, { url: "https://w.example.com/2", events: ["cadence.reduced"], createdBy: null }, key, now));
    const off = await withOrg(app, org, (q) => createWebhookSubscription(q, { url: "https://w.example.com/3", events: ["usage.alert"], createdBy: null }, key, now));
    await withOrg(app, org, (q) => setWebhookEnabled(q, off.id, false, null, now));
    expect(await withOrg(app, org, (q) => queueWebhookEvent(q, org, "usage.alert", { threshold: 100 }, now))).toBe(1);
    const tasks = await tasksOf(org);
    expect(tasks.map((task) => task.payload.subscriptionId)).toEqual([wants.id]);
    expect(tasks[0]?.payload.envelope).toMatchObject({ event: "usage.alert", data: { threshold: 100 } });
    expect(other.id).not.toBe(wants.id);
  });

  it("o fim de qualquer chamada (recordEvent) enfileira call.ended na empresa dona, ligada à chamada", async () => {
    const org = await createOrganization(app, "webhook call ended");
    const sub = await withOrg(app, org, (q) => createWebhookSubscription(q, { url: "https://c.example.com/hook", events: ["call.ended"], createdBy: null }, key, now));
    const callId = await createCall(app, org, now);
    await withOrg(app, org, (q) => recordEvent(q, callId, "call_ended", { status: "completed", reason: "caller_hangup", seconds: 42, costCents: 3, transcriptNeverSent: "x" }, now));
    const tasks = await tasksOf(org);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ call_id: callId, payload: { subscriptionId: sub.id, envelope: { event: "call.ended", data: { callId, status: "completed", reason: "caller_hangup", seconds: 42, costCents: 3 } } } });
    // Só os campos conhecidos vão ao destino.
    expect(tasks[0]?.payload.envelope.data).not.toHaveProperty("transcriptNeverSent");
  });
});
