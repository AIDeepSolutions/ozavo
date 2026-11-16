import { revokeApiKey } from "@ozavo/core";
import { handle, notFound } from "../../../../../server/context";

/** Revoga a chave na hora: o próximo pedido com ela já recebe 401. Não tem volta. */
export const DELETE = handle({ configure: true }, async ({ q, params, session, deps }) => {
  if (!(await revokeApiKey(q, params.id ?? "", session.userId, deps.clock.now()))) throw notFound();
  return { revoked: true };
});
