import { FULL_PROMPT_MAX_TOKENS, getAgentKnowledge, setAgentKnowledge } from "@ozavo/core";
import { z } from "zod";
import { handle, notFound } from "../../../../../../server/context";
import { translated } from "../../../../../../server/knowledge";

/** As bases do agente, o modo de uso e o "responder só pela base". `linkedIds` traz as vinculadas, prontas ou não. */
export const GET = handle({}, async ({ q, params }) => {
  const knowledge = await getAgentKnowledge(q, params.id ?? "");
  if (!knowledge) throw notFound();
  return { ...knowledge, fullPromptMaxTokens: FULL_PROMPT_MAX_TOKENS };
});

const body = z.object({
  sourceIds: z.array(z.uuid()).max(200),
  mode: z.enum(["auto", "rag", "full"]),
  only: z.boolean(),
});

/** Define, de uma vez, as bases, o modo e a chave "só pela base". Fonte de outra empresa nem é vista: 404. */
export const PUT = handle(
  { body, configure: true },
  translated(async ({ q, params, body: input, deps }) => {
    if (!(await setAgentKnowledge(q, params.id ?? "", { sourceIds: input.sourceIds, mode: input.mode, only: input.only }, deps.clock.now()))) throw notFound();
    const knowledge = await getAgentKnowledge(q, params.id ?? "");
    return { ...knowledge, fullPromptMaxTokens: FULL_PROMPT_MAX_TOKENS };
  }),
);
