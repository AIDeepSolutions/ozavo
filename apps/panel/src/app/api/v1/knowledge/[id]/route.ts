import { deleteKnowledgeSource, getKnowledgeSource, recordOrgEvent, renameKnowledgeSource } from "@ozavo/core";
import { z } from "zod";
import { handle, notFound } from "../../../../../server/context";
import { translated } from "../../../../../server/knowledge";

export const GET = handle({}, async ({ q, params }) => {
  const source = await getKnowledgeSource(q, params.id ?? "");
  if (!source) throw notFound();
  return source;
});

/** Renomeia. O conteúdo se troca por `replace`; o nome não mexe na indexação. */
export const PATCH = handle(
  { body: z.object({ name: z.string().trim().min(1).max(200) }), configure: true },
  translated(async ({ q, params, body, session, deps }) => {
    const now = deps.clock.now();
    if (!(await renameKnowledgeSource(q, params.id ?? "", body.name, now))) throw notFound();
    await recordOrgEvent(q, "knowledge_source_changed", { sourceId: params.id, change: "renamed", name: body.name }, now, session.userId);
    return getKnowledgeSource(q, params.id ?? "");
  }),
);

/**
 * Apaga a fonte, as versões, os trechos e o vínculo com os agentes. Não tem volta. O custo que a indexação
 * já teve fica no registro de uso da empresa, sem a fonte.
 */
export const DELETE = handle({ configure: true }, async ({ q, params, session, deps }) => {
  const source = await getKnowledgeSource(q, params.id ?? "");
  if (!source || !(await deleteKnowledgeSource(q, source.id))) throw notFound();
  await recordOrgEvent(q, "knowledge_source_removed", { sourceId: source.id, name: source.name, kind: source.kind, agentCount: source.agentCount }, deps.clock.now(), session.userId);
  return { removed: true, agentCount: source.agentCount };
});
