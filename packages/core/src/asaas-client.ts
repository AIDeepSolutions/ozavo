import { z } from "zod";

export const asaasEnvironment = z.enum(["sandbox", "production"]);
const id = z.string().min(1).max(200);
export const asaasSubscription = z.object({
  id, customer: id, value: z.number().nonnegative(), cycle: z.literal("MONTHLY"),
  status: z.enum(["ACTIVE", "INACTIVE", "EXPIRED"]), deleted: z.boolean().default(false),
});
export const asaasCustomer = z.object({ id, name: z.string().trim().min(1).max(120), email: z.email().max(254) });
export const asaasEvent = z.object({
  id, event: z.string().regex(/^[A-Z_]+$/).max(100),
  dateCreated: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/),
  payment: z.object({ id, subscription: id.nullish() }).optional(),
  subscription: z.object({ id }).optional(),
});
export type AsaasEvent = z.output<typeof asaasEvent>;
export const ASAAS_EVENTS = ["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED", "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED", "SUBSCRIPTION_INACTIVATED", "SUBSCRIPTION_DELETED"] as const;

/** Somente hosts oficiais. Sem redirects, timeout finito, sem corpo/erro do provedor nos logs. */
export function asaasClient(environment: z.output<typeof asaasEnvironment>, apiKey: string, fetcher: typeof fetch) {
  const base = environment === "sandbox" ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3";
  const get = async (path: string): Promise<unknown> => {
    try {
      const response = await fetcher(`${base}${path}`, { headers: { access_token: apiKey, "User-Agent": "Ozavo" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Asaas API unavailable");
      return await response.json();
    } catch {
      throw new Error("Asaas API unavailable");
    }
  };
  return {
    async subscription(subscriptionId: string) {
      const parsed = asaasSubscription.safeParse(await get(`/subscriptions/${encodeURIComponent(subscriptionId)}`));
      if (!parsed.success || parsed.data.id !== subscriptionId) throw new Error("Asaas subscription invalid or not monthly");
      return parsed.data;
    },
    async customer(customerId: string) {
      const parsed = asaasCustomer.safeParse(await get(`/customers/${encodeURIComponent(customerId)}`));
      if (!parsed.success || parsed.data.id !== customerId) throw new Error("Asaas customer invalid or missing owner email");
      return parsed.data;
    },
  };
}
