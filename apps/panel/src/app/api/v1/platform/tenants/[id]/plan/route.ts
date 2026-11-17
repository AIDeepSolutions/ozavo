import { PLAN_CATALOG, planSubscriptionInput, setPlatformTenantPlan } from "@ozavo/core";
import { handle, notFound } from "../../../../../../../server/context";

/**
 * Troca o plano de uma empresa cliente: do catálogo, ou Personalizado com preço, franquia,
 * excedente e chamadas simultâneas. Só dono ou administrador da plataforma. Registrado na empresa
 * (`plan_changed`, com quem trocou) e na plataforma (`tenant_plan_changed`).
 */
export const PUT = handle({ body: planSubscriptionInput, platform: true }, async ({ body, deps, session, params }) => {
  const subscription = await setPlatformTenantPlan(deps.db, session.organizationId, session.userId, params.id ?? "", body, deps.clock.now());
  if (!subscription) throw notFound();
  return { subscription, catalog: PLAN_CATALOG };
});
