import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

/** Namespace fixo dos ids de evento (UUID v5): o mesmo fato dá sempre o mesmo id. */
const EVENT_NAMESPACE = "6f1d2c9a-3b7e-5a41-9c0d-4e8a7b2f1c63";

/** UUID v5 (SHA-1) de `name` no namespace dos eventos. */
export function deterministicEventId(name: string): string {
  const hash = createHash("sha1").update(Buffer.from(EVENT_NAMESPACE.replaceAll("-", ""), "hex")).update(name).digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Põe na fila uma entrega por assinatura ativa da empresa que assina `event`. Roda na transação que
 * gravou o fato, então sai uma vez por fato. A empresa vem de `organizationId` e a consulta filtra por
 * ela: a empresa A nunca enfileira entrega de uma assinatura da B. Devolve quantas entregas entraram.
 *
 * Fato de uma chamada (`callId`) tem id DETERMINÍSTICO por (empresa, chamada, evento): se o mesmo
 * fim de chamada for gravado duas vezes, o destino recebe o mesmo `id` e a segunda tarefa nem é criada
 * (a conferência olha as tarefas ainda na tabela; elas ficam 7 dias). Duas transações simultâneas
 * podem passar juntas pela conferência: o `id` igual é o que deixa o destino deduplicar.
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
  const envelope: WebhookEnvelope = { id: callId === undefined ? randomUUID() : deterministicEventId(`${organizationId}|${callId}|${event}`), event, occurredAt: now.toISOString(), data };
  let queued = 0;
  for (const subscription of subscriptions) {
    if (callId !== undefined) {
      const already = await q.one(
        "select 1 as hit from tasks where organization_id = $1 and kind = $2 and payload->>'subscriptionId' = $3 and payload->'envelope'->>'id' = $4 limit 1",
        [organizationId, DELIVER_SUBSCRIPTION_TASK, subscription.id, envelope.id],
      );
      if (already) continue;
    }
    const payload: DeliverySubscriptionPayload = { subscriptionId: subscription.id, envelope };
    await enqueueTask(q, { kind: DELIVER_SUBSCRIPTION_TASK, payload, organizationId, runAt: now, ...(callId !== undefined && { callId }) });
    queued += 1;
  }
  return queued;
}

/**
 * Duas consultas na mesma transação veem o mesmo `txid_current()`; numa consulta de commit automático
 * (`autoCommitOrgQuery`, a do fim da chamada) cada uma abre a sua. Só no primeiro caso há savepoint.
 */
async function inOneTransaction(q: OrgQuery): Promise<boolean> {
  const first = await q.one<{ id: string }>("select txid_current()::text as id");
  const second = await q.one<{ id: string }>("select txid_current()::text as id");
  return first?.id === second?.id;
}

/**
 * `queueWebhookEvent` sem poder derrubar quem a chama: o fim da chamada, o alerta e o desfecho valem
 * mais que o aviso ao destino. Numa transação, o erro volta ao savepoint (o erro de SQL aborta a
 * transação inteira sem isso); fora dela (consulta de commit automático) não há o que desfazer.
 * Devolve o texto do erro, para o chamador registrar como evento, ou `null`.
 */
export async function tryQueueWebhookEvent(q: OrgQuery, organizationId: string, event: WebhookEvent, data: Record<string, unknown>, now: Date, callId?: string): Promise<string | null> {
  const text = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
  let savepoint = false;
  try {
    savepoint = await inOneTransaction(q);
    if (savepoint) await q.exec("savepoint queue_webhook_event");
  } catch (error) {
    return text(error);
  }
  try {
    await queueWebhookEvent(q, organizationId, event, data, now, callId);
    if (savepoint) await q.exec("release savepoint queue_webhook_event");
    return null;
  } catch (error) {
    if (savepoint) await q.exec("rollback to savepoint queue_webhook_event");
    return text(error);
  }
}
