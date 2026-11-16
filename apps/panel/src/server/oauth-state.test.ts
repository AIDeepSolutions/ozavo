import { describe, expect, it } from "vitest";
import { createOAuthState, googleRedirectUri, readOAuthState } from "./oauth-state";

const KEY = Buffer.alloc(32, 3);
const NOW = new Date("2026-11-16T12:00:00.000Z");
const who = { organizationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff", userId: "7f9619ff-8b86-4011-b42d-00c04fc964ff" };

describe("OAuth state", () => {
  it("volta com a empresa e a pessoa que pediram", () => {
    expect(readOAuthState(createOAuthState(who, KEY, NOW), KEY, NOW)).toEqual(who);
  });

  it("recusa assinatura de outra chave, conteúdo trocado e state vencido", () => {
    const state = createOAuthState(who, KEY, NOW);
    expect(readOAuthState(state, Buffer.alloc(32, 4), NOW)).toBeNull();
    const [body, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body ?? "", "base64url").toString()), o: who.userId })).toString("base64url");
    expect(readOAuthState(`${forged}.${signature}`, KEY, NOW)).toBeNull();
    expect(readOAuthState(state, KEY, new Date(NOW.getTime() + 11 * 60_000))).toBeNull();
    expect(readOAuthState("lixo", KEY, NOW)).toBeNull();
  });

  it("o retorno é o endereço desta instalação, sem barra dobrada", () => {
    expect(googleRedirectUri("https://ozavo.example/")).toBe("https://ozavo.example/api/v1/connectors/google/callback");
  });
});
