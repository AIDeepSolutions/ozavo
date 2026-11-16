import { API_KEY_SCOPES, PLATFORM_SCOPES, createApiKey, isPlatformOrganization, listApiKeys } from "@ozavo/core";
import { z } from "zod";
import { ApiError, handle } from "../../../../server/context";

/** As chaves de API da empresa, sem o segredo, e os escopos que esta empresa pode emitir. */
export const GET = handle({ configure: true }, async ({ q }) => {
  const platform = await isPlatformOrganization(q);
  return { keys: await listApiKeys(q), scopes: API_KEY_SCOPES.filter((scope) => platform || !PLATFORM_SCOPES.includes(scope)) };
});

const body = z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length) });

/** Cria a chave. O texto dela só aparece nesta resposta: o banco guarda o resumo. */
export const POST = handle({ body, configure: true }, async ({ q, body, session, deps }) => {
  const created = await createApiKey(q, { name: body.name, scopes: body.scopes, createdBy: session.userId }, deps.clock.now());
  if ("refused" in created) throw new ApiError(403, "platform_scope", "Only the organization that runs this installation can create a key that provisions companies.");
  return created;
});
