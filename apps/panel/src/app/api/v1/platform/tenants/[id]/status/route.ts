import { TENANT_STATUSES, setPlatformTenantStatus } from "@ozavo/core";
import { z } from "zod";
import { handle, notFound } from "../../../../../../../server/context";

const body = z.object({ status: z.enum(TENANT_STATUSES) });

/**
 * Suspende ou reativa a empresa. Suspensa, ela não recebe nem origina ligações e as chaves de API
 * dela deixam de valer. Registrado na empresa e na plataforma.
 */
export const POST = handle({ body, platform: true }, async ({ body, deps, session, params }) => {
  const done = await setPlatformTenantStatus(deps.db, session.organizationId, session.userId, params.id ?? "", body.status, deps.clock.now());
  if (!done) throw notFound();
  return { status: body.status };
});
