import { EMBEDDING_PRICE_USD_PER_MILLION_TOKENS, FULL_PROMPT_MAX_TOKENS, KNOWLEDGE_LIMITS, getKnowledgeCost, getKnowledgeUsage } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/**
 * Quanto a empresa tem indexado contra os tetos, e o que a base custou no mês corrente (UTC): indexação
 * e buscas de teste. A busca durante a ligação está no extrato da própria ligação.
 */
export const GET = handle({}, async ({ q, deps }) => {
  const now = deps.clock.now();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [usage, month] = await Promise.all([getKnowledgeUsage(q), getKnowledgeCost(q, from, to)]);
  return {
    tokens: usage.tokens,
    sources: usage.sources,
    indexCostMicrocents: usage.indexCostMicrocents,
    month: { from: from.toISOString(), to: to.toISOString(), ...month },
    limits: { ...KNOWLEDGE_LIMITS, fullPromptMaxTokens: FULL_PROMPT_MAX_TOKENS },
    /** O preço de tabela do embedding, para a tela estimar o custo de indexar sem repetir o número. */
    embeddingUsdPerMillionTokens: EMBEDDING_PRICE_USD_PER_MILLION_TOKENS,
  };
});
