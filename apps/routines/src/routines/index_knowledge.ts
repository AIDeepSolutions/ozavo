import {
  EmbeddingError,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_TASK_KIND,
  MAX_TASK_ATTEMPTS,
  chunkText,
  claimKnowledgeVersion,
  completeKnowledgeVersion,
  decryptSecret,
  embedTexts,
  failKnowledgeVersion,
  indexedTokensExcluding,
  withOrg,
  type KnowledgeErrorCode,
  type OrgQuery,
} from "@ozavo/core";
import { parsePipelineKey } from "@ozavo/voice-engine/pipeline-credentials";
import { z } from "zod";
import { KnowledgeExtractError, extractKnowledgeText } from "../knowledge/extract";
import type { Routine } from "../types";

const payloadSchema = z.object({ versionId: z.uuid() });

/** A chave do OpenRouter do motor em pipeline da empresa: a mesma que o agente usa na ligação. */
const PIPELINE_KEY_SETTING = "engine.deepgram-openrouter-cartesia.api_key";

async function openRouterKeyOf(q: OrgQuery, secretKey: Buffer): Promise<string | null> {
  const row = await q.one<{ value: unknown }>("select value from settings where key = $1", [PIPELINE_KEY_SETTING]);
  if (typeof row?.value !== "string") return null;
  try {
    return parsePipelineKey(decryptSecret(row.value, secretKey)).openrouter;
  } catch {
    return null;
  }
}

/**
 * Indexa UMA versão de uma fonte da base de conhecimento: extrai o texto (PDF, DOCX, texto), parte em
 * trechos, pede os embeddings ao OpenRouter com a chave da empresa e grava os trechos. Roda fora do
 * painel, então um PDF grande ou um provedor lento não trava a tela.
 *
 * Falha que não adianta repetir (arquivo ilegível, teto estourado, sem chave, chave recusada) marca a
 * versão como falha e a tarefa termina; falha de rede ou limite de uso do provedor devolve a tarefa à
 * fila, e só na última tentativa a versão vira falha. Repetir é seguro: a versão já `ready` não é
 * reivindicada de novo e os trechos de uma tentativa interrompida são regravados.
 */
const routine: Routine = {
  kind: KNOWLEDGE_TASK_KIND,
  async run(task, deps) {
    const { versionId } = payloadSchema.parse(task.payload);
    const { db, clock } = deps;
    const inOrg = <T>(fn: (q: OrgQuery) => Promise<T>): Promise<T> => withOrg(db, task.organizationId, fn);
    const claimed = await inOrg((q) => claimKnowledgeVersion(q, versionId, clock.now()));
    // A fonte foi apagada ou a versão já terminou: nada a fazer.
    if (!claimed) return;
    const fail = (code: KnowledgeErrorCode, text?: string): Promise<void> => inOrg((q) => failKnowledgeVersion(q, versionId, code, clock.now(), text));
    let extracted: string | undefined;
    try {
      extracted = claimed.contentText ?? undefined;
      if (extracted === undefined) {
        if (!claimed.raw) return await fail("no_text");
        extracted = await extractKnowledgeText(claimed.kind, claimed.raw);
      }
      const chunks = chunkText(extracted);
      if (chunks.length === 0) return await fail("empty_text");
      const tokenCount = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
      if (tokenCount > KNOWLEDGE_LIMITS.maxSourceTokens) return await fail("source_too_large", extracted);
      const others = await inOrg((q) => indexedTokensExcluding(q, claimed.sourceId));
      if (others + tokenCount > KNOWLEDGE_LIMITS.maxOrganizationTokens) return await fail("organization_quota", extracted);
      const apiKey = await inOrg((q) => openRouterKeyOf(q, deps.secretKey));
      if (apiKey === null) return await fail("no_embedding_key", extracted);

      // O título da seção vai junto no texto do embedding: "Preços" ajuda a achar o trecho da tabela de preços.
      const inputs = chunks.map((chunk) => (chunk.section && !chunk.content.startsWith(chunk.section) ? `${chunk.section}\n${chunk.content}` : chunk.content));
      const embedded = await embedTexts(inputs, { apiKey, fetch: deps.fetch, attempts: 2 }, chunks.map((chunk) => chunk.tokenCount));
      await inOrg((q) =>
        completeKnowledgeVersion(q, {
          versionId,
          sourceId: claimed.sourceId,
          text: extracted ?? "",
          chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: embedded.vectors[i] ?? [] })),
          tokenCount,
          embeddingTokens: embedded.tokens,
          costMicrocents: embedded.costMicrocents,
          now: clock.now(),
        }),
      );
    } catch (error) {
      if (error instanceof KnowledgeExtractError) return await fail(error.code);
      const lastAttempt = task.attempts >= MAX_TASK_ATTEMPTS;
      if (error instanceof EmbeddingError) {
        if (!error.retryable) return await fail("embedding_rejected", extracted);
        if (lastAttempt) await fail("embedding_failed", extracted);
        throw error;
      }
      if (lastAttempt) await fail("internal", extracted);
      throw error;
    }
  },
};

export default routine;
