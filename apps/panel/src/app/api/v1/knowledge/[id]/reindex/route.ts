import { recordOrgEvent, reindexKnowledgeSource } from "@ozavo/core";
import { handle, type HandlerArgs } from "../../../../../../server/context";
import { translated } from "../../../../../../server/knowledge";

/** Indexa de novo o texto já extraído, sem novo envio. A versão atual segue respondendo até a nova ficar pronta. */
export const POST = handle(
  { configure: true },
  translated(async ({ q, params, session, deps }: HandlerArgs<undefined>) => {
    const now = deps.clock.now();
    const result = await reindexKnowledgeSource(q, params.id ?? "", session.userId, now);
    await recordOrgEvent(q, "knowledge_source_reindexed", { sourceId: params.id, versionId: result.versionId }, now, session.userId);
    return result;
  }),
);
