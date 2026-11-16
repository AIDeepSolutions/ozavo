import { withOrg, withSystem } from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createOrganization, createUser, insert, startPanel } from "../../../../test/kit";
import { DELETE as revokeKey } from "./api-keys/[id]/route";
import { GET as listKeys, POST as createKey } from "./api-keys/route";
import { POST as outbound } from "./calls/outbound/route";
import { GET as getProfile, PUT as putProfile } from "./tenant-profile/route";
import { POST as acceptInvite } from "./invites/[token]/accept/route";
import { POST as provision } from "./tenants/provision/route";

const panel = startPanel();
let org: string;
let owner: Awaited<ReturnType<typeof createUser>>;
let operator: Awaited<ReturnType<typeof createUser>>;
let agent: string;
let platformOrg: string;
let platformOwner: Awaited<ReturnType<typeof createUser>>;

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
const newKey = async (cookie: string, scopes: string[], name = "crm"): Promise<{ id: string; token: string; prefix: string }> => {
  const created = await call(createKey, { method: "POST", cookie, body: { name, scopes } });
  expect(created.status).toBe(200);
  return created.data as { id: string; token: string; prefix: string };
};

beforeAll(async () => {
  org = await createOrganization(panel.app, "api access");
  owner = await createUser(panel.app, org, "owner");
  operator = await createUser(panel.app, org, "operator");
  agent = await insert(panel.app, org, "insert into agents (organization_id, name, engine) values ($1, 'Nico', 'simulated') returning id", [org]);
  platformOrg = await createOrganization(panel.app, "api access platform");
  await withSystem(panel.app, (q) => q.exec("update organizations set platform = true where id = $1", [platformOrg]));
  platformOwner = await createUser(panel.app, platformOrg, "owner");
});
afterAll(() => panel.close());

describe("API keys", () => {
  it("shows the key once, stores only its digest and lists it without the secret", async () => {
    const key = await newKey(owner.cookie, ["calls:outbound"]);
    expect(key.token).toMatch(/^ozk_[A-Za-z0-9_-]{43}$/);
    expect(key.token.startsWith(key.prefix)).toBe(true);
    const stored = await withOrg(panel.app, org, (q) => q.one<{ key_hash: string }>("select key_hash from api_keys where id = $1", [key.id]));
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.key_hash).not.toContain(key.token);

    const listed = await call(listKeys, { cookie: owner.cookie });
    expect(listed.text).not.toContain(key.token);
    expect(listed.text).not.toContain(stored?.key_hash ?? "-");
    // Esta organização não administra a instalação: o escopo de provisionar nem é oferecido.
    expect(listed.data).toMatchObject({ scopes: ["calls:outbound"] });
  });

  it("refuses the provisioning scope outside the platform organization, and operators cannot manage keys", async () => {
    const refused = await call(createKey, { method: "POST", cookie: owner.cookie, body: { name: "x", scopes: ["tenants:provision"] } });
    expect([refused.status, refused.code]).toEqual([403, "platform_scope"]);
    const operatorTry = await call(createKey, { method: "POST", cookie: operator.cookie, body: { name: "x", scopes: ["calls:outbound"] } });
    expect([operatorTry.status, operatorTry.code]).toEqual([403, "forbidden"]);
  });

  it("revokes for good, and a revoked key is refused like an unknown one", async () => {
    const key = await newKey(owner.cookie, ["calls:outbound"], "temporary");
    const revoked = await call(revokeKey, { method: "DELETE", cookie: owner.cookie, params: { id: key.id } });
    expect(revoked.data).toEqual({ revoked: true });
    const again = await call(revokeKey, { method: "DELETE", cookie: owner.cookie, params: { id: key.id } });
    expect(again.status).toBe(404);
    const used = await call(outbound, { method: "POST", headers: bearer(key.token), body: { toE164: "+5511988887777", agentId: agent } });
    expect([used.status, used.code]).toEqual([401, "unauthenticated"]);
    const events = await withOrg(panel.app, org, (q) => q.many<{ kind: string }>("select kind from organization_events where payload->>'apiKeyId' = $1 order by id", [key.id]));
    expect(events.map((event) => event.kind)).toEqual(["api_key_created", "api_key_revoked"]);
  });
});

describe("POST /api/v1/calls/outbound with an API key", () => {
  it("goes straight to the voice process with the key, the context and the repeat key, using the default agent", async () => {
    const key = await newKey(owner.cookie, ["calls:outbound"]);
    await call(putProfile, { method: "PUT", cookie: owner.cookie, body: { legalName: null, cnpj: null, tradeName: null, personaName: "Nico", defaultVoiceId: null, basePrompt: "", defaultAgentId: agent } });
    panel.voice.requests.length = 0;
    panel.voice.respond = () => Response.json({ callId: "11111111-1111-4111-8111-111111111111" });

    const result = await call(outbound, {
      method: "POST",
      headers: { ...bearer(key.token), "idempotency-key": "lead-42" },
      body: { toE164: "(11) 98888-7777", context: { lead: "Ana", motivo: "orçamento" } },
    });
    expect([result.status, result.data]).toEqual([202, { callId: "11111111-1111-4111-8111-111111111111", repeated: false }]);
    expect(panel.voice.requests).toEqual([
      {
        url: "http://voice.test/calls/outbound",
        body: { organizationId: org, agentId: agent, toE164: "+5511988887777", apiKeyId: key.id, context: { lead: "Ana", motivo: "orçamento" }, requestKey: "lead-42" },
      },
    ]);
  });

  it("passes the voice process refusal through (outbound policy) and refuses a key without the scope", async () => {
    const key = await newKey(owner.cookie, ["calls:outbound"]);
    panel.voice.respond = () => Response.json({ code: "outbound_disabled", message: "Outbound calls are turned off for this organization." }, { status: 409 });
    const refused = await call(outbound, { method: "POST", headers: bearer(key.token), body: { toE164: "+5511988887777", agentId: agent } });
    expect([refused.status, refused.code]).toEqual([422, "outbound_disabled"]);

    const platformKey = await newKey(platformOwner.cookie, ["tenants:provision"]);
    const noScope = await call(outbound, { method: "POST", headers: bearer(platformKey.token), body: { toE164: "+5511988887777" } });
    expect([noScope.status, noScope.code]).toEqual([403, "forbidden"]);
  });

  it("refuses an agent from another company and oversized context", async () => {
    const key = await newKey(owner.cookie, ["calls:outbound"]);
    const other = await createOrganization(panel.app, "api access other");
    const foreign = await insert(panel.app, other, "insert into agents (organization_id, name, engine) values ($1, 'Outro', 'simulated') returning id", [other]);
    const result = await call(outbound, { method: "POST", headers: bearer(key.token), body: { toE164: "+5511988887777", agentId: foreign } });
    expect(result.status).toBe(404);
    const big = await call(outbound, { method: "POST", headers: bearer(key.token), body: { toE164: "+5511988887777", agentId: agent, context: { note: "x".repeat(9000) } } });
    expect([big.status, big.code]).toEqual([400, "validation_error"]);
  });
});

describe("tenant profile", () => {
  it("saves the company data, normalizes the CNPJ and refuses an invalid one", async () => {
    const saved = await call(putProfile, {
      method: "PUT",
      cookie: owner.cookie,
      body: { legalName: "Clínica Exemplo Ltda", cnpj: "11.222.333/0001-81", tradeName: "Clínica Exemplo", personaName: "Nico", defaultVoiceId: "voz-1", basePrompt: "Seja breve.", defaultAgentId: agent },
    });
    expect(saved.data).toMatchObject({ cnpj: "11222333000181", personaName: "Nico", basePrompt: "Seja breve.", status: "active" });
    expect((await call(getProfile, { cookie: operator.cookie })).data).toMatchObject({ tradeName: "Clínica Exemplo" });
    const invalid = await call(putProfile, {
      method: "PUT",
      cookie: owner.cookie,
      body: { legalName: null, cnpj: "11.222.333/0001-82", tradeName: null, personaName: "Nico", defaultVoiceId: null, basePrompt: "", defaultAgentId: null },
    });
    expect([invalid.status, invalid.code]).toEqual([400, "validation_error"]);
  });
});

describe("POST /api/v1/tenants/provision", () => {
  const request = (externalRef: string, email: string) => ({
    source: "asaas",
    externalRef,
    company: { legalName: "Imobiliária Teste Ltda", tradeName: "Imobiliária Teste", cnpj: "11222333000181" },
    owner: { name: "Dona", email },
    plan: { code: "pro", monthlyMinutes: 750 },
    agent: { personaName: "Nico", basePrompt: "Atenda com calma." },
    credentials: { "gemini-live": "chave-de-teste" },
  });

  it("creates the company ready to work, once, and answers the repeat with the same company", async () => {
    const key = await newKey(platformOwner.cookie, ["tenants:provision"]);
    const email = `dona-${crypto.randomUUID()}@example.test`;
    const ref = `sub_${crypto.randomUUID()}`;
    const created = await call(provision, { method: "POST", headers: bearer(key.token), body: request(ref, email) });
    expect(created.status).toBe(201);
    const data = created.data as { organizationId: string; ownerUserId: string | null; agentId: string; ownerInviteUrl: string; ownerInviteExpiresAt: string; created: boolean; loginUrl: string };
    expect(data).toMatchObject({ created: true, ownerUserId: null, loginUrl: "https://panel.test/login" });
    // Nenhuma senha no corpo: o dono recebe um convite de uso único e escolhe a senha (auditoria A18).
    expect(created.text).not.toMatch(/password/i);
    expect(data.ownerInviteUrl).toMatch(/^https:\/\/panel\.test\/invite\/[A-Za-z0-9_-]{40,}$/);
    expect(Number.isNaN(Date.parse(data.ownerInviteExpiresAt))).toBe(false);

    const state = await withOrg(panel.app, data.organizationId, async (q) => ({
      profile: await q.one("select plan_code, monthly_minutes, persona_name, base_prompt, default_agent_id, status from tenant_profiles"),
      agent: await q.one<{ name: string; instructions: string }>("select name, instructions from agents where id = $1", [data.agentId]),
      policy: await q.one("select enabled from outbound_policy"),
      secret: await q.one<{ value: string; secret: boolean }>("select value, secret from settings where key = 'engine.gemini-live.api_key'"),
      events: await q.many<{ kind: string }>("select kind from organization_events order by id"),
    }));
    expect(state.profile).toEqual({ plan_code: "pro", monthly_minutes: 750, persona_name: "Nico", base_prompt: "Atenda com calma.", default_agent_id: data.agentId, status: "active" });
    expect(state.agent?.name).toBe("Nico");
    expect(state.agent?.instructions).toContain("Imobiliária Teste");
    // Ligações de saída nascem desligadas também na empresa provisionada.
    expect(state.policy).toEqual({ enabled: false });
    expect(state.secret?.secret).toBe(true);
    expect(state.secret?.value).not.toContain("chave-de-teste");
    // O plano "pro" é do catálogo: a empresa já nasce com a franquia contratada (motor de planos).
    expect(state.events.map((event) => event.kind)).toEqual(["tenant_provisioned", "plan_changed"]);

    // Quem perdeu a primeira resposta repete: o dono ainda não entrou, então sai um link novo e o antigo morre.
    const repeated = await call(provision, { method: "POST", headers: bearer(key.token), body: request(ref, email) });
    expect(repeated.status).toBe(200);
    const again = repeated.data as { ownerInviteUrl: string };
    expect(repeated.data).toMatchObject({ created: false, organizationId: data.organizationId, agentId: data.agentId, ownerUserId: null });
    expect(again.ownerInviteUrl).not.toBe(data.ownerInviteUrl);
    const tokenOf = (link: string): string => link.slice(link.lastIndexOf("/") + 1);
    const stale = await call(acceptInvite, { method: "POST", params: { token: tokenOf(data.ownerInviteUrl) }, body: { name: "Dona", password: "a-long-enough-password" } });
    expect(stale.status).not.toBe(200);
    const accepted = await call(acceptInvite, { method: "POST", params: { token: tokenOf(again.ownerInviteUrl) }, body: { name: "Dona", password: "a-long-enough-password" } });
    expect(accepted.status).toBe(200);
    const ownerRow = await withSystem(panel.app, (q) => q.one<{ id: string; role: string; organization_id: string }>("select id, role, organization_id from users where email = $1", [email]));
    expect(ownerRow).toMatchObject({ role: "owner", organization_id: data.organizationId });

    // Com o dono dentro, a repetição devolve o dono e nenhum convite.
    const afterOwner = await call(provision, { method: "POST", headers: bearer(key.token), body: request(ref, email) });
    expect(afterOwner.data).toMatchObject({ created: false, ownerUserId: ownerRow?.id });
    expect(afterOwner.text).not.toContain("ownerInviteUrl");
    const count = await withSystem(panel.app, (q) => q.one<{ n: number }>("select count(*)::int as n from tenant_profiles where external_ref = $1", [ref]));
    expect(count?.n).toBe(1);
  });

  it("refuses a taken e-mail, a key from a company that is not the platform, and an unknown engine", async () => {
    const key = await newKey(platformOwner.cookie, ["tenants:provision"]);
    const taken = await call(provision, { method: "POST", headers: bearer(key.token), body: request(`sub_${crypto.randomUUID()}`, owner.email) });
    expect([taken.status, taken.code]).toEqual([409, "email_taken"]);
    const badEngine = await call(provision, { method: "POST", headers: bearer(key.token), body: { ...request(`sub_${crypto.randomUUID()}`, "x@example.test"), agent: { engine: "made-up" } } });
    expect([badEngine.status, badEngine.code]).toEqual([400, "validation_error"]);
    // A chave com o escopo, mas de uma empresa que deixou de ser a plataforma, não provisiona.
    await withSystem(panel.app, (q) => q.exec("update organizations set platform = false where id = $1", [platformOrg]));
    try {
      const notPlatform = await call(provision, { method: "POST", headers: bearer(key.token), body: request(`sub_${crypto.randomUUID()}`, "y@example.test") });
      expect([notPlatform.status, notPlatform.code]).toEqual([403, "forbidden"]);
    } finally {
      await withSystem(panel.app, (q) => q.exec("update organizations set platform = true where id = $1", [platformOrg]));
    }
  });

  it("stops accepting the company's keys when the company is suspended", async () => {
    const key = await newKey(owner.cookie, ["calls:outbound"]);
    await withOrg(panel.app, org, (q) => q.exec("update tenant_profiles set status = 'suspended'"));
    try {
      const used = await call(outbound, { method: "POST", headers: bearer(key.token), body: { toE164: "+5511988887777", agentId: agent } });
      expect([used.status, used.code]).toEqual([401, "unauthenticated"]);
    } finally {
      await withOrg(panel.app, org, (q) => q.exec("update tenant_profiles set status = 'active'"));
    }
  });
});
