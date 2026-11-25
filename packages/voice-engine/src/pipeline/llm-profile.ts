/**
 * Perfil do modelo de texto do motor em pipeline, escolhido por agente na tela de configuração (convenção 7: configuração de
 * operador tem tela; não é variável de ambiente). Vem do benchmark R2 (ramo `feat/benchmark-llm-2`, pasta `docs/benchmark-llm-r2/`, fora da `main`), medido em bancada simulada:
 *
 *   - `a` (PADRÃO, conservador): Claude Haiku 5.5 com cache do prompt de sistema, teto de saída 1024 e raciocínio padrão do
 *     modelo. Concluiu 90/90 dos atendimentos simulados, sem erro crítico. A resposta fica em ~2 s: serve a quem pode esperar.
 *   - `b` (telefonia): Haiku 5.5 com cache, raciocínio DESLIGADO e a lista de horários livres agrupada por dia
 *     (`groupSlotsByDay`). 87/90 concluídos, sem erro crítico, ~1,4 s. O agrupamento só vale junto do raciocínio desligado:
 *     não foi testado com ele ligado, por isso os dois andam juntos neste perfil e não existem em separado.
 *   - `c` (o de antes): Gemini 2.5 Flash, sem cache, sem mudança de raciocínio, teto 400. Concluiu ~77% na bancada; fica para
 *     quem prioriza o custo do modelo ou precisa voltar ao comportamento anterior.
 *   - `d` (rápido, experimental): gpt-oss-120b com raciocínio baixo, roteado por Cerebras, Groq e BaseTen (nesta ordem, com
 *     reserva), sem cache, teto 400. Bancada de 25/11/2026 (docs/reports/2026-11-25-llm-rapido.md): primeiro token ~0,36 s
 *     na VPS contra ~0,6 s do B; acertou 27/30 chamadas de ferramenta (o B, 30/30) e a nota de pt-BR do juiz foi menor.
 *     Para teste ao vivo lado a lado com o B; não é o padrão.
 *   - `e` (rápido, experimental): DeepSeek V4.1 Flash, raciocínio desligado, roteado pela Together (reserva: os demais provedores do
 *     OpenRouter), sem marca de cache (o provedor faz o cache sozinho), teto 400. Mesma bancada: primeiro token ~0,28 s, 29/30
 *     chamadas de ferramenta certas, regras de fala 30/30, nota de pt-BR do juiz 4,1 (Haiku 4,3). É o melhor equilíbrio da
 *     bancada entre latência e qualidade, mas fora do Claude.
 *
 * Nada disto foi validado em ligação real (aguarda o número). Reverter um agente é escolher outro perfil na tela; reverter tudo é
 * voltar `DEFAULT_LLM_PROFILE` para `c` (docs/decisions/0021-modelo-haiku-e-perfis-do-agente.md).
 */
export const LLM_PROFILE_IDS = ["a", "b", "c", "d", "e"] as const;
export type LlmProfileId = (typeof LLM_PROFILE_IDS)[number];

export interface LlmProfile {
  id: LlmProfileId;
  model: string;
  /** Teto de tokens de saída. O raciocínio divide o teto com o texto: com ele ligado, 400 cortou 9 de 552 chamadas. */
  maxTokens: number;
  /** Marca o prompt de sistema com `cache_control`. Só vai ao modelo que o aceita (`acceptsCacheControl`). */
  cacheSystemPrompt: boolean;
  /** `off` manda `reasoning: { enabled: false }`; `low` manda `reasoning: { effort: "low" }` (modelos que não aceitam desligar); `default` não manda nada e o modelo decide. */
  reasoning: "default" | "off" | "low";
  /** Roteamento do OpenRouter (`provider`): ordem de preferência. Os provedores seguintes entram como reserva se o primeiro falhar. */
  providerOrder?: readonly string[];
  /** As ferramentas de agenda trazem os horários livres agrupados por dia (só com o raciocínio desligado). */
  groupSlotsByDay: boolean;
}

export const LLM_PROFILES: Readonly<Record<LlmProfileId, LlmProfile>> = {
  a: { id: "a", model: "anthropic/claude-haiku-5.5", maxTokens: 1024, cacheSystemPrompt: true, reasoning: "default", groupSlotsByDay: false },
  b: { id: "b", model: "anthropic/claude-haiku-5.5", maxTokens: 400, cacheSystemPrompt: true, reasoning: "off", groupSlotsByDay: true },
  c: { id: "c", model: "google/gemini-2.5-flash", maxTokens: 400, cacheSystemPrompt: false, reasoning: "default", groupSlotsByDay: false },
  d: { id: "d", model: "openai/gpt-oss-120b", maxTokens: 400, cacheSystemPrompt: false, reasoning: "low", groupSlotsByDay: false, providerOrder: ["cerebras", "groq", "baseten"] },
  e: { id: "e", model: "deepseek/deepseek-v4.1-flash", maxTokens: 400, cacheSystemPrompt: false, reasoning: "off", groupSlotsByDay: false, providerOrder: ["together"] },
};

/** O perfil de quem não escolheu: o A (qualidade primeiro). */
export const DEFAULT_LLM_PROFILE: LlmProfileId = "a";

export function isLlmProfileId(value: unknown): value is LlmProfileId {
  return typeof value === "string" && (LLM_PROFILE_IDS as readonly string[]).includes(value);
}

/** O perfil pelo id; ausente ou desconhecido vira o padrão (nunca derruba a ligação). */
export function llmProfileOf(id: unknown): LlmProfile {
  return LLM_PROFILES[isLlmProfileId(id) ? id : DEFAULT_LLM_PROFILE];
}

/**
 * Só o modelo que aceita `cache_control` em bloco de conteúdo recebe a marca (Claude pelo OpenRouter, confirmado na bancada R2).
 * Outros modelos fazem o cache sozinhos, ou podem recusar o formato: a marca não vai.
 */
export function acceptsCacheControl(model: string): boolean {
  return model.startsWith("anthropic/");
}
