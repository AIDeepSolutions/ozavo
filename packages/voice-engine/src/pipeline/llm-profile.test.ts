import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_PROFILE, LLM_PROFILES, LLM_PROFILE_IDS, acceptsCacheControl, isLlmProfileId, llmProfileOf } from "./llm-profile";

describe("perfil do modelo de texto", () => {
  it("o padrão é o perfil A (Haiku 5.5 + cache + teto 1024, raciocínio ligado, sem lista agrupada)", () => {
    expect(DEFAULT_LLM_PROFILE).toBe("a");
    expect(llmProfileOf(undefined)).toEqual({ id: "a", model: "anthropic/claude-haiku-5.5", maxTokens: 1024, cacheSystemPrompt: true, reasoning: "default", groupSlotsByDay: false });
  });

  it("valor ausente, nulo ou desconhecido vira o padrão; nunca derruba a ligação", () => {
    for (const ruim of [undefined, null, "", "z", "A", 1, {}]) expect(llmProfileOf(ruim).id).toBe("a");
    for (const id of LLM_PROFILE_IDS) expect(llmProfileOf(id)).toBe(LLM_PROFILES[id]);
  });

  it("B liga raciocínio desligado e lista agrupada JUNTOS; só B agrupa por dia", () => {
    expect(LLM_PROFILES.b).toMatchObject({ reasoning: "off", groupSlotsByDay: true, cacheSystemPrompt: true });
    for (const profile of Object.values(LLM_PROFILES)) expect(profile.groupSlotsByDay).toBe(profile.reasoning === "off");
  });

  it("C é o Flash de antes: sem cache, sem mudança de raciocínio, teto 400", () => {
    expect(LLM_PROFILES.c).toMatchObject({ model: "google/gemini-2.5-flash", maxTokens: 400, cacheSystemPrompt: false, reasoning: "default" });
  });

  it("com o raciocínio ligado o teto é 1024 (o de 400 cortava a resposta)", () => {
    for (const profile of Object.values(LLM_PROFILES)) if (profile.reasoning === "default" && profile.model.startsWith("anthropic/")) expect(profile.maxTokens).toBeGreaterThanOrEqual(1024);
  });

  it("isLlmProfileId e acceptsCacheControl", () => {
    expect(isLlmProfileId("b")).toBe(true);
    expect(isLlmProfileId("d")).toBe(false);
    expect(acceptsCacheControl("anthropic/claude-haiku-5.5")).toBe(true);
    expect(acceptsCacheControl("google/gemini-2.5-flash")).toBe(false);
  });
});
