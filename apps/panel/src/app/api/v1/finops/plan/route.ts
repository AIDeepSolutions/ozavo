import { PLAN_CATALOG, getPlanSubscription, localDay, planSubscriptionInput, setPlanSubscription } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/** O plano da organização (`null` sem plano) e o catálogo, para a tela mostrar preço e franquia. */
export const GET = handle({}, async ({ q }) => ({ subscription: await getPlanSubscription(q), catalog: PLAN_CATALOG }));

export const PUT = handle({ body: planSubscriptionInput, configure: true }, async ({ q, body, deps, session }) => {
  const now = deps.clock.now();
  const { day } = await localDay(q, now);
  return { subscription: await setPlanSubscription(q, body, now, day, session.userId), catalog: PLAN_CATALOG };
});
