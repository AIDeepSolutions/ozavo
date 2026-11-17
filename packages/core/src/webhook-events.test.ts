import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "./webhook-events";

const secret = "whsec_test-secret";
const body = JSON.stringify({ id: "e1", event: "call.ended", data: { callId: "c1" } });
const now = new Date("2031-03-01T09:00:00Z");

describe("assinatura do webhook", () => {
  it("é conferível por quem recebe, com o segredo e o corpo exatos", () => {
    const header = signWebhook(secret, body, now);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, now)).toBe(true);
  });

  it("recusa corpo alterado, segredo errado e cabeçalho malformado", () => {
    const header = signWebhook(secret, body, now);
    expect(verifyWebhookSignature(secret, header, body.replace("c1", "c2"), now)).toBe(false);
    expect(verifyWebhookSignature("whsec_outro", header, body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, "lixo", body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, "t=abc,v1=00", body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, `t=${Math.floor(now.getTime() / 1000)},v1=zz`, body, now)).toBe(false);
  });

  it("recusa carimbo fora da tolerância (repetição), para o passado e para o futuro", () => {
    const header = signWebhook(secret, body, now);
    expect(verifyWebhookSignature(secret, header, body, new Date(now.getTime() + 299_000))).toBe(true);
    expect(verifyWebhookSignature(secret, header, body, new Date(now.getTime() + 301_000))).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, new Date(now.getTime() - 301_000))).toBe(false);
  });

  it("o carimbo entra na assinatura: trocar o t invalida o v1", () => {
    const header = signWebhook(secret, body, now);
    const forged = header.replace(/t=\d+/, `t=${Math.floor(now.getTime() / 1000) + 10}`);
    expect(verifyWebhookSignature(secret, forged, body, now)).toBe(false);
  });
});
