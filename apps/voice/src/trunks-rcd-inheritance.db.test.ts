// A linha sem nome RCD próprio usa o da empresa (`tenant_profiles.rcd_display_name`); o nome da
// linha, quando existe, vence. Vale no arquivo de troncos e na ligação de saída.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withSystem } from "@ozavo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDbs } from "../../../packages/core/test/helpers";
import { randomUUID } from "node:crypto";
import { AsteriskCalls } from "./asterisk-transport";
import type { AudioSocketConnection } from "./audiosocket";
import { startOutboundCall } from "./outbound";
import { createAgent, createOrganization, createPhoneNumber, createTrunk, fakeAri, fakeClock, secretKey } from "./testing/db";
import { applyTrunks } from "./trunks";

const { app, owner } = openTestDbs();
let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "ozavo-rcd-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
  await app.close();
  await owner.close();
});

const setCompanyName = (organizationId: string, name: string | null) =>
  withSystem(app, (q) =>
    q.exec(
      `insert into tenant_profiles (organization_id, rcd_display_name, created_at, updated_at) values ($1, $2, now(), now())
       on conflict (organization_id) do update set rcd_display_name = excluded.rcd_display_name`,
      [organizationId, name],
    ),
  );

describe("herança do nome RCD da empresa", { timeout: 120_000 }, () => {
  it("o arquivo de troncos usa o nome da empresa na linha sem nome e preserva o da linha que tem", async () => {
    const organizationId = await createOrganization(app, "rcd-inherit-conf");
    const inherits = await createTrunk(app, organizationId, { host: "sip.heranca.example", username: "conta1", callerId: "+553133334444" });
    const own = await createTrunk(app, organizationId, { host: "sip.propria.example", username: "conta2", callerId: "+553133335555" });
    await withSystem(app, (q) => q.exec("update trunks set caller_display_name = 'LINHA PROPRIA' where id = $1", [own]));
    await setCompanyName(organizationId, "CLINICA SAO JOAO LTDA");

    const ari = fakeAri();
    const file = path.join(scratch, "rcd", "pjsip_trunks.conf");
    ari.loadsFile = file;
    await applyTrunks({ db: app, ari, clock: fakeClock(), secretKey, file, publicIp: "203.0.113.10", log: () => undefined });
    const conf = await readFile(file, "utf8");
    const block = (id: string) => conf.slice(conf.indexOf(`[trunk-${id}]`), conf.indexOf(`[trunk-${id}-auth]`));
    expect(block(inherits)).toContain("set_var=__OZAVO_CALLER_NAME=CLINICA SAO JOAO LTDA");
    expect(block(own)).toContain("set_var=__OZAVO_CALLER_NAME=LINHA PROPRIA");

    // Sem nome na empresa, a linha sem nome volta a não apresentar nome.
    await setCompanyName(organizationId, null);
    await applyTrunks({ db: app, ari, clock: fakeClock(), secretKey, file, publicIp: "203.0.113.10", log: () => undefined });
    const cleared = await readFile(file, "utf8");
    expect(cleared.slice(cleared.indexOf(`[trunk-${inherits}]`), cleared.indexOf(`[trunk-${inherits}-auth]`))).toContain("set_var=__OZAVO_CALLER_NAME=\n");
  });

  it("a ligação de saída leva o nome da empresa e continua passando pela política de saída", async () => {
    const organizationId = await createOrganization(app, "rcd-inherit-outbound");
    const agentId = await createAgent(app, organizationId);
    const trunkId = await createTrunk(app, organizationId, { callerId: "+553133334444" });
    await createPhoneNumber(app, organizationId, trunkId, "+553133334444", agentId);
    await setCompanyName(organizationId, "CLINICA SAO JOAO LTDA");
    const ari = fakeAri();
    const clock = fakeClock();
    const calls = new AsteriskCalls({ ari, db: app, clock, log: () => undefined });
    const deps = { db: app, ari, clock, calls, log: () => undefined };

    // Política desligada (o padrão): recusa, sem originar, mesmo com identidade herdada.
    expect(await startOutboundCall(deps, { organizationId, agentId, toE164: "+5531999998888" })).toMatchObject({ code: "outbound_disabled" });
    expect(ari.originated).toEqual([]);

    await withSystem(app, (q) => q.exec("insert into outbound_policy (organization_id, enabled, window_start, window_end) values ($1, true, '00:00', '23:59')", [organizationId]));
    expect(await startOutboundCall(deps, { organizationId, agentId, toE164: "+5531999998888" })).toHaveProperty("callId");
    expect(ari.originated[0]?.callerId).toBe("CLINICA SAO JOAO LTDA <+553133334444>");
  });

  it("a transferência leva o nome da empresa na linha sem nome e o da linha na que tem", async () => {
    const organizationId = await createOrganization(app, "rcd-inherit-transfer");
    await setCompanyName(organizationId, "CLINICA SAO JOAO LTDA");
    const transferred = async (trunkId: string) => {
      const ari = fakeAri();
      const calls = new AsteriskCalls({ ari, db: app, clock: fakeClock(), log: () => undefined });
      const callId = randomUUID();
      const channelId = `chan-${callId}`;
      calls.expect({ callId, channelId, organizationId, agentId: null, trunkId });
      const connection: AudioSocketConnection = {
        id: callId,
        onAudio: () => undefined,
        onDtmf: () => undefined,
        onClose: () => undefined,
        sendAudio: () => undefined,
        sendTone: async () => undefined,
        clearAudio: () => undefined,
        drained: async () => undefined,
        close: () => undefined,
      };
      const attached = calls.attach(connection);
      await attached?.transport.transfer?.("+5531988887777");
      await calls.afterAudio(channelId);
      return ari.log.filter((line) => line.includes("OZAVO_CALLER_NAME") || line.startsWith("continue"));
    };
    const inherits = await createTrunk(app, organizationId, { host: "sip.transf1.example", username: "t1", callerId: "+553133334444" });
    const own = await createTrunk(app, organizationId, { host: "sip.transf2.example", username: "t2", callerId: "+553133335555" });
    await withSystem(app, (q) => q.exec("update trunks set caller_display_name = 'LINHA PROPRIA' where id = $1", [own]));
    const fromCompany = await transferred(inherits);
    expect(fromCompany.some((line) => line.endsWith("__OZAVO_CALLER_NAME=CLINICA SAO JOAO LTDA"))).toBe(true);
    const fromLine = await transferred(own);
    expect(fromLine.some((line) => line.endsWith("__OZAVO_CALLER_NAME=LINHA PROPRIA"))).toBe(true);
  });
});
