import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createDb, createKnowledgeSource, getAgentKnowledge, loadConfig, replaceKnowledgeSource, setAgentKnowledge, withOrg, type Db, type KnowledgeKind } from "@ozavo/core";
import { z } from "zod";
import { cliArgs } from "./args";

const KIND_BY_EXTENSION: Record<string, KnowledgeKind> = { ".pdf": "pdf", ".docx": "docx", ".md": "md", ".markdown": "md", ".txt": "txt" };

const inputSchema = z.object({
  organizationId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  file: z.string().min(1),
  agentIds: z.array(z.uuid()).default([]),
});
export type ImportKnowledgeInput = z.input<typeof inputSchema>;
export interface ImportKnowledgeResult {
  sourceId: string;
  versionId: string;
  /** `true` quando já existia uma fonte com o mesmo nome e o arquivo virou a versão seguinte dela. */
  replaced: boolean;
  linkedAgents: string[];
}

/**
 * Importa um arquivo para a base de conhecimento de uma empresa e, se pedido, o liga a agentes (somando
 * às bases que eles já têm; o modo e o "só pela base" de cada agente não mudam). A indexação roda na
 * rotina `index_knowledge`, como no envio pela tela. Rodar de novo com o mesmo nome troca o conteúdo (versão
 * nova) em vez de duplicar a fonte. Serve para trazer bases de outro sistema e para carga em lote; o uso
 * do dia a dia é a tela "Base de conhecimento".
 */
export async function importKnowledge(db: Db, input: ImportKnowledgeInput, now: Date): Promise<ImportKnowledgeResult> {
  const parsed = inputSchema.parse(input);
  const kind = KIND_BY_EXTENSION[extname(parsed.file).toLowerCase()];
  if (!kind) throw new Error(`tipo de arquivo não aceito: ${extname(parsed.file) || "(sem extensão)"}. Use .pdf, .docx, .md ou .txt`);
  const raw = await readFile(parsed.file);
  return withOrg(db, parsed.organizationId, async (q) => {
    const existing = await q.one<{ id: string }>("select id from knowledge_sources where name = $1 order by created_at limit 1", [parsed.name]);
    const common = { kind, filename: basename(parsed.file), raw, createdBy: null, now };
    const done = existing
      ? { sourceId: existing.id, ...(await replaceKnowledgeSource(q, existing.id, common)), replaced: true }
      : { ...(await createKnowledgeSource(q, { ...common, name: parsed.name })), replaced: false };
    const linkedAgents: string[] = [];
    for (const agentId of parsed.agentIds) {
      const current = await getAgentKnowledge(q, agentId);
      if (!current) throw new Error(`agente ${agentId} não existe nesta empresa`);
      await setAgentKnowledge(q, agentId, { sourceIds: [...new Set([...current.linkedIds, done.sourceId])], mode: current.mode, only: current.only }, now);
      linkedAgents.push(agentId);
    }
    return { sourceId: done.sourceId, versionId: done.versionId, replaced: done.replaced, linkedAgents };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ args: cliArgs(), options: { org: { type: "string" }, name: { type: "string" }, file: { type: "string" }, agent: { type: "string", multiple: true } } });
  if (!values.org || !values.name || !values.file) {
    throw new Error("uso: import-knowledge --org <id da empresa> --name <nome da base> --file <arquivo.pdf|docx|md|txt> [--agent <id do agente> ...]");
  }
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl, config.systemDatabaseUrl);
  try {
    const result = await importKnowledge(db, { organizationId: values.org, name: values.name, file: values.file, agentIds: values.agent ?? [] }, new Date());
    process.stdout.write(`${result.replaced ? "Versão nova da base" : "Base criada"}: ${result.sourceId} (indexação na fila, versão ${result.versionId}). Agentes ligados: ${result.linkedAgents.length}.\n`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`import-knowledge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
