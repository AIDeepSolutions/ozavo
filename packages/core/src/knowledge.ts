import { EMBEDDING_MODEL, toVectorLiteral } from "./embeddings";
import { buildTsQuery, normalizeSearchText, type TextChunk } from "./knowledge-chunking";
import { enqueueTask } from "./queue";
import type { OrgQuery } from "./types";

/**
 * Base de conhecimento do agente: fontes (documentos), versões (cada indexação), trechos com embedding
 * e o vínculo com os agentes. O desenho e os números estão em `docs/decisions/0022-base-de-conhecimento.md`.
 */

export const KNOWLEDGE_KINDS = ["pdf", "docx", "md", "txt", "text"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const KNOWLEDGE_STATUSES = ["queued", "processing", "ready", "failed"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/** Por que uma indexação falhou. Vocabulário fechado: a tela tem uma frase para cada (`knowledge` nos dicionários). */
export const KNOWLEDGE_ERROR_CODES = [
  "empty_text",
  "unreadable_file",
  "scanned_pdf",
  "source_too_large",
  "organization_quota",
  "no_embedding_key",
  "embedding_failed",
  "embedding_rejected",
  "no_text",
  "internal",
] as const;
export type KnowledgeErrorCode = (typeof KNOWLEDGE_ERROR_CODES)[number];

/** O `tasks.kind` da rotina que indexa uma versão. */
export const KNOWLEDGE_TASK_KIND = "index_knowledge";

/**
 * Os tetos. Estão aqui, e na tela, para quem usa saber até onde vai; o custo estimado de indexar o teto
 * da empresa inteira (5 milhões de tokens a US$ 0,02 por milhão) é US$ 0,10.
 */
export const KNOWLEDGE_LIMITS = {
  /** Arquivo enviado. Um PDF de 40 páginas costuma ter de 0,3 a 5 MB. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Texto extraído ou colado, em caracteres (~1 milhão de tokens). */
  maxTextCharacters: 4_000_000,
  /** Uma fonte. */
  maxSourceTokens: 1_000_000,
  /** Tudo o que a empresa tem indexado (versões correntes). */
  maxOrganizationTokens: 5_000_000,
  maxSources: 200,
} as const;

/**
 * No modo `auto`, a base cabe inteira no prompt até este tamanho. Acima, o agente busca por pergunta.
 * Medido: o prompt com cache custa pouco por ligação, mas o primeiro pedido de cada janela de cache
 * (5 minutos) lê o prompt inteiro sem cache e demora (docs/guides/base-de-conhecimento.md).
 */
export const FULL_PROMPT_MAX_TOKENS = 6000;

export type KnowledgeMode = "auto" | "rag" | "full";
export const KNOWLEDGE_MODES: readonly KnowledgeMode[] = ["auto", "rag", "full"];

/** O modo efetivo: `auto` escolhe pelo tamanho total das bases do agente. */
export function resolveKnowledgeMode(mode: KnowledgeMode, totalTokens: number): "rag" | "full" {
  if (mode === "rag" || mode === "full") return mode;
  return totalTokens <= FULL_PROMPT_MAX_TOKENS ? "full" : "rag";
}

export class KnowledgeLimitError extends Error {
  constructor(
    readonly code: "empty" | "name" | "file_too_large" | "text_too_large" | "too_many_sources" | "organization_quota" | "not_found" | "no_text" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeLimitError";
  }
}

export interface KnowledgeSource {
  id: string;
  name: string;
  kind: KnowledgeKind;
  originalFilename: string | null;
  status: KnowledgeStatus;
  errorCode: KnowledgeErrorCode | null;
  currentVersionId: string | null;
  sizeBytes: number;
  tokenCount: number;
  chunkCount: number;
  embeddingModel: string;
  /** O que indexar esta fonte já custou, em microcentavos de dólar. */
  indexCostMicrocents: number;
  createdAt: Date;
  updatedAt: Date;
  indexedAt: Date | null;
  /** Quantos agentes usam esta base. */
  agentCount: number;
  /** O número da versão mais recente. */
  latestVersion: number;
}

interface SourceRow {
  id: string;
  name: string;
  kind: KnowledgeKind;
  original_filename: string | null;
  status: KnowledgeStatus;
  error_code: KnowledgeErrorCode | null;
  current_version_id: string | null;
  size_bytes: string;
  token_count: number;
  chunk_count: number;
  embedding_model: string;
  index_cost_microcents: string;
  created_at: Date;
  updated_at: Date;
  indexed_at: Date | null;
  agent_count: number;
  latest_version: number;
}

const SOURCE_COLUMNS = `s.id, s.name, s.kind, s.original_filename, s.status, s.error_code, s.current_version_id, s.size_bytes::text, s.token_count, s.chunk_count,
  s.embedding_model, s.index_cost_microcents::text, s.created_at, s.updated_at, s.indexed_at,
  (select count(*)::int from agent_knowledge_sources a where a.source_id = s.id) as agent_count,
  coalesce((select max(v.version) from knowledge_versions v where v.source_id = s.id), 0) as latest_version`;

const toSource = (row: SourceRow): KnowledgeSource => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  originalFilename: row.original_filename,
  status: row.status,
  errorCode: row.error_code,
  currentVersionId: row.current_version_id,
  sizeBytes: Number(row.size_bytes),
  tokenCount: row.token_count,
  chunkCount: row.chunk_count,
  embeddingModel: row.embedding_model,
  indexCostMicrocents: Number(row.index_cost_microcents),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  indexedAt: row.indexed_at,
  agentCount: row.agent_count,
  latestVersion: row.latest_version,
});

export async function listKnowledgeSources(q: OrgQuery): Promise<KnowledgeSource[]> {
  const rows = await q.many<SourceRow>(`select ${SOURCE_COLUMNS} from knowledge_sources s order by s.created_at desc, s.id`);
  return rows.map(toSource);
}

export async function getKnowledgeSource(q: OrgQuery, sourceId: string): Promise<KnowledgeSource | null> {
  const row = await q.one<SourceRow>(`select ${SOURCE_COLUMNS} from knowledge_sources s where s.id = $1`, [sourceId]);
  return row && toSource(row);
}

/** Quanto a empresa tem indexado (versões correntes) e quantas fontes. */
export async function getKnowledgeUsage(q: OrgQuery): Promise<{ tokens: number; sources: number; indexCostMicrocents: number }> {
  const row = await q.one<{ tokens: string; sources: number; cost: string }>(
    `select coalesce(sum(s.token_count), 0)::text as tokens, count(*)::int as sources, coalesce(sum(s.index_cost_microcents), 0)::text as cost from knowledge_sources s`,
  );
  return { tokens: Number(row?.tokens ?? 0), sources: row?.sources ?? 0, indexCostMicrocents: Number(row?.cost ?? 0) };
}

/** Texto aproximado em tokens, sem tokenizar: serve para recusar cedo um envio claramente grande demais. */
const approxTokensOfChars = (characters: number): number => Math.ceil(characters / 4);

export interface NewKnowledgeInput {
  name: string;
  kind: KnowledgeKind;
  filename?: string | null;
  /** O arquivo, para pdf, docx, md e txt. */
  raw?: Buffer;
  /** O texto, para `text` (colado). */
  text?: string;
  createdBy: string | null;
  now: Date;
}

function checkContent(input: { kind: KnowledgeKind; raw?: Buffer; text?: string }): void {
  if (input.kind === "text") {
    if (input.text === undefined || input.text.trim() === "") throw new KnowledgeLimitError("empty", "The pasted text is empty");
    if (input.text.length > KNOWLEDGE_LIMITS.maxTextCharacters) throw new KnowledgeLimitError("text_too_large", "The text is over the limit");
    return;
  }
  if (!input.raw || input.raw.length === 0) throw new KnowledgeLimitError("empty", "The file is empty");
  if (input.raw.length > KNOWLEDGE_LIMITS.maxFileBytes) throw new KnowledgeLimitError("file_too_large", "The file is over the size limit");
}

async function nextVersion(q: OrgQuery, sourceId: string): Promise<number> {
  // Trava a fonte: dois envios ao mesmo tempo não pegam o mesmo número.
  const locked = await q.one("select id from knowledge_sources where id = $1 for update", [sourceId]);
  if (!locked) throw new KnowledgeLimitError("not_found", "Knowledge source not found");
  const row = await q.one<{ next: number }>("select coalesce(max(version), 0) + 1 as next from knowledge_versions where source_id = $1", [sourceId]);
  return row?.next ?? 1;
}

async function insertVersion(
  q: OrgQuery,
  input: { sourceId: string; version: number; raw: Buffer | null; text: string | null; sizeBytes: number; createdBy: string | null; now: Date },
): Promise<string> {
  const row = await q.one<{ id: string }>(
    `insert into knowledge_versions (organization_id, source_id, version, raw, content_text, size_bytes, embedding_model, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [q.organizationId, input.sourceId, input.version, input.raw, input.text, input.sizeBytes, EMBEDDING_MODEL, input.createdBy, input.now],
  );
  if (!row) throw new Error("Knowledge version was not created");
  await enqueueTask(q, { kind: KNOWLEDGE_TASK_KIND, payload: { versionId: row.id } });
  await q.exec("update knowledge_sources set status = 'queued', error_code = null, updated_at = $2 where id = $1", [input.sourceId, input.now]);
  return row.id;
}

/** Cria a fonte e enfileira a indexação. Recusa o que passa dos tetos. */
export async function createKnowledgeSource(q: OrgQuery, input: NewKnowledgeInput): Promise<{ sourceId: string; versionId: string }> {
  const name = input.name.trim();
  if (name === "" || name.length > 200) throw new KnowledgeLimitError("name", "The name must have 1 to 200 characters");
  checkContent(input);
  const usage = await getKnowledgeUsage(q);
  if (usage.sources >= KNOWLEDGE_LIMITS.maxSources) throw new KnowledgeLimitError("too_many_sources", "The organization is at the limit of knowledge sources");
  if (input.text !== undefined && usage.tokens + approxTokensOfChars(input.text.length) > KNOWLEDGE_LIMITS.maxOrganizationTokens) {
    throw new KnowledgeLimitError("organization_quota", "The organization is over the indexed text limit");
  }
  const source = await q.one<{ id: string }>(
    `insert into knowledge_sources (organization_id, name, kind, original_filename, size_bytes, embedding_model, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
    [q.organizationId, name, input.kind, input.filename ?? null, input.raw?.length ?? Buffer.byteLength(input.text ?? ""), EMBEDDING_MODEL, input.createdBy, input.now],
  );
  if (!source) throw new Error("Knowledge source was not created");
  const versionId = await insertVersion(q, {
    sourceId: source.id,
    version: 1,
    raw: input.raw ?? null,
    text: input.kind === "text" ? (input.text ?? null) : null,
    sizeBytes: input.raw?.length ?? Buffer.byteLength(input.text ?? ""),
    createdBy: input.createdBy,
    now: input.now,
  });
  return { sourceId: source.id, versionId };
}

/** Troca o conteúdo da fonte por um arquivo ou texto novo: versão nova; a anterior segue valendo até a nova ficar pronta. */
export async function replaceKnowledgeSource(
  q: OrgQuery,
  sourceId: string,
  input: { kind: KnowledgeKind; filename?: string | null; raw?: Buffer; text?: string; createdBy: string | null; now: Date },
): Promise<{ versionId: string }> {
  checkContent(input);
  const version = await nextVersion(q, sourceId);
  const size = input.raw?.length ?? Buffer.byteLength(input.text ?? "");
  await q.exec("update knowledge_sources set kind = $2, original_filename = $3 where id = $1", [sourceId, input.kind, input.filename ?? null]);
  const versionId = await insertVersion(q, { sourceId, version, raw: input.raw ?? null, text: input.kind === "text" ? (input.text ?? null) : null, sizeBytes: size, createdBy: input.createdBy, now: input.now });
  return { versionId };
}

/** Indexa de novo o texto que já foi extraído, sem novo envio (para um modelo de embedding novo ou depois de falha de rede). */
export async function reindexKnowledgeSource(q: OrgQuery, sourceId: string, createdBy: string | null, now: Date): Promise<{ versionId: string }> {
  const version = await nextVersion(q, sourceId);
  const previous = await q.one<{ content_text: string | null; size_bytes: string }>(
    "select content_text, size_bytes::text from knowledge_versions where source_id = $1 and content_text is not null order by version desc limit 1",
    [sourceId],
  );
  if (!previous?.content_text) throw new KnowledgeLimitError("no_text", "There is no extracted text to index again: send the file again");
  const versionId = await insertVersion(q, { sourceId, version, raw: null, text: previous.content_text, sizeBytes: Number(previous.size_bytes), createdBy, now });
  return { versionId };
}

export async function renameKnowledgeSource(q: OrgQuery, sourceId: string, name: string, now: Date): Promise<boolean> {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 200) throw new KnowledgeLimitError("name", "The name must have 1 to 200 characters");
  return (await q.exec("update knowledge_sources set name = $2, updated_at = $3 where id = $1", [sourceId, trimmed, now])) === 1;
}

/** Apaga a fonte, as versões, os trechos e o vínculo com os agentes. O custo já gravado fica (sem a fonte). */
export async function deleteKnowledgeSource(q: OrgQuery, sourceId: string): Promise<boolean> {
  return (await q.exec("delete from knowledge_sources where id = $1", [sourceId])) === 1;
}

// ---------------------------------------------------------------------------------------------
// Agente
// ---------------------------------------------------------------------------------------------

export interface AgentKnowledge {
  mode: KnowledgeMode;
  only: boolean;
  /** As bases do agente que têm versão pronta para responder. */
  sources: Array<{ id: string; name: string; tokenCount: number }>;
  /** Os ids de todas as bases vinculadas, prontas ou não (a tela). */
  linkedIds: string[];
}

export async function getAgentKnowledge(q: OrgQuery, agentId: string): Promise<AgentKnowledge | null> {
  const agent = await q.one<{ knowledge_mode: KnowledgeMode; knowledge_only: boolean }>("select knowledge_mode, knowledge_only from agents where id = $1", [agentId]);
  if (!agent) return null;
  const rows = await q.many<{ id: string; name: string; token_count: number; current_version_id: string | null }>(
    `select s.id, s.name, s.token_count, s.current_version_id
       from agent_knowledge_sources a join knowledge_sources s on s.id = a.source_id and s.organization_id = a.organization_id
      where a.agent_id = $1 order by s.name, s.id`,
    [agentId],
  );
  return {
    mode: agent.knowledge_mode,
    only: agent.knowledge_only,
    sources: rows.filter((row) => row.current_version_id !== null).map((row) => ({ id: row.id, name: row.name, tokenCount: row.token_count })),
    linkedIds: rows.map((row) => row.id),
  };
}

/** Define as bases, o modo e o "só pela base" do agente. Devolve `false` quando o agente não existe. */
export async function setAgentKnowledge(q: OrgQuery, agentId: string, input: { sourceIds: string[]; mode: KnowledgeMode; only: boolean }, now: Date): Promise<boolean> {
  const updated = await q.exec("update agents set knowledge_mode = $2, knowledge_only = $3, updated_at = $4 where id = $1", [agentId, input.mode, input.only, now]);
  if (updated !== 1) return false;
  const ids = [...new Set(input.sourceIds)];
  // Só liga fontes que existem na empresa (a RLS já esconde as de outra).
  const known = ids.length === 0 ? [] : await q.many<{ id: string }>("select id from knowledge_sources where id = any($1::uuid[])", [ids]);
  if (known.length !== ids.length) throw new KnowledgeLimitError("not_found", "A knowledge source does not exist");
  await q.exec("delete from agent_knowledge_sources where agent_id = $1 and not (source_id = any($2::uuid[]))", [agentId, ids]);
  for (const id of ids) {
    await q.exec(
      "insert into agent_knowledge_sources (organization_id, agent_id, source_id, created_at) values ($1, $2, $3, $4) on conflict (agent_id, source_id) do nothing",
      [q.organizationId, agentId, id, now],
    );
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------------------------

export interface KnowledgeHit {
  chunkId: string;
  sourceId: string;
  sourceName: string;
  position: number;
  section: string | null;
  content: string;
  tokenCount: number;
  /** Similaridade de cosseno com a pergunta (0 a 1) quando o trecho veio da busca por similaridade. */
  vectorScore: number | null;
  /** Posição (1 = melhor) na busca por palavras, quando veio dela. */
  lexicalRank: number | null;
  /** Pontuação da fusão (RRF), a que ordena o resultado. */
  score: number;
}

const RRF_K = 60;
/** Quantos candidatos cada busca traz antes da fusão. */
const CANDIDATES = 12;
/** Abaixo disto, um trecho que só a busca por similaridade achou não entra: é parecido com tudo e com nada. */
export const MIN_VECTOR_SCORE = 0.22;

export interface KnowledgeHitRow {
  id: string;
  source_id: string;
  source_name: string;
  position: number;
  section: string | null;
  content: string;
  token_count: number;
  vector_rank: string | null;
  lexical_rank: string | null;
  vector_score: number | null;
}

/** A fusão por posição (RRF) das duas buscas. Pura, para o teste conferir sem banco. */
export function fuseHits(rows: KnowledgeHitRow[], k: number, minVectorScore = MIN_VECTOR_SCORE): KnowledgeHit[] {
  return rows
    .map((row) => {
      const vectorRank = row.vector_rank === null ? null : Number(row.vector_rank);
      const lexicalRank = row.lexical_rank === null ? null : Number(row.lexical_rank);
      return {
        chunkId: row.id,
        sourceId: row.source_id,
        sourceName: row.source_name,
        position: row.position,
        section: row.section,
        content: row.content,
        tokenCount: row.token_count,
        vectorScore: vectorRank === null ? null : row.vector_score,
        lexicalRank,
        score: (vectorRank === null ? 0 : 1 / (RRF_K + vectorRank)) + (lexicalRank === null ? 0 : 1 / (RRF_K + lexicalRank)),
      };
    })
    .filter((hit) => hit.lexicalRank !== null || (hit.vectorScore ?? 0) >= minVectorScore)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, k);
}

/**
 * Os `k` trechos que melhor respondem à pergunta, nas fontes pedidas (só a versão corrente de cada
 * uma). Junta a busca por similaridade (com o embedding da pergunta, quando há) e a busca por palavras.
 * Sem embedding, só a busca por palavras: é o caminho quando o embedding atrasou ou falhou.
 */
export async function searchKnowledge(q: OrgQuery, input: { sourceIds: string[]; question: string; embedding?: readonly number[] | null; k: number; minVectorScore?: number }): Promise<KnowledgeHit[]> {
  if (input.sourceIds.length === 0 || input.k <= 0) return [];
  const tsQuery = buildTsQuery(input.question);
  const hasVector = input.embedding != null;
  if (!hasVector && tsQuery === null) return [];
  const params: unknown[] = [input.sourceIds, CANDIDATES];
  const vectorParam = hasVector ? params.push(toVectorLiteral(input.embedding as readonly number[])) : 0;
  const textParam = tsQuery !== null ? params.push(tsQuery) : 0;
  const base = `from knowledge_chunks c join knowledge_sources s on s.id = c.source_id and s.current_version_id = c.version_id where c.source_id = any($1::uuid[])`;
  const ctes: string[] = [];
  if (hasVector) {
    ctes.push(`v as (select c.id, row_number() over (order by c.embedding <=> $${vectorParam}::vector) as rank ${base} order by c.embedding <=> $${vectorParam}::vector limit $2)`);
  }
  if (tsQuery !== null) {
    ctes.push(
      `l as (select c.id, row_number() over (order by ts_rank_cd(c.tsv, to_tsquery('portuguese', $${textParam})) desc, c.position) as rank ${base} and c.tsv @@ to_tsquery('portuguese', $${textParam}) order by ts_rank_cd(c.tsv, to_tsquery('portuguese', $${textParam})) desc, c.position limit $2)`,
    );
  }
  const joins = [hasVector ? "left join v on v.id = c.id" : "", tsQuery !== null ? "left join l on l.id = c.id" : ""].join(" ");
  const where = [hasVector ? "v.id is not null" : "", tsQuery !== null ? "l.id is not null" : ""].filter((part) => part !== "").join(" or ");
  const rows = await q.many<KnowledgeHitRow>(
    `with ${ctes.join(", ")}
     select c.id, c.source_id, s.name as source_name, c.position, c.section, c.content, c.token_count,
            ${hasVector ? "v.rank::text" : "null::text"} as vector_rank, ${tsQuery !== null ? "l.rank::text" : "null::text"} as lexical_rank,
            ${hasVector ? `(1 - (c.embedding <=> $${vectorParam}::vector))::float8` : "null::float8"} as vector_score
       from knowledge_chunks c join knowledge_sources s on s.id = c.source_id ${joins}
      where ${where}`,
    params,
  );
  return fuseHits(rows, input.k, input.minVectorScore);
}

/** O texto inteiro da versão corrente de cada fonte, para o modo "base inteira no prompt". */
export async function loadKnowledgeDocuments(q: OrgQuery, sourceIds: string[]): Promise<Array<{ id: string; name: string; tokenCount: number; text: string }>> {
  if (sourceIds.length === 0) return [];
  const rows = await q.many<{ id: string; name: string; token_count: number; content_text: string | null }>(
    `select s.id, s.name, s.token_count, v.content_text
       from knowledge_sources s join knowledge_versions v on v.id = s.current_version_id and v.organization_id = s.organization_id
      where s.id = any($1::uuid[]) order by s.name, s.id`,
    [sourceIds],
  );
  return rows.flatMap((row) => (row.content_text ? [{ id: row.id, name: row.name, tokenCount: row.token_count, text: row.content_text }] : []));
}

// ---------------------------------------------------------------------------------------------
// Indexação (a rotina `index_knowledge`)
// ---------------------------------------------------------------------------------------------

export interface ClaimedKnowledgeVersion {
  versionId: string;
  sourceId: string;
  version: number;
  kind: KnowledgeKind;
  raw: Buffer | null;
  contentText: string | null;
  sizeBytes: number;
  embeddingModel: string;
}

/** Pega a versão para indexar. `null` quando ela não existe mais (a fonte foi apagada) ou já terminou. */
export async function claimKnowledgeVersion(q: OrgQuery, versionId: string, now: Date): Promise<ClaimedKnowledgeVersion | null> {
  const row = await q.one<{ id: string; source_id: string; version: number; kind: KnowledgeKind; raw: Buffer | null; content_text: string | null; size_bytes: string; embedding_model: string }>(
    `update knowledge_versions v set status = 'processing', started_at = coalesce(v.started_at, $2)
       from knowledge_sources s
      where v.id = $1 and v.status in ('queued', 'processing') and s.id = v.source_id and s.organization_id = v.organization_id
      returning v.id, v.source_id, v.version, s.kind, v.raw, v.content_text, v.size_bytes::text, v.embedding_model`,
    [versionId, now],
  );
  if (!row) return null;
  await q.exec("update knowledge_sources set status = 'processing', updated_at = $2 where id = $1", [row.source_id, now]);
  return {
    versionId: row.id,
    sourceId: row.source_id,
    version: row.version,
    kind: row.kind,
    raw: row.raw,
    contentText: row.content_text,
    sizeBytes: Number(row.size_bytes),
    embeddingModel: row.embedding_model,
  };
}

/** Quantos tokens a empresa tem indexados fora desta fonte (a fonte em indexação é substituída, não somada). */
export async function indexedTokensExcluding(q: OrgQuery, sourceId: string): Promise<number> {
  const row = await q.one<{ tokens: string }>("select coalesce(sum(token_count), 0)::text as tokens from knowledge_sources where id <> $1", [sourceId]);
  return Number(row?.tokens ?? 0);
}

export interface EmbeddedChunk extends TextChunk {
  embedding: number[];
}

const INSERT_BATCH = 40;

/**
 * Grava os trechos e publica a versão: a fonte passa a apontar para ela e as versões antigas perdem
 * trechos, arquivo e texto (ficam só os números e o custo). Tudo numa transação: quem busca vê a versão
 * antiga inteira ou a nova inteira.
 */
export async function completeKnowledgeVersion(
  q: OrgQuery,
  input: { versionId: string; sourceId: string; text: string; chunks: EmbeddedChunk[]; tokenCount: number; embeddingTokens: number; costMicrocents: number; now: Date },
): Promise<void> {
  await q.exec("delete from knowledge_chunks where version_id = $1", [input.versionId]);
  for (let start = 0; start < input.chunks.length; start += INSERT_BATCH) {
    const batch = input.chunks.slice(start, start + INSERT_BATCH);
    const params: unknown[] = [q.organizationId, input.sourceId, input.versionId, input.now];
    const values = batch.map((chunk) => {
      const base = params.length;
      params.push(chunk.position, chunk.section, chunk.content, chunk.tokenCount, normalizeSearchText(`${chunk.section ?? ""} ${chunk.content}`), toVectorLiteral(chunk.embedding));
      return `($1, $2, $3, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector, $4)`;
    });
    await q.exec(
      `insert into knowledge_chunks (organization_id, source_id, version_id, position, section, content, token_count, search_text, embedding, created_at) values ${values.join(", ")}`,
      params,
    );
  }
  await q.exec(
    `update knowledge_versions set status = 'ready', error_code = null, raw = null, content_text = $2, token_count = $3, chunk_count = $4, embedding_tokens = $5, cost_microcents = $6, finished_at = $7
      where id = $1`,
    [input.versionId, input.text, input.tokenCount, input.chunks.length, input.embeddingTokens, input.costMicrocents, input.now],
  );
  // Só publica se esta for a versão mais nova que ficou pronta (uma mais velha que termina atrasada não desfaz a nova).
  const latest = await q.one<{ id: string }>("select id from knowledge_versions where source_id = $1 and status = 'ready' order by version desc limit 1", [input.sourceId]);
  if (latest?.id === input.versionId) {
    await q.exec(
      `update knowledge_sources set current_version_id = $2, status = 'ready', error_code = null, size_bytes = (select size_bytes from knowledge_versions where id = $2),
              token_count = $3, chunk_count = $4, index_cost_microcents = index_cost_microcents + $5, indexed_at = $6, updated_at = $6 where id = $1`,
      [input.sourceId, input.versionId, input.tokenCount, input.chunks.length, input.costMicrocents, input.now],
    );
    await q.exec("update knowledge_versions set status = 'superseded', raw = null, content_text = null where source_id = $1 and id <> $2 and status = 'ready'", [input.sourceId, input.versionId]);
    await q.exec("delete from knowledge_chunks where source_id = $1 and version_id <> $2", [input.sourceId, input.versionId]);
  } else {
    await q.exec("update knowledge_sources set index_cost_microcents = index_cost_microcents + $2 where id = $1", [input.sourceId, input.costMicrocents]);
  }
  await q.exec(
    `insert into knowledge_usage (organization_id, source_id, version_id, kind, model, tokens, cost_microcents, at)
     select organization_id, source_id, id, 'index', embedding_model, $2, $3, $4 from knowledge_versions where id = $1`,
    [input.versionId, input.embeddingTokens, input.costMicrocents, input.now],
  );
}

/** Registra que a indexação desta versão não deu certo. A versão corrente anterior segue respondendo. */
export async function failKnowledgeVersion(q: OrgQuery, versionId: string, code: KnowledgeErrorCode, now: Date, text?: string): Promise<void> {
  const row = await q.one<{ source_id: string }>(
    `update knowledge_versions set status = 'failed', error_code = $2, raw = null, content_text = coalesce($4, content_text), finished_at = $3
      where id = $1 and status in ('queued', 'processing') returning source_id`,
    [versionId, code, now, text ?? null],
  );
  if (!row) return;
  // O estado da fonte espelha a versão mais recente, que pode já ser outra.
  await q.exec(
    `update knowledge_sources set status = 'failed', error_code = $2, updated_at = $3
      where id = $1 and not exists (select 1 from knowledge_versions v where v.source_id = $1 and v.status in ('queued', 'processing'))`,
    [row.source_id, code, now],
  );
}

export interface KnowledgeCostSummary {
  indexTokens: number;
  indexCostMicrocents: number;
  searchTokens: number;
  searchCostMicrocents: number;
}

/** O gasto de embedding da empresa num período: indexação e buscas de teste (a busca da ligação está no extrato). */
export async function getKnowledgeCost(q: OrgQuery, from: Date, to: Date): Promise<KnowledgeCostSummary> {
  const rows = await q.many<{ kind: "index" | "search"; tokens: string; cost: string }>(
    "select kind, coalesce(sum(tokens), 0)::text as tokens, coalesce(sum(cost_microcents), 0)::text as cost from knowledge_usage where at >= $1 and at < $2 group by kind",
    [from, to],
  );
  const of = (kind: "index" | "search") => rows.find((row) => row.kind === kind);
  return {
    indexTokens: Number(of("index")?.tokens ?? 0),
    indexCostMicrocents: Number(of("index")?.cost ?? 0),
    searchTokens: Number(of("search")?.tokens ?? 0),
    searchCostMicrocents: Number(of("search")?.cost ?? 0),
  };
}

/** Registra o gasto de uma busca de teste feita na tela. */
export async function recordKnowledgeSearchUsage(q: OrgQuery, input: { tokens: number; costMicrocents: number; now: Date }): Promise<void> {
  await q.exec("insert into knowledge_usage (organization_id, kind, model, tokens, cost_microcents, at) values ($1, 'search', $2, $3, $4, $5)", [
    q.organizationId,
    EMBEDDING_MODEL,
    input.tokens,
    input.costMicrocents,
    input.now,
  ]);
}
