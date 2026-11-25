import { recordOrgEvent, replaceKnowledgeSource } from "@ozavo/core";
import { handleUpload } from "../../../../../../server/knowledge";

/** Troca o conteúdo por um arquivo ou texto novo: versão nova; a anterior segue valendo até a nova ficar pronta. */
export const POST = handleUpload(async ({ q, params, upload, session, deps }) => {
  const now = deps.clock.now();
  const result = await replaceKnowledgeSource(q, params.id ?? "", { kind: upload.kind, filename: upload.filename, raw: upload.raw, text: upload.text, createdBy: session.userId, now });
  await recordOrgEvent(q, "knowledge_source_changed", { sourceId: params.id, change: "replaced", versionId: result.versionId, kind: upload.kind }, now, session.userId);
  return result;
});
