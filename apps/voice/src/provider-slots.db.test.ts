// O teto da conta do provedor de síntese é da instalação: conta as chamadas vivas de todas as
// organizações, recebidas e de saída, sob uma trava global, e a vaga volta quando a chamada acaba
// ou falha antes de conectar.
import { saveOperationSettings, withOrg, withSystem } from "@ozavo/core";
import { afterAll, describe, expect, it } from "vitest";
import { openTestDbs } from "../../../packages/core/test/helpers";
import type { AriChannel } from "./ari";
import { AsteriskCalls } from "./asterisk-transport";
import { handleInbound } from "./inbound";
import { startOutboundCall } from "./outbound";
import { callsOf, createAgent, createOrganization, createPhoneNumber, createTrunk, eventsOf, fakeAri, fakeClock } from "./testing/db";

const { app, owner } = openTestDbs();
afterAll(async () => {
  await app.close();
  await owner.close();
});

// Um dia só para cada caso, longe dos outros arquivos: as chamadas vivas de um não caem na janela do outro.
const day = (n: number): Date => new Date(Date.UTC(2041, 2, n, 15));
const LIMITS = { reducedCallsPerHour: 60, telephonyBrlPerMinute: null, usdBrlRate: null };

async function tenant(label: string, number: string) {
  const organizationId = await createOrganization(app, label);
  const agentId = await createAgent(app, organizationId);
  const trunkId = await createTrunk(app, organizationId, { callerId: number });
  await createPhoneNumber(app, organizationId, trunkId, number, agentId);
  await withSystem(app, (q) => q.exec("insert into outbound_policy (organization_id, enabled, window_start, window_end, timezone) values ($1, true, '00:00', '23:59', 'UTC')", [organizationId]));
  return { organizationId, agentId, trunkId, number };
}

/** A organização da plataforma, com o teto da instalação. Desfeita no fim: o banco é de todos os testes. */
async function withInstallationLimit<T>(limit: number, at: Date, fn: (platformId: string) => Promise<T>): Promise<T> {
  const platformId = await createOrganization(app, "slots-plataforma");
  await withSystem(app, (q) => q.exec("update organizations set platform = true where id = $1", [platformId]));
  await withOrg(app, platformId, (q) => saveOperationSettings(q, { ttsConcurrencyLimit: limit, ...LIMITS }, at));
  try {
    return await fn(platformId);
  } finally {
    await withSystem(app, (q) => q.exec("update organizations set platform = false where id = $1", [platformId]));
  }
}

async function liveCall(organizationId: string, at: Date, extra: { channel?: string; voicemail?: boolean } = {}): Promise<string> {
  const row = await withSystem(app, (q) =>
    q.one<{ id: string }>("insert into calls (organization_id, direction, channel, status, started_at, voicemail) values ($1, 'inbound', $2, 'in_progress', $3, $4) returning id", [
      organizationId,
      extra.channel ?? "phone",
      new Date(at.getTime() - 60_000),
      extra.voicemail ?? false,
    ]),
  );
  return row?.id ?? "";
}

function dialer(org: { organizationId: string; agentId: string }, at: Date) {
  const ari = fakeAri();
  const clock = fakeClock(at);
  const calls = new AsteriskCalls({ ari, db: app, clock, log: () => undefined });
  const dial = (toE164: string) => startOutboundCall({ db: app, ari, clock, calls, log: () => undefined }, { organizationId: org.organizationId, agentId: org.agentId, toE164 });
  return { ari, clock, calls, dial };
}

describe("vagas do provedor de síntese", { timeout: 120_000 }, () => {
  it("o teto da plataforma vale para outra empresa e conta as chamadas recebidas de todas", async () => {
    const a = await tenant("slots-a", "+553140000001");
    const b = await tenant("slots-b", "+553140000002");
    const at = day(3);
    await withInstallationLimit(2, at, async () => {
      // Duas chamadas recebidas da empresa B ocupam as duas vagas; recado e simulada não usam o provedor.
      const first = await liveCall(b.organizationId, at);
      await liveCall(b.organizationId, at);
      await liveCall(b.organizationId, at, { voicemail: true });
      await liveCall(b.organizationId, at, { channel: "simulated" });

      const { ari, dial } = dialer(a, at);
      expect(await dial("+5531999990001")).toMatchObject({ code: "concurrency_limit", message: expect.stringContaining("accepts 2 calls") });
      expect(ari.originated).toEqual([]);

      // A ligação recebida na empresa A também não cabe: ocupado, evento e aviso, nunca silêncio.
      const inboundAri = fakeAri();
      const clock = fakeClock(at);
      const incoming: AriChannel = { id: "canal-slots", name: `PJSIP/trunk-${a.trunkId}-0000002a`, dialplan: { exten: a.number.slice(1) }, caller: { number: "31999998888" } };
      await handleInbound({ db: app, ari: inboundAri, clock, calls: new AsteriskCalls({ ari: inboundAri, db: app, clock, log: () => undefined }), log: () => undefined }, incoming);
      expect(inboundAri.log).toEqual(["hangup canal-slots busy"]);
      const refused = (await callsOf(app, a.organizationId)).find((call) => call.direction === "inbound");
      expect(refused).toMatchObject({ status: "refused", end_reason: "provider_limit_reached" });
      expect(await eventsOf(app, refused?.id ?? "")).toEqual([{ kind: "call_refused", payload: expect.objectContaining({ reason: "provider_limit_reached", limit: 2 }) }]);

      // Uma das chamadas de B termina: a vaga volta.
      await withSystem(app, (q) => q.exec("update calls set status = 'completed', ended_at = $2 where id = $1", [first, at]));
      expect(await dial("+5531999990002")).toEqual({ callId: expect.any(String) });
      expect(ari.originated).toHaveLength(1);
    });
  });

  it("a ligação que falha ao originar devolve a vaga", async () => {
    const a = await tenant("slots-falha", "+553140000003");
    const at = day(5);
    await withInstallationLimit(1, at, async () => {
      const { ari, dial } = dialer(a, at);
      ari.failing = true;
      expect(await dial("+5531999990003")).toMatchObject({ code: "originate_failed" });
      ari.failing = false;
      expect(await dial("+5531999990004")).toEqual({ callId: expect.any(String) });
      expect((await callsOf(app, a.organizationId)).map((call) => call.status).sort()).toEqual(["failed", "ringing"]);
    });
  });

  it("duas empresas ligando ao mesmo tempo não furam a última vaga", async () => {
    const a = await tenant("slots-corrida-a", "+553140000004");
    const b = await tenant("slots-corrida-b", "+553140000005");
    const at = day(7);
    await withInstallationLimit(1, at, async () => {
      const results = await Promise.all([dialer(a, at).dial("+5531999990005"), dialer(b, at).dial("+5531999990006")]);
      expect(results.filter((result) => "callId" in result)).toHaveLength(1);
      expect(results.filter((result) => "code" in result && result.code === "concurrency_limit")).toHaveLength(1);
    });
  });
});
