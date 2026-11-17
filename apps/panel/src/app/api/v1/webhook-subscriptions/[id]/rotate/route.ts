import { rotateWebhookSecret } from "@ozavo/core";
import { handle, notFound } from "../../../../../../server/context";

/** Troca o segredo. O antigo deixa de valer na hora e o novo aparece só nesta resposta. */
export const POST = handle({ configure: true }, async ({ q, params, session, deps }) => {
  const secret = await rotateWebhookSecret(q, params.id ?? "", deps.secretKey, session.userId, deps.clock.now());
  if (secret === null) throw notFound();
  return { secret };
});
