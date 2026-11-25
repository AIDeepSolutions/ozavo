import { createKnowledgeSource, listKnowledgeSources, recordOrgEvent } from "@ozavo/core";
import { handle } from "../../../../server/context";
import { handleUpload } from "../../../../server/knowledge";

/** As fontes da base de conhecimento da empresa, com o estado de cada uma. Qualquer papel lê. */
export const GET = handle({}, async ({ q }) => ({ sources: await listKnowledgeSources(q) }));

/**
 * Cria uma fonte e enfileira a indexação, que roda em segundo plano (`index_knowledge`): a resposta sai
 * com a fonte "na fila". Arquivo (PDF, DOCX, Markdown, texto) por `multipart/form-data`, ou texto colado
 * por JSON `{ name, text }`.
 */
export const POST = handleUpload(async ({ q, upload, session, deps }) => {
  const now = deps.clock.now();
  const name = upload.name ?? "";
  const created = await createKnowledgeSource(q, { name, kind: upload.kind, filename: upload.filename, raw: upload.raw, text: upload.text, createdBy: session.userId, now });
  await recordOrgEvent(q, "knowledge_source_created", { sourceId: created.sourceId, name: name.trim(), kind: upload.kind, sizeBytes: upload.raw?.length ?? Buffer.byteLength(upload.text ?? "") }, now, session.userId);
  return created;
});
