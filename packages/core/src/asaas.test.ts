import { describe, expect, it, vi } from "vitest";
import { asaasClient, asaasEvent } from "./asaas-client";
import { storeAsaasConfig, validAsaasToken } from "./asaas";
import { decryptSecret } from "./secrets";

const key = Buffer.alloc(32, 7);
const token = "fixture-webhook-token-at-least-32-chars";
describe("Asaas security and client", () => {
  it("encrypts credentials, compares digests and requires new credentials on environment change", () => {
    const stored = storeAsaasConfig({ environment: "sandbox", apiKey: "fake-api-key", webhookToken: token, mappings: [] }, null, key);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(decryptSecret(stored.apiKey, key)).toBe("fake-api-key");
    expect(validAsaasToken(token, stored.webhookToken, key)).toBe(true);
    for (const value of ["", "x", token + "x"]) expect(validAsaasToken(value, stored.webhookToken, key)).toBe(false);
    expect(storeAsaasConfig({ environment: "sandbox", mappings: [] }, stored, key)).toEqual(stored);
    expect(() => storeAsaasConfig({ environment: "production", mappings: [] }, stored, key)).toThrow();
  });
  it("strips PII and new provider fields from stored webhook objects", () => {
    const parsed = asaasEvent.parse({ id: "evt_test", event: "PAYMENT_RECEIVED", dateCreated: "2026-11-16 10:00:00", payment: { id: "pay_test", subscription: "sub_test", creditCard: { holder: "Invented" }, customer: "cus_test", invoiceUrl: "private" }, customer: { email: "fake@example.test" } });
    expect(parsed).toEqual({ id: "evt_test", event: "PAYMENT_RECEIVED", dateCreated: "2026-11-16 10:00:00", payment: { id: "pay_test", subscription: "sub_test" } });
  });
  it("uses official sandbox/prod hosts, token header and no redirect, validates API responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "cus_fixture", name: "Fixture", email: "fixture@example.test", cpfCnpj: "private" }));
    expect(await asaasClient("sandbox", "fake", fetcher).customer("cus_fixture")).toEqual({ id: "cus_fixture", name: "Fixture", email: "fixture@example.test" });
    expect(fetcher).toHaveBeenCalledWith("https://api-sandbox.asaas.com/v3/customers/cus_fixture", expect.objectContaining({ headers: { access_token: "fake", "User-Agent": "Ozavo" }, redirect: "error" }));
    fetcher.mockResolvedValueOnce(Response.json({ errors: [{ description: "secret customer email" }] }, { status: 401 }));
    await expect(asaasClient("production", "fake", fetcher).customer("cus_fixture")).rejects.toThrow("Asaas API unavailable");
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.asaas.com/v3/customers/cus_fixture");
    fetcher.mockResolvedValueOnce(Response.json({ id: "wrong", customer: "cus_fixture", value: 497, cycle: "MONTHLY", status: "ACTIVE" }));
    await expect(asaasClient("sandbox", "fake", fetcher).subscription("sub_fixture")).rejects.toThrow("Asaas subscription invalid");
  });
});
