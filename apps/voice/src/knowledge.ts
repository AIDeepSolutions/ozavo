import { getAgentKnowledge, loadKnowledgeDocuments, resolveKnowledgeMode, searchKnowledge, type KnowledgeMode, type OrgQuery } from "@ozavo/core";
import { knowledgeSystemSection, type KnowledgeConfig } from "@ozavo/voice-engine";
import { messageOf, type Logger } from "./log";

/**
 * A base de conhecimento do agente no começo da ligação. Se o agente não tem base pronta, devolve `none` e nada muda
 * (nenhuma consulta além da que descobriu isso, nenhuma palavra a mais no prompt, nenhuma busca por turno).
 *
 * Modo `full`: os documentos entram numa seção fixa do prompt de sistema, na ordem do nome e do id, sem nada que mude
 * de uma ligação para outra (o prefixo do prompt é o mesmo e o cache do provedor acerta).
 * Modo `rag`: só a instrução entra no prompt; os trechos chegam a cada fala, pela busca de `KnowledgeConfig.search`.
 *
 * Falha ao carregar nunca derruba a ligação: ela segue sem a base e o motivo vai para a linha do tempo.
 */

/** A base inteira cabe no prompt de um motor sem busca (voz direta) até este tamanho; acima, sem a base. */
export const DIRECT_ENGINE_FULL_MAX_TOKENS = 30_000;

export type KnowledgeLoadFallback = "load_failed" | "engine_unsupported" | "empty";

/** O que o evento `knowledge_loaded` leva: contagens e modo, nunca texto da base. */
export interface KnowledgeLoadedPayload {
  /** O modo que valeu na ligação (ausente quando a base não pôde ser usada). */
  mode?: "full" | "rag";
  /** O que o agente configurou (`auto`, `rag` ou `full`). */
  configuredMode: KnowledgeMode;
  sources: number;
  tokens: number;
  loadMs: number;
  fallback?: KnowledgeLoadFallback;
}

export type CallKnowledge =
  | { kind: "none" }
  | { kind: "ready"; section: string; config: KnowledgeConfig; payload: KnowledgeLoadedPayload }
  | { kind: "unavailable"; payload: KnowledgeLoadedPayload };

export interface PrepareKnowledgeInput {
  /** Cada chamada devolve uma consulta nova (a busca por turno não pode esperar na fila da linha do tempo). */
  orgQuery(): OrgQuery;
  agentId: string;
  language: string;
  /** O motor busca trechos por turno. */
  supportsRetrieval: boolean;
  now(): number;
  log: Logger;
}

export async function prepareCallKnowledge(input: PrepareKnowledgeInput): Promise<CallKnowledge> {
  const startedAt = input.now();
  const elapsed = (): number => Math.max(0, input.now() - startedAt);
  let configured: KnowledgeMode = "auto";
  let sources = 0;
  let tokens = 0;
  try {
    const q = input.orgQuery();
    const base = await getAgentKnowledge(q, input.agentId);
    if (!base || base.sources.length === 0) return { kind: "none" };
    configured = base.mode;
    sources = base.sources.length;
    tokens = base.sources.reduce((sum, source) => sum + source.tokenCount, 0);
    const sourceIds = base.sources.map((source) => source.id);
    let mode = resolveKnowledgeMode(base.mode, tokens);
    if (mode === "rag" && !input.supportsRetrieval) {
      // Motor de voz direta não busca por turno: a base inteira, se couber; senão, sem a base (e o motivo fica registrado).
      if (tokens > DIRECT_ENGINE_FULL_MAX_TOKENS) return { kind: "unavailable", payload: { configuredMode: configured, sources, tokens, loadMs: elapsed(), fallback: "engine_unsupported" } };
      mode = "full";
    }
    if (mode === "full") {
      const documents = await loadKnowledgeDocuments(q, sourceIds);
      if (documents.length === 0) return { kind: "unavailable", payload: { configuredMode: configured, sources, tokens, loadMs: elapsed(), fallback: "empty" } };
      return {
        kind: "ready",
        section: knowledgeSystemSection({ mode: "full", only: base.only, language: input.language, documents: documents.map((doc) => ({ id: doc.id, name: doc.name, text: doc.text })) }),
        config: { mode: "full", only: base.only },
        payload: { mode: "full", configuredMode: configured, sources, tokens, loadMs: elapsed() },
      };
    }
    return {
      kind: "ready",
      section: knowledgeSystemSection({ mode: "rag", only: base.only, language: input.language }),
      config: { mode: "rag", only: base.only, search: ({ question, embedding, k }) => searchKnowledge(input.orgQuery(), { sourceIds, question, embedding, k }) },
      payload: { mode: "rag", configuredMode: configured, sources, tokens, loadMs: elapsed() },
    };
  } catch (error) {
    input.log("error", "could not load the agent's knowledge base; the call goes on without it", { error: messageOf(error) });
    return { kind: "unavailable", payload: { configuredMode: configured, sources, tokens, loadMs: elapsed(), fallback: "load_failed" } };
  }
}
