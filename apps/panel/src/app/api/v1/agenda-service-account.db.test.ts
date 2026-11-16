import { generateKeyPairSync } from "node:crypto";
import { decryptSecret, withOrg } from "@ozavo/core";
import { agendaConnectorReady, readAgendaConnector } from "@ozavo/tools/agenda";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRET_KEY, call, createOrganization, createUser, startPanel } from "../../../../test/kit";
import { GET as getSetting, PUT as putSetting } from "./settings/[key]/route";

const panel = startPanel();
let org: string;
let owner: string;

beforeAll(async () => {
  org = await createOrganization(panel.app, "agenda-conta-de-servico");
  owner = (await createUser(panel.app, org, "owner")).cookie;
});
afterAll(() => panel.close());

// Chave gerada no teste: nenhuma conta de verdade.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const EMAIL = "ozavo@projeto-falso.iam.gserviceaccount.com";
const keyFile = JSON.stringify({ type: "service_account", project_id: "projeto-falso", client_email: EMAIL, private_key: privateKey });
const params = { key: "agenda.connector" };
const schedule = { calendarId: "agenda@exemplo.com", timezone: "America/Sao_Paulo", workStart: "09:00", workEnd: "18:00", workDays: [1, 2, 3, 4, 5], slotMinutes: 30, services: [] };

describe("Google Agenda por conta de serviço", () => {
  it("guarda a chave cifrada, devolve só o e-mail da conta e já fica pronta para a ligação", async () => {
    const saved = await call(putSetting, { method: "PUT", cookie: owner, params, body: { value: { type: "google_service_account", keyFile, ...schedule } } });
    expect(saved.status).toBe(200);
    const read = await call(getSetting, { cookie: owner, params });
    expect(read.data).toEqual({ key: params.key, value: { type: "google_service_account", clientEmail: EMAIL, keyFile: { configured: true }, ...schedule } });
    for (const response of [saved, read]) expect(response.text).not.toContain("PRIVATE KEY");

    const connector = await withOrg(panel.app, org, (q) => readAgendaConnector(q));
    expect(connector?.type).toBe("google_service_account");
    expect(agendaConnectorReady(connector)).toBe(true);
    if (connector?.type !== "google_service_account") throw new Error("tipo inesperado");
    expect(JSON.stringify(connector)).not.toContain("PRIVATE KEY");
    expect(decryptSecret(connector.privateKeyEnc, SECRET_KEY)).toBe(privateKey);
  });

  it("sem arquivo novo, mantém a chave da mesma conta e recusa trocar de conta sem a chave", async () => {
    const before = await withOrg(panel.app, org, (q) => readAgendaConnector(q));
    const kept = await call(putSetting, { method: "PUT", cookie: owner, params, body: { value: { type: "google_service_account", clientEmail: EMAIL, ...schedule, slotMinutes: 45 } } });
    expect(kept.status).toBe(200);
    const after = await withOrg(panel.app, org, (q) => readAgendaConnector(q));
    expect(after).toMatchObject({ slotMinutes: 45, clientEmail: EMAIL });
    expect(after?.type === "google_service_account" && before?.type === "google_service_account" && after.privateKeyEnc === before.privateKeyEnc).toBe(true);

    const other = await call(putSetting, { method: "PUT", cookie: owner, params, body: { value: { type: "google_service_account", clientEmail: "outra@projeto-falso.iam.gserviceaccount.com", ...schedule } } });
    expect([other.status, other.code]).toEqual([400, "token_required"]);
  });

  it("recusa arquivo que não é de conta de serviço sem repetir o que foi colado", async () => {
    const oauthFile = JSON.stringify({ installed: { client_id: "cid-falso", client_secret: "segredo-falso-que-nao-volta" } });
    const refused = await call(putSetting, { method: "PUT", cookie: owner, params, body: { value: { type: "google_service_account", keyFile: oauthFile, ...schedule } } });
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain("segredo-falso-que-nao-volta");
  });
});
