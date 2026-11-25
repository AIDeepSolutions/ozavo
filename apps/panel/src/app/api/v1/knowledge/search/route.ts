import { EmbeddingError, embedTexts, recordKnowledgeSearchUsage, searchKnowledge } from "@ozavo/core";
import { z } from "zod";
import { ApiError, handle } from "../../../../../server/context";
import { openRouterKeyOf } from "../../../../../server/knowledge";

const body = z.object({
  question: z.string().trim().min(1).max(500),
  /** Vazio: todas as fontes prontas. */
  sourceIds: z.array(z.uuid()).max(200).optional(),
  k: z.number().int().min(1).max(10).default(5),
});

interface Plan {
  apiKey: string;
  sourceIds: string[];
}

/**
 * Busca de teste: faz com a pergunta o que o agente faz na ligação (embedding pela chave OpenRouter do motor
 * em pipeline, busca por similaridade e por palavras) e devolve os trechos com fonte, seção e pontuação.
 * Gasta embedding de uma pergunta, que vai para o registro de uso da empresa. Só dono e administrador,
 * porque usa a chave da empresa. A chamada ao provedor roda fora da transação.
 */
export const POST = handle<typeof body, Plan>(
  {
    body,
    configure: true,
    after: async (plan, { body: input, org, deps }) => {
      const started = performance.now();
      if (plan.sourceIds.length === 0) return { hits: [], ms: 0, tokens: 0, costMicrocents: 0 };
      let embedded: Awaited<ReturnType<typeof embedTexts>>;
      try {
        embedded = await embedTexts([input.question], { apiKey: plan.apiKey, fetch: deps.fetch, attempts: 2 });
      } catch (error) {
        if (error instanceof EmbeddingError) {
          throw error.retryable
            ? new ApiError(502, "knowledge_embedding_failed", "The embedding provider did not answer.")
            : new ApiError(502, "knowledge_embedding_rejected", "The embedding provider refused the request.");
        }
        throw error;
      }
      const hits = await org(async (q) => {
        await recordKnowledgeSearchUsage(q, { tokens: embedded.tokens, costMicrocents: embedded.costMicrocents, now: deps.clock.now() });
        return searchKnowledge(q, { sourceIds: plan.sourceIds, question: input.question, embedding: embedded.vectors[0] ?? null, k: input.k });
      });
      return {
        hits: hits.map((hit) => ({
          chunkId: hit.chunkId,
          sourceId: hit.sourceId,
          sourceName: hit.sourceName,
          position: hit.position,
          section: hit.section,
          content: hit.content,
          tokenCount: hit.tokenCount,
          vectorScore: hit.vectorScore,
          lexicalRank: hit.lexicalRank,
          score: hit.score,
        })),
        ms: Math.round(performance.now() - started),
        tokens: embedded.tokens,
        costMicrocents: embedded.costMicrocents,
      };
    },
  },
  async ({ q, body: input, deps }) => {
    const apiKey = await openRouterKeyOf(q, deps.secretKey);
    if (apiKey === null) throw new ApiError(409, "knowledge_no_embedding_key", "The pipeline engine has no OpenRouter key saved.");
    const ready = await q.many<{ id: string }>("select id from knowledge_sources where current_version_id is not null");
    const known = new Set(ready.map((row) => row.id));
    const sourceIds = input.sourceIds === undefined ? [...known] : input.sourceIds.filter((id) => known.has(id));
    return { apiKey, sourceIds };
  },
);
