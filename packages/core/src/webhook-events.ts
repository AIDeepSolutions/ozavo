import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { enqueueTask } from "./queue";
import type { OrgQuery } from "./types";

/** Os fatos que uma empresa pode receber. Fechado aqui e no `check` de `webhook_subscriptions`. */
export const WEBHOOK_EVENTS = ["call.ended", "call.outcome", "usage.alert", "cadence.reduced"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** O `tasks.kind` da entrega de uma assinatura (`apps/routines/src/routines/deliver_subscription_webhook.ts`). */
export const DELIVER_SUBSCRIPTION_TASK = "deliver_subscription_webhook";

/** O corpo enviado, em JSON. `id` é o mesmo em todas as tentativas, para o destino deduplicar. */
export interface WebhookEnvelope {
  id: string;
  event: WebhookEvent;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface DeliverySubscriptionPayload {
  subscriptionId: string;
  envelope: WebhookEnvelope;
}

/** Quanto o relógio de quem recebe pode divergir do nosso antes de a assinatura ser recusada. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_SIGNATURE_HEADER = "X-Ozavo-Signature";

const hmac = (secret: string, timestamp: number, body: string): string => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/** O valor do cabeçalho `X-Ozavo-Signature`: `t=<segundos>,v1=<HMAC-SHA256 hex de "t.corpo">`. */
export function signWebhook(secret: string, body: string, now: Date): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

/**
 * Confere a assinatura como o destino deve conferir: o HMAC bate com o corpo recebido e o
 * carimbo está dentro da tolerância (contra repetição de uma entrega capturada).
 */
export function verifyWebhookSignature(secret: string, header: string, body: string, now: Date, toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS): boolean {
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  const given = parts.v1;
  if (!Number.isInteger(timestamp) || typeof given !== "string") return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(hmac(secret, timestamp, body), "hex");
  const actual = Buffer.from(given, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Põe na fila uma entrega por assinatura ativa da empresa que assina `event`. Roda na transação que
 * gravou o fato, então sai uma vez por fato. A empresa vem de `organizationId` e a consulta filtra por
 * ela: a empresa A nunca enfileira entrega de uma assinatura da B. Devolve quantas entregas.
 *
 * Numa instalação que atualizou o código e ainda não aplicou a migration das assinaturas, a tabela não
 * existe: o fato (o fim da chamada, o alerta) não pode falhar por isso, então a existência dela é
 * conferida antes (sem savepoint, porque quem grava o fim da chamada também usa consulta sem transação).
 */
export async function queueWebhookEvent(q: OrgQuery, organizationId: string, event: WebhookEvent, data: Record<string, unknown>, now: Date, callId?: string): Promise<number> {
  const present = await q.one<{ present: boolean }>("select to_regclass('public.webhook_subscriptions') is not null as present");
  if (!present?.present) return 0;
  const subscriptions = await q.many<{ id: string }>("select id from webhook_subscriptions where organization_id = $1 and enabled and $2 = any(events) order by created_at", [organizationId, event]);
  if (subscriptions.length === 0) return 0;
  const envelope: WebhookEnvelope = { id: randomUUID(), event, occurredAt: now.toISOString(), data };
  for (const subscription of subscriptions) {
    const payload: DeliverySubscriptionPayload = { subscriptionId: subscription.id, envelope };
    await enqueueTask(q, { kind: DELIVER_SUBSCRIPTION_TASK, payload, organizationId, runAt: now, ...(callId !== undefined && { callId }) });
  }
  return subscriptions.length;
}
