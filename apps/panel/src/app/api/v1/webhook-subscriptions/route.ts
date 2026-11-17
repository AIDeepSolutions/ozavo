import { MAX_WEBHOOK_SUBSCRIPTIONS, WEBHOOK_EVENTS, WebhookLimitError, checkWebhookUrl, createWebhookSubscription, listWebhookSubscriptions } from "@ozavo/core";
import { UnsafeDestinationError, assertPublicDestination } from "@ozavo/tools/net";
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
      const problem = checkWebhookUrl(body.url);
      if (problem === "https_required") throw new ApiError(422, "https_required", "The webhook URL must start with https://.");
      if (problem === "url_credentials") throw new ApiError(400, "url_credentials", "The webhook URL must not carry a user name or password.");
      if (problem === "port_not_allowed") throw new ApiError(422, "port_not_allowed", "The webhook URL port must be 443 or between 1024 and 65535.");
      if (problem === "invalid") throw new ApiError(400, "validation_error", "url: not a valid URL");
      try {
        await assertPublicDestination(body.url, deps.lookup);
      } catch (error) {
        if (error instanceof UnsafeDestinationError) throw new ApiError(422, "destination_refused", error.message);
        throw new ApiError(422, "destination_unreachable", "The webhook host could not be resolved.");
      }
    },
  },
  async ({ q, body, session, deps }) => {
    try {
      return await createWebhookSubscription(q, { url: body.url, events: body.events, createdBy: session.userId }, deps.secretKey, deps.clock.now());
    } catch (error) {
      if (error instanceof WebhookLimitError) throw new ApiError(409, "webhook_limit", `A company can have at most ${MAX_WEBHOOK_SUBSCRIPTIONS} webhooks. Remove one first.`);
      throw error;
    }
  },
);
