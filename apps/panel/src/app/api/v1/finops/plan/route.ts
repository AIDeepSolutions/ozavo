import { PLAN_CATALOG, getPlanSubscription, isPlatformOrganization, localDay, planSubscriptionInput, setPlanSubscription } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/**
 * O plano da organização (`null` sem plano) e o catálogo, para a tela mostrar preço e franquia.
 * `platform` diz se esta organização pode gravar: a tela de uma empresa cliente fica só de leitura.
 */
export const GET = handle({}, async ({ q }) => ({ subscription: await getPlanSubscription(q), catalog: PLAN_CATALOG, platform: await isPlatformOrganization(q) }));

/** Só a plataforma: o plano de uma empresa cliente chega pelo provisionamento (`/tenants/provision`). */
export const PUT = handle({ body: planSubscriptionInput, platform: true }, async ({ q, body, deps, session }) => {
  const now = deps.clock.now();
  const { day } = await localDay(q, now);
  return { subscription: await setPlanSubscription(q, body, now, day, session.userId), catalog: PLAN_CATALOG, platform: true };
});
