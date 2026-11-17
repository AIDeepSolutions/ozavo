import { setPlatformTenantRcdName } from "@ozavo/core";
import { z } from "zod";
import { ApiError, handle, notFound } from "../../../../../../../server/context";

/**
 * O nome RCD da empresa. Chega em qualquer grafia (`Clínica São João Ltda`) e sai em CAIXA ALTA,
 * sem acento, até 32 ASCII; o que não cabe é recusado com 400, nunca truncado. `null` limpa.
 * Só dono ou administrador da plataforma. As linhas sem nome próprio herdam este.
 */
export const PUT = handle({ body: z.object({ displayName: z.string().max(200).nullable() }), platform: true }, async ({ body, deps, session, params }) => {
  const saved = await setPlatformTenantRcdName(deps.db, session.organizationId, session.userId, params.id ?? "", body.displayName, deps.clock.now());
  if (saved === "invalid") throw new ApiError(400, "invalid_rcd_name", "The RCD name must have 1 to 32 characters of letters, digits and . & ( ) + _ / -, without accents once normalized.");
  if (!saved) throw notFound();
  return saved;
});
