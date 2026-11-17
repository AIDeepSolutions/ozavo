import { WEBHOOK_EVENTS, createWebhookSubscription, listWebhookSubscriptions } from "@ozavo/core";
import { UnsafeDestinationError, assertPublicDestination } from "@ozavo/tools";
import { z } from "zod";
import { ApiError, handle } from "../../../../server/context";

/** Os webhooks da empresa, sem o segredo, e os eventos que se pode assinar. */
export const GET = handle({ configure: true }, async ({ q }) => ({ subscriptions: await listWebhookSubscriptions(q), events: WEBHOOK_EVENTS }));

const body = z.object({
  url: z.url().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
});

/**
 * Cadastra o destino. Só https, e o endereço tem de ser público já agora (a entrega confere de novo,
 * porque o DNS muda). O segredo que assina as entregas aparece nesta resposta e nunca mais.
 */
export const POST = handle(
  {
    body,
    configure: true,
    before: async ({ body, deps }) => {
      if (!body.url.startsWith("https://")) throw new ApiError(422, "https_required", "The webhook URL must start with https://.");
      try {
        await assertPublicDestination(body.url, deps.lookup);
      } catch (error) {
        if (error instanceof UnsafeDestinationError) throw new ApiError(422, "destination_refused", error.message);
        throw new ApiError(422, "destination_unreachable", "The webhook host could not be resolved.");
      }
    },
  },
  ({ q, body, session, deps }) => createWebhookSubscription(q, { url: body.url, events: body.events, createdBy: session.userId }, deps.secretKey, deps.clock.now()),
);
