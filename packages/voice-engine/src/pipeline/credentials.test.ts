import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodePipelineKey, InvalidPipelineKeyError, openPipelineCredentials, parsePipelineKey, sealPipelineCredentials } from "./credentials";

const keys = { deepgram: "dg-test-chave", cartesia: "sk_car_test", openrouter: "sk-or-test" };

describe("chave do motor em pipeline", () => {
  it("ida e volta pelo JSON", () => {
    expect(parsePipelineKey(encodePipelineKey(keys))).toEqual(keys);
  });

  it("cifrada com encryptSecret: o texto em repouso não contém nenhuma das três", () => {
    const secret = randomBytes(32);
    const sealed = sealPipelineCredentials(keys, secret);
    for (const value of Object.values(keys)) expect(sealed).not.toContain(value);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(openPipelineCredentials(sealed, secret)).toEqual(keys);
  });

  it("faltando uma chave, ou texto que não é JSON, recusa sem repetir o que recebeu", () => {
    for (const bad of ["sk-solta", JSON.stringify({ deepgram: "a", cartesia: "b" }), JSON.stringify({ ...keys, openrouter: " " })]) {
      expect(() => parsePipelineKey(bad)).toThrow(InvalidPipelineKeyError);
      try {
        parsePipelineKey(bad);
      } catch (error) {
        expect(String(error)).not.toContain("sk-solta");
      }
    }
  });
});
