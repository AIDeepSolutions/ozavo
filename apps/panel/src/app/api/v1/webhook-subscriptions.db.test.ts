import { withOrg } from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createOrganization, createUser, insert, startPanel } from "../../../../test/kit";
import { POST as createKey } from "./api-keys/route";
import { POST as inbound } from "./hooks/[slug]/route";
import { DELETE as removeHook, PATCH as patchHook } from "./webhook-subscriptions/[id]/route";
import { GET as deliveries } from "./webhook-subscriptions/[id]/deliveries/route";
import { POST as rotate } from "./webhook-subscriptions/[id]/rotate/route";
import { GET as listHooks, POST as createHook } from "./webhook-subscriptions/route";

const panel = startPanel();
let orgA: string;
let orgB: string;
let ownerA: Awaited<ReturnType<typeof createUser>>;
let operatorA: Awaited<ReturnType<typeof createUser>>;
let ownerB: Awaited<ReturnType<typeof createUser>>;
let agent: string;

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const newKey = async (cookie: string, scopes: string[]): Promise<string> => {
  const created = await call(createKey, { method: "POST", cookie, body: { name: "n8n", scopes } });
  expect(created.status).toBe(200);
  return (created.data as { token: string }).token;
};
const addHook = async (cookie: string, url = "https://hooks.example.com/in", events = ["call.ended"]): Promise<{ id: string; secret: string }> => {
  const created = await call(createHook, { method: "POST", cookie, body: { url, events } });
  expect(created.status).toBe(200);
  return created.data as { id: string; secret: string };
};

beforeAll(async () => {
  orgA = await createOrganization(panel.app, "webhook screen A");
  orgB = await createOrganization(panel.app, "webhook screen B");
  ownerA = await createUser(panel.app, orgA, "owner");
  operatorA = await createUser(panel.app, orgA, "operator");
  ownerB = await createUser(panel.app, orgB, "owner");
  agent = await insert(panel.app, orgA, "insert into agents (organization_id, name, engine) values ($1, 'Nico', 'simulated') returning id", [orgA]);
});
afterAll(() => panel.close());

describe("webhooks de saída: cadastro, segredo e isolamento", () => {
  it("mostra o segredo uma vez; lista, ligar/desligar, trocar e eventos nunca o devolvem", async () => {
    const created = await addHook(ownerA.cookie);
    expect(created.secret).toMatch(/^whsec_/);

    const listed = await call(listHooks, { cookie: ownerA.cookie });
    expect(listed.data).toMatchObject({ subscriptions: [{ id: created.id, url: "https://hooks.example.com/in", enabled: true }], events: ["call.ended", "call.outcome", "usage.alert", "cadence.reduced"] });
    expect(listed.text).not.toContain(created.secret);
    expect(listed.text).not.toContain("secret_enc");
    expect(listed.text).not.toContain("whsec_");

    const off = await call(patchHook, { method: "PATCH", cookie: ownerA.cookie, params: { id: created.id }, body: { enabled: false } });
    expect(off.text).not.toContain(created.secret);
    expect((await call(listHooks, { cookie: ownerA.cookie })).data).toMatchObject({ subscriptions: [{ enabled: false }] });

    const rotated = await call(rotate, { method: "POST", cookie: ownerA.cookie, params: { id: created.id } });
    const fresh = (rotated.data as { secret: string }).secret;
    expect(fresh).toMatch(/^whsec_/);
    expect(fresh).not.toBe(created.secret);
    const after = await call(listHooks, { cookie: ownerA.cookie });
    expect(after.text).not.toContain(fresh);
    expect(after.text).not.toContain(created.secret);

    const history = await withOrg(panel.app, orgA, (q) => q.many("select kind, payload from organization_events where payload->>'subscriptionId' = $1 order by id", [created.id]));
    expect(JSON.stringify(history)).not.toContain(created.secret);
    expect(JSON.stringify(history)).not.toContain(fresh);
    expect(history.map((row) => (row as { kind: string }).kind)).toEqual(["webhook_subscription_created", "webhook_subscription_changed", "webhook_secret_rotated"]);
    expect((await call(deliveries, { cookie: ownerA.cookie, params: { id: created.id } })).data).toEqual({ deliveries: [] });
  });

  it("só dono e administrador mexem; operador recebe 403 em tudo", async () => {
    const created = await addHook(ownerA.cookie, "https://hooks.example.com/roles");
    for (const [handler, options] of [
      [listHooks, {}],
      [createHook, { method: "POST", body: { url: "https://x.example.com/", events: ["call.ended"] } }],
      [patchHook, { method: "PATCH", params: { id: created.id }, body: { enabled: false } }],
      [rotate, { method: "POST", params: { id: created.id } }],
      [removeHook, { method: "DELETE", params: { id: created.id } }],
      [deliveries, { params: { id: created.id } }],
    ] as const) {
      const result = await call(handler, { ...options, cookie: operatorA.cookie });
      expect([result.status, result.code]).toEqual([403, "forbidden"]);
    }
  });

  it("isolamento A × B: a outra empresa não vê, liga, troca, lê entregas nem remove", async () => {
    const created = await addHook(ownerA.cookie, "https://hooks.example.com/iso");
    expect((await call(listHooks, { cookie: ownerB.cookie })).data).toMatchObject({ subscriptions: [] });
    for (const [handler, options] of [
      [patchHook, { method: "PATCH", body: { enabled: false } }],
      [rotate, { method: "POST" }],
      [removeHook, { method: "DELETE" }],
      [deliveries, {}],
    ] as const) {
      const result = await call(handler, { ...options, cookie: ownerB.cookie, params: { id: created.id } });
      // `deliveries` devolve lista vazia (nada seu); as demais, 404.
      if (handler === deliveries) expect(result.data).toEqual({ deliveries: [] });
      else expect([result.status, result.code]).toEqual([404, "not_found"]);
    }
    expect((await call(listHooks, { cookie: ownerA.cookie })).text).toContain("hooks.example.com/iso");
  });

  it("recusa o destino no cadastro: http, IP interno e nome que resolve para IP interno", async () => {
    const refuse = async (url: string): Promise<[number, string | undefined]> => {
      const result = await call(createHook, { method: "POST", cookie: ownerA.cookie, body: { url, events: ["call.ended"] } });
      return [result.status, result.code];
    };
    expect(await refuse("http://hooks.example.com/plain")).toEqual([422, "https_required"]);
    for (const url of ["https://127.0.0.1/x", "https://10.0.0.5/x", "https://172.16.0.1/x", "https://192.168.1.1/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://[fe80::1]/x", "https://0.0.0.0/x"]) {
      expect(await refuse(url), url).toEqual([422, "destination_refused"]);
    }
    const previous = panel.deps.lookup;
    panel.deps.lookup = async () => ["10.9.9.9"];
    try {
      expect(await refuse("https://internal.example.com/x")).toEqual([422, "destination_refused"]);
    } finally {
      panel.deps.lookup = previous;
    }
    expect((await call(createHook, { method: "POST", cookie: ownerA.cookie, body: { url: "https://hooks.example.com/ok", events: [] } })).status).toBe(400);
    expect((await call(createHook, { method: "POST", cookie: ownerA.cookie, body: { url: "https://hooks.example.com/ok", events: ["call.started"] } })).status).toBe(400);
  });

  it("remover apaga o cadastro e deixa o rastro na linha do tempo da empresa", async () => {
    const created = await addHook(ownerA.cookie, "https://hooks.example.com/remove");
    expect((await call(removeHook, { method: "DELETE", cookie: ownerA.cookie, params: { id: created.id } })).data).toEqual({ removed: true });
    expect((await call(removeHook, { method: "DELETE", cookie: ownerA.cookie, params: { id: created.id } })).status).toBe(404);
    const kinds = await withOrg(panel.app, orgA, (q) => q.many<{ kind: string }>("select kind from organization_events where payload->>'subscriptionId' = $1 order by id", [created.id]));
    expect(kinds.map((row) => row.kind)).toEqual(["webhook_subscription_created", "webhook_subscription_removed"]);
  });
});

describe("POST /api/v1/hooks/call: entrada por chave com o escopo hooks:inbound", () => {
  const post = (token: string, body: unknown, slug = "call", headers: Record<string, string> = {}) => call(inbound, { method: "POST", headers: { ...bearer(token), ...headers }, body, params: { slug } });

  it("sem o escopo é 403, sem chave é 401, e slug desconhecido é 404", async () => {
    const wrongScope = await newKey(ownerA.cookie, ["calls:outbound"]);
    panel.voice.requests.length = 0;
    const refused = await post(wrongScope, { toE164: "+5511988887777", agentId: agent });
    expect([refused.status, refused.code]).toEqual([403, "forbidden"]);
    expect(refused.message).toContain("hooks:inbound");
    const anonymous = await call(inbound, { method: "POST", body: { toE164: "+5511988887777" }, params: { slug: "call" } });
    expect([anonymous.status, anonymous.code]).toEqual([401, "unauthenticated"]);
    const right = await newKey(ownerA.cookie, ["hooks:inbound"]);
    expect((await post(right, { toE164: "+5511988887777" }, "nao-existe")).status).toBe(404);
    expect((await post(right, { toE164: "+5511988887777" }, "constructor")).status).toBe(404);
    expect(panel.voice.requests).toEqual([]);
    // A chave de entrada também não serve para a rota de ligação nem o contrário.
  });

  it("vira UMA ligação, com o telefone normalizado em E.164, e fica registrada", async () => {
    const token = await newKey(ownerA.cookie, ["hooks:inbound"]);
    panel.voice.requests.length = 0;
    panel.voice.respond = () => Response.json({ callId: "33333333-3333-4333-8333-333333333333" });
    const accepted = await post(token, { toE164: "(11) 98888-7777", agentId: agent, context: { lead: "Ana" }, requestKey: "form-1" });
    expect([accepted.status, accepted.data]).toEqual([202, { callId: "33333333-3333-4333-8333-333333333333", repeated: false }]);
    expect(panel.voice.requests).toHaveLength(1);
    expect(panel.voice.requests[0]?.body).toMatchObject({ organizationId: orgA, agentId: agent, toE164: "+5511988887777", requestKey: "form-1" });
    const logged = await withOrg(panel.app, orgA, (q) => q.many<{ payload: Record<string, unknown> }>("select payload from organization_events where kind = 'inbound_hook_received'"));
    expect(logged.map((row) => row.payload.callId)).toContain("33333333-3333-4333-8333-333333333333");
  });

  it("não aceita lote: lista de números, números a mais e telefone inválido são recusados sem falar com a voz", async () => {
    const token = await newKey(ownerA.cookie, ["hooks:inbound"]);
    panel.voice.requests.length = 0;
    for (const body of [{ toE164: ["+5511988887777", "+5511977776666"] }, { numbers: ["+5511988887777"] }, { toE164: "+5511988887777", toE164List: [] }, [{ toE164: "+5511988887777" }], { toE164: "abc" }, {}]) {
      const result = await post(token, body);
      expect([result.status, result.code], JSON.stringify(body)).toEqual([400, "validation_error"]);
    }
    expect(panel.voice.requests).toEqual([]);
  });

  it("a recusa da política de saída (checkOutboundAllowed, lista de não ligar) chega ao chamador", async () => {
    const token = await newKey(ownerA.cookie, ["hooks:inbound"]);
    panel.voice.respond = () => Response.json({ code: "do_not_call", message: "This number is on the do-not-call list." }, { status: 409 });
    const refused = await post(token, { toE164: "11 98888-7777", agentId: agent });
    expect([refused.status, refused.code]).toEqual([422, "do_not_call"]);
    // O que a voz recebeu já estava normalizado: a lista de não ligar compara em E.164.
    expect(panel.voice.requests.at(-1)?.body).toMatchObject({ toE164: "+5511988887777" });
    const none = await withOrg(panel.app, orgA, (q) => q.many("select 1 from organization_events where kind = 'inbound_hook_received' and payload->>'callId' is null"));
    expect(none).toEqual([]);
  });

  it("respeita o limite por chave que já existe: 60 por minuto, depois 429", async () => {
    const token = await newKey(ownerB.cookie, ["hooks:inbound"]);
    const agentB = await insert(panel.app, orgB, "insert into agents (organization_id, name, engine) values ($1, 'Nico', 'simulated') returning id", [orgB]);
    panel.voice.respond = () => Response.json({ callId: "44444444-4444-4444-8444-444444444444" });
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await post(token, { toE164: "+5511988887777", agentId: agentB })).status;
    expect(last).toBe(429);
  });
});
