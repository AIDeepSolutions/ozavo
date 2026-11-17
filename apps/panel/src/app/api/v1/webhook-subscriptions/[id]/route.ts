import { removeWebhookSubscription, setWebhookEnabled } from "@ozavo/core";
import { z } from "zod";
import { handle, notFound } from "../../../../../server/context";

/** Liga ou desliga a entrega. Desligar não apaga nada: o cadastro e o segredo continuam. */
export const PATCH = handle({ body: z.object({ enabled: z.boolean() }), configure: true }, async ({ q, params, body, session, deps }) => {
  if (!(await setWebhookEnabled(q, params.id ?? "", body.enabled, session.userId, deps.clock.now()))) throw notFound();
  return { enabled: body.enabled };
});

/** Remove o destino. As entregas já na fila para ele são descartadas. Não tem volta. */
export const DELETE = handle({ configure: true }, async ({ q, params, session, deps }) => {
  if (!(await removeWebhookSubscription(q, params.id ?? "", session.userId, deps.clock.now()))) throw notFound();
  return { removed: true };
});
