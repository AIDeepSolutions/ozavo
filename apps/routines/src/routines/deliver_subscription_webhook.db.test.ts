import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_TASK_ATTEMPTS, createWebhookSubscription, decryptSecret, failTask, queueWebhookEvent, verifyWebhookSignature, withOrg, withSystem, type WebhookEnvelope } from "@ozavo/core";
import { afterAll, describe, expect, it } from "vitest";
import { createOrganization, depsFor, fakeFetch, fakeLookup, openTestDbs, secretKey, t0, task } from "../../test/helpers";
import deliver from "./deliver_subscription_webhook";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

const envelope: WebhookEnvelope = { id: "11111111-1111-4111-8111-111111111111", event: "call.ended", occurredAt: t0.toISOString(), data: { callId: "c1", status: "completed" } };
const payloadOf = (subscriptionId: string): Record<string, unknown> => ({ subscriptionId, envelope });

async function subscribe(org: string, url = "https://hooks.example.com/in", events: Array<"call.ended" | "call.outcome" | "usage.alert" | "cadence.reduced"> = ["call.ended"]): Promise<{ id: string; secret: string }> {
  return withOrg(app, org, (q) => createWebhookSubscription(q, { url, events, createdBy: null }, secretKey, t0));
}
const eventsOf = async (org: string): Promise<Array<{ kind: string; payload: Record<string, unknown> }>> =>
  withOrg(owner, org, (q) => q.many<{ kind: string; payload: Record<string, unknown> }>("select kind, payload from organization_events where organization_id = $1 and kind in ('webhook_delivered', 'webhook_failed') order by id", [org]));

/** Um servidor HTTP de verdade, na porta 0, que anota o que recebe. O `fetch` injetado reescreve só o destino. */
async function fakeReceiver(respond: (headers: IncomingHttpHeaders) => { status: number; headers?: Record<string, string> }): Promise<{ fetch: typeof fetch; received: Array<{ headers: IncomingHttpHeaders; body: string }>; close(): Promise<void> }> {
  const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      const answer = respond(request.headers);
      response.writeHead(answer.status, answer.headers);
      response.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const forward: typeof fetch = (input, init) => fetch(`http://127.0.0.1:${port}/captured`, init);
  return { fetch: forward, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("deliver_subscription_webhook", () => {
  it("entrega JSON assinado: quem recebe confere o HMAC com o segredo da assinatura, e o resultado vira evento", async () => {
    const org = await createOrganization(app, "deliver ok");
    const sub = await subscribe(org);
    const receiver = await fakeReceiver(() => ({ status: 200 }));
    try {
      await deliver.run(task(org, "deliver_subscription_webhook", payloadOf(sub.id)), depsFor(app, { fetch: receiver.fetch, lookup: fakeLookup() }));
    } finally {
      await receiver.close();
    }
    expect(receiver.received).toHaveLength(1);
    const { headers, body } = receiver.received[0] ?? { headers: {}, body: "" };
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-ozavo-event"]).toBe("call.ended");
    expect(headers["x-ozavo-delivery"]).toBe(envelope.id);
    expect(JSON.parse(body)).toEqual(envelope);
    const stored = await withOrg(owner, org, (q) => q.one<{ secret_enc: string }>("select secret_enc from webhook_subscriptions where id = $1", [sub.id]));
    expect(decryptSecret(stored?.secret_enc ?? "", secretKey)).toBe(sub.secret);
    expect(verifyWebhookSignature(sub.secret, String(headers["x-ozavo-signature"]), body, t0)).toBe(true);
    expect(verifyWebhookSignature("whsec_errado", String(headers["x-ozavo-signature"]), body, t0)).toBe(false);
    // Repetir um corpo capturado muito depois é recusado pelo carimbo.
    expect(verifyWebhookSignature(sub.secret, String(headers["x-ozavo-signature"]), body, new Date(t0.getTime() + 10 * 60_000))).toBe(false);

    const events = await eventsOf(org);
    expect(events).toEqual([{ kind: "webhook_delivered", payload: { subscriptionId: sub.id, host: "hooks.example.com", event: "call.ended", eventId: envelope.id, attempt: 1, status: 200, final: true } }]);
    expect(JSON.stringify(events)).not.toContain(sub.secret);
  });

  it("falha repetida: cada tentativa vira evento, a fila recua 30 s e 2 min, e a terceira é a última", async () => {
    const org = await createOrganization(app, "deliver retry");
    await subscribe(org);
    const net = fakeFetch(() => new Response("no", { status: 500 }));
    const deps = depsFor(app, { fetch: net.fetch, lookup: fakeLookup() });
    const queued = await withOrg(app, org, (q) => queueWebhookEvent(q, org, "call.ended", { callId: "c1" }, t0));
    expect(queued).toBe(1);
    const row = (await withOrg(owner, org, (q) => q.one<{ id: string; payload: Record<string, unknown> }>("select id, payload from tasks where organization_id = $1 and kind = 'deliver_subscription_webhook'", [org]))) ?? { id: "", payload: {} };

    const delays: number[] = [];
    for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt++) {
      await withSystem(app, (q) => q.exec("update tasks set status = 'running', attempts = $2 where id = $1", [row.id, attempt]));
      const claimed = { ...task(org, "deliver_subscription_webhook", row.payload), id: row.id, attempts: attempt };
      let thrown: unknown;
      try {
        await deliver.run(claimed, deps);
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).toContain("http_500");
      const result = await failTask(app, row.id, String(thrown), t0);
      delays.push((result.runAt.getTime() - t0.getTime()) / 1000);
      expect(result.status).toBe(attempt < MAX_TASK_ATTEMPTS ? "queued" : "failed");
    }
    expect(delays.slice(0, 2)).toEqual([30, 120]);
    const events = await eventsOf(org);
    expect(events.map((event) => [event.kind, event.payload.attempt, event.payload.final, event.payload.error, event.payload.status])).toEqual([
      ["webhook_failed", 1, false, "http_500", 500],
      ["webhook_failed", 2, false, "http_500", 500],
      ["webhook_failed", 3, true, "http_500", 500],
    ]);
    // O mesmo id de evento em todas as tentativas, e o carimbo da assinatura refeito a cada uma.
    expect(new Set(net.requests.map((request) => request.headers["x-ozavo-delivery"])).size).toBe(1);
  });

  it("SSRF: recusa cada classe de destino interno, por IP literal e por DNS, sem abrir conexão", async () => {
    const org = await createOrganization(app, "deliver ssrf");
    const literals = ["https://127.0.0.1/x", "https://10.1.2.3/x", "https://172.16.5.5/x", "https://192.168.0.9/x", "https://169.254.169.254/latest/meta-data", "https://0.0.0.0/x", "https://100.64.0.1/x", "https://[::1]/x", "https://[fc00::1]/x", "https://[fe80::1]/x", "https://[::ffff:127.0.0.1]/x", "https://127.1/x", "https://2130706433/x"];
    for (const url of literals) {
      const sub = await subscribe(org, url);
      const net = fakeFetch();
      await expect(deliver.run(task(org, "deliver_subscription_webhook", payloadOf(sub.id)), depsFor(app, { fetch: net.fetch, lookup: fakeLookup() })), url).rejects.toThrow(/destination_refused/);
      expect(net.requests, url).toEqual([]);
    }
    // DNS que resolve para IP interno no momento da entrega (o cadastro tinha passado com um IP público).
    const dnsCases: Record<string, string[]> = {
      "rebind.example.com": ["10.0.0.8"],
      "metadata.example.com": ["169.254.169.254"],
      "loop.example.com": ["127.0.0.1"],
      "mixed.example.com": ["93.184.216.34", "192.168.1.10"],
      "v6.example.com": ["fd00::5"],
    };
    for (const host of Object.keys(dnsCases)) {
      const sub = await subscribe(org, `https://${host}/hook`);
      const net = fakeFetch();
      await expect(deliver.run(task(org, "deliver_subscription_webhook", payloadOf(sub.id)), depsFor(app, { fetch: net.fetch, lookup: fakeLookup(dnsCases) })), host).rejects.toThrow(/destination_refused/);
      expect(net.requests, host).toEqual([]);
    }
    const failures = await eventsOf(org);
    expect(failures.length).toBe(literals.length + Object.keys(dnsCases).length);
    expect(failures.every((event) => event.kind === "webhook_failed" && String(event.payload.error).startsWith("destination_refused"))).toBe(true);
  });

  it("não segue redirecionamento, nem para um destino público: conta como falha", async () => {
    const org = await createOrganization(app, "deliver redirect");
    const sub = await subscribe(org);
    const receiver = await fakeReceiver(() => ({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    try {
      await expect(deliver.run(task(org, "deliver_subscription_webhook", payloadOf(sub.id)), depsFor(app, { fetch: receiver.fetch, lookup: fakeLookup() }))).rejects.toThrow("redirect_not_followed");
    } finally {
      await receiver.close();
    }
    expect(receiver.received).toHaveLength(1);
    expect((await eventsOf(org))[0]?.payload).toMatchObject({ error: "redirect_not_followed", status: null });
  });

  it("assinatura com http:// (gravada por fora) é recusada na entrega, e erro de rede também vira evento", async () => {
    const org = await createOrganization(app, "deliver http");
    const sub = await subscribe(org);
    const net = fakeFetch();
    // A migration impede http:// no banco; para provar a segunda guarda (a da entrega), tira a trava só neste teste.
    await withOrg(owner, org, (q) => q.exec("alter table webhook_subscriptions drop constraint webhook_subscriptions_url_check"));
    try {
      await withOrg(owner, org, (q) => q.exec("update webhook_subscriptions set url = 'http://hooks.example.com/plain' where id = $1", [sub.id]));
      await expect(deliver.run(task(org, "deliver_subscription_webhook", payloadOf(sub.id)), depsFor(app, { fetch: net.fetch, lookup: fakeLookup() }))).rejects.toThrow(/https/);
      expect(net.requests).toEqual([]);
    } finally {
      await withOrg(owner, org, (q) => q.exec("delete from webhook_subscriptions where id = $1", [sub.id]));
      await withOrg(owner, org, (q) => q.exec("alter table webhook_subscriptions add constraint webhook_subscriptions_url_check check (char_length(url) between 9 and 2000 and url like 'https://%')"));
    }

    const other = await subscribe(org);
    const broken = fakeFetch(() => {
      throw new Error("connect ECONNRESET");
    });
    await expect(deliver.run(task(org, "deliver_subscription_webhook", payloadOf(other.id)), depsFor(app, { fetch: broken.fetch, lookup: fakeLookup() }))).rejects.toThrow("ECONNRESET");
  });

  it("assinatura desligada, removida ou de outra empresa: nada é enviado e a tarefa termina", async () => {
    const a = await createOrganization(app, "deliver iso A");
    const b = await createOrganization(app, "deliver iso B");
    const subA = await subscribe(a);
    const off = await subscribe(a, "https://off.example.com/hook");
    await withOrg(owner, a, (q) => q.exec("update webhook_subscriptions set enabled = false where id = $1", [off.id]));
    const net = fakeFetch();
    const deps = depsFor(app, { fetch: net.fetch, lookup: fakeLookup() });
    // A tarefa da B aponta, por engano ou por adulteração, para a assinatura da A: a B não a enxerga.
    await deliver.run(task(b, "deliver_subscription_webhook", payloadOf(subA.id)), deps);
    await deliver.run(task(a, "deliver_subscription_webhook", payloadOf(off.id)), deps);
    await deliver.run(task(a, "deliver_subscription_webhook", payloadOf("22222222-2222-4222-8222-222222222222")), deps);
    expect(net.requests).toEqual([]);
    expect(await eventsOf(b)).toEqual([]);
    await expect(deliver.run(task(a, "deliver_subscription_webhook", { subscriptionId: "nao-uuid" }), deps)).rejects.toThrow();
  });
});
