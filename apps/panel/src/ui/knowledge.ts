import type { Locale } from "../i18n/locales";

/** Tipos do que a API da base de conhecimento devolve (`/api/v1/knowledge`, `/usage`, `/search`). */
export type KnowledgeStatus = "queued" | "processing" | "ready" | "failed";
export type KnowledgeKind = "pdf" | "docx" | "md" | "txt" | "text";
export type KnowledgeMode = "auto" | "rag" | "full";

export interface KnowledgeSourceView {
  id: string;
  name: string;
  kind: KnowledgeKind;
  originalFilename: string | null;
  status: KnowledgeStatus;
  errorCode: string | null;
  currentVersionId: string | null;
  sizeBytes: number;
  tokenCount: number;
  chunkCount: number;
  indexCostMicrocents: number;
  createdAt: string;
  updatedAt: string;
  indexedAt: string | null;
  agentCount: number;
  latestVersion: number;
}

export interface KnowledgeUsageView {
  tokens: number;
  sources: number;
  indexCostMicrocents: number;
  month: { indexTokens: number; indexCostMicrocents: number; searchTokens: number; searchCostMicrocents: number };
  limits: { maxFileBytes: number; maxSourceTokens: number; maxOrganizationTokens: number; maxSources: number; fullPromptMaxTokens: number };
  embeddingUsdPerMillionTokens: number;
}

export interface KnowledgeHitView {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  section: string | null;
  content: string;
  vectorScore: number | null;
  lexicalRank: number | null;
}

export interface KnowledgeAgentView {
  mode: KnowledgeMode;
  only: boolean;
  sources: Array<{ id: string; name: string; tokenCount: number }>;
  linkedIds: string[];
  fullPromptMaxTokens: number;
}

/** 1 US$ = 100.000.000 microcentavos de dólar, a unidade do custo gravado. */
export const MICROCENTS_PER_USD = 100_000_000;

/**
 * O custo em dólar. Valor pequeno mostra mais casas: indexar um documento custa frações de centavo, e
 * "US$ 0,00" esconderia o gasto.
 */
export function formatUsd(microcents: number, locale: Locale): string {
  const usd = microcents / MICROCENTS_PER_USD;
  const digits = usd === 0 ? 2 : usd < 0.0001 ? 6 : usd < 0.01 ? 5 : usd < 1 ? 4 : 2;
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: digits }).format(usd);
}

export const formatCount = (value: number, locale: Locale): string => new Intl.NumberFormat(locale).format(value);

/** "1 milhão", "5 millones": o teto sem a fileira de zeros. */
export const formatCompactCount = (value: number, locale: Locale): string => new Intl.NumberFormat(locale, { notation: "compact", compactDisplay: "long" }).format(value);

/** A tela atualiza sozinha só enquanto alguma fonte espera ou está sendo indexada. */
export const hasPendingSource = (sources: readonly Pick<KnowledgeSourceView, "status">[]): boolean => sources.some((source) => source.status === "queued" || source.status === "processing");

/** O intervalo de atualização do estado das fontes pendentes (milissegundos). */
export const KNOWLEDGE_POLL_MS = 4000;

/** O modo que `auto` escolhe, como em `resolveKnowledgeMode` (núcleo): a base cabe inteira no prompt até o teto. */
export const resolveMode = (mode: KnowledgeMode, totalTokens: number, fullPromptMaxTokens: number): "rag" | "full" => (mode === "auto" ? (totalTokens <= fullPromptMaxTokens ? "full" : "rag") : mode);

/** Soma dos tokens das bases escolhidas que já têm versão pronta (as outras ainda não respondem). */
export function chosenTokens(sources: readonly Pick<KnowledgeSourceView, "id" | "tokenCount" | "currentVersionId">[], chosen: ReadonlySet<string>): number {
  return sources.filter((source) => chosen.has(source.id) && source.currentVersionId !== null).reduce((sum, source) => sum + source.tokenCount, 0);
}

/** Similaridade de cosseno (0 a 1) como porcentagem inteira. */
export const similarityPercent = (score: number): number => Math.max(0, Math.min(100, Math.round(score * 100)));
