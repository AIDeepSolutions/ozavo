import { describe, expect, it } from "vitest";
import { tenantVoiceFor } from "./call-session";

describe("tenantVoiceFor", () => {
  it("usa a voz da empresa no motor que a conhece ou aceita voz própria da conta", () => {
    expect(tenantVoiceFor({ voices: [{ id: "Puck" }] }, "Puck")).toBe("Puck");
    expect(tenantVoiceFor({ voices: [{ id: "a" }], acceptsCustomVoices: true }, "voz-clonada")).toBe("voz-clonada");
  });

  it("não manda a voz de outro provedor: vale a voz padrão do motor", () => {
    expect(tenantVoiceFor({ voices: [{ id: "Puck" }] }, "voz-clonada")).toBeUndefined();
    expect(tenantVoiceFor({}, "Puck")).toBeUndefined();
    expect(tenantVoiceFor({ acceptsCustomVoices: true }, null)).toBeUndefined();
  });
});
