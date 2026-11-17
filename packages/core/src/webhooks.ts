import { randomBytes } from "node:crypto";
import { recordOrgEvent } from "./events";
import { encryptSecret } from "./secrets";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./webhook-events";
import type { OrgQuery } from "./types";

export interface WebhookSubscriptionView {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  secretRotatedAt: Date | null;
}

export interface WebhookDeliveryView {
  id: number;
  at: Date;
  kind: "webhook_delivered" | "webhook_failed";
  event: string;
  eventId: string;
  attempt: number;
  status: number | null;
  error: string | null;
  final: boolean;
}

const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;

/**
 * Nunca selecionamos `secret_enc` numa leitura que vá à tela: a lista de colunas é esta, escrita à
 * mão, para que uma coluna nova (e secreta) não entre numa resposta por descuido.
 */
const VIEW_COLUMNS = `id, url, events, enabled, created_at as "createdAt", updated_at as "updatedAt", secret_rotated_at as "secretRotatedAt"`;

/** Um segredo novo, em claro. É mostrado uma vez e depois só existe cifrado. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export async function createWebhookSubscription(
  q: OrgQuery,
  input: { url: string; events: readonly WebhookEvent[]; createdBy: string | null },
  secretKey: Buffer,
  now: Date,
): Promise<{ id: string; secret: string }> {
  const events = [...new Set(input.events)];
  const secret = generateWebhookSecret();
  const row = await q.one<{ id: string }>(
    "insert into webhook_subscriptions (organization_id, url, events, secret_enc, created_by, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $6) returning id",
    [q.organizationId, input.url, events, encryptSecret(secret, secretKey), input.createdBy, now],
  );
  if (!row) throw new Error("Webhook subscription was not created");
  await recordOrgEvent(q, "webhook_subscription_created", { subscriptionId: row.id, url: input.url, events }, now, input.createdBy);
  return { id: row.id, secret };
}

export function listWebhookSubscriptions(q: OrgQuery): Promise<WebhookSubscriptionView[]> {
  return q.many<WebhookSubscriptionView & { [key: string]: unknown }>(`select ${VIEW_COLUMNS} from webhook_subscriptions where organization_id = $1 order by created_at desc`, [q.organizationId]);
}

/** Liga ou desliga. Devolve `false` se a assinatura não existe nesta empresa. */
export async function setWebhookEnabled(q: OrgQuery, id: string, enabled: boolean, actorUserId: string | null, now: Date): Promise<boolean> {
  const row = await q.one<{ url: string }>("update webhook_subscriptions set enabled = $2, updated_at = $3 where organization_id = $4 and id = $1 returning url", [id, enabled, now, q.organizationId]);
  if (!row) return false;
  await recordOrgEvent(q, "webhook_subscription_changed", { subscriptionId: id, url: row.url, enabled }, now, actorUserId);
  return true;
}

/** Troca o segredo: o antigo deixa de valer na hora. Devolve o novo, em claro, ou `null` se não existe. */
export async function rotateWebhookSecret(q: OrgQuery, id: string, secretKey: Buffer, actorUserId: string | null, now: Date): Promise<string | null> {
  const secret = generateWebhookSecret();
  const row = await q.one<{ url: string }>(
    "update webhook_subscriptions set secret_enc = $2, secret_rotated_at = $3, updated_at = $3 where organization_id = $4 and id = $1 returning url",
    [id, encryptSecret(secret, secretKey), now, q.organizationId],
  );
  if (!row) return null;
  await recordOrgEvent(q, "webhook_secret_rotated", { subscriptionId: id, url: row.url }, now, actorUserId);
  return secret;
}

export async function removeWebhookSubscription(q: OrgQuery, id: string, actorUserId: string | null, now: Date): Promise<boolean> {
  const row = await q.one<{ url: string }>("delete from webhook_subscriptions where organization_id = $2 and id = $1 returning url", [id, q.organizationId]);
  if (!row) return false;
  await recordOrgEvent(q, "webhook_subscription_removed", { subscriptionId: id, url: row.url }, now, actorUserId);
  return true;
}

/** As últimas entregas de uma assinatura, da mais nova para a mais antiga: o que a rotina gravou. */
export async function listWebhookDeliveries(q: OrgQuery, subscriptionId: string, limit = 20): Promise<WebhookDeliveryView[]> {
  const rows = await q.many<{ id: string; at: Date; kind: WebhookDeliveryView["kind"]; payload: Record<string, unknown> }>(
    `select id, at, kind, payload from organization_events
      where organization_id = $1 and kind in ('webhook_delivered', 'webhook_failed') and payload->>'subscriptionId' = $2
      order by id desc limit $3`,
    [q.organizationId, subscriptionId, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    at: row.at,
    kind: row.kind,
    event: String(row.payload.event ?? ""),
    eventId: String(row.payload.eventId ?? ""),
    attempt: Number(row.payload.attempt ?? 1),
    status: typeof row.payload.status === "number" ? row.payload.status : null,
    error: typeof row.payload.error === "string" ? row.payload.error : null,
    final: row.payload.final === true,
  }));
}

export const isWebhookEvent = (value: string): value is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(value);
