import { getPlatformTenant } from "@ozavo/core";
import { handle, notFound } from "../../../../../../server/context";
import { keylessEngineIds } from "../../../../../../server/pieces";

/** Uma empresa cliente: plano, franquia, FinOps do ciclo e o registro da organização. */
export const GET = handle({ platform: true }, async ({ deps, session, params }) => {
  const tenant = await getPlatformTenant(deps.db, session.organizationId, params.id ?? "", deps.clock.now(), await keylessEngineIds());
  if (!tenant) throw notFound();
  return tenant;
});
