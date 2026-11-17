import { DELIVER_SUBSCRIPTION_TASK, MAX_TASK_ATTEMPTS, WEBHOOK_SIGNATURE_HEADER, decryptSecret, checkWebhookUrl, recordOrgEvent, scrubWebhookError, signWebhook, withOrg } from "@ozavo/core";
import { UnsafeDestinationError, safeFetch } from "@ozavo/tools";
import { z } from "zod";
import type { Routine } from "../types";

const payloadSchema = z.object({
  subscriptionId: z.uuid(),
  envelope: z.object({ id: z.string().min(1), event: z.string().min(1), occurredAt: z.string().min(1), data: z.record(z.string(), z.unknown()) }),
});

// Um destino que não responde em 5 s já falhou: a fila tenta de novo com recuo, e a rotina é uma só.
const TIMEOUT_MS = 5000;
// A resposta do destino não é guardada nem mostrada; basta ler o suficiente para fechar a conexão.
const MAX_RESPONSE_BYTES = 1024;

function describeFailure(error: unknown, url: string): string {
  if (error instanceof UnsafeDestinationError) return scrubWebhookError(`destination_refused: ${error.message}`, url);
  const message = error instanceof Error ? error.message : String(error);
  // O destino respondeu com redirecionamento: nunca seguimos (poderia apontar para dentro da rede).
  if (message.startsWith("Too many redirects")) return "redirect_not_followed";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  // O texto do erro do cliente HTTP pode trazer o endereço inteiro, com `?token=`: sai só o público.
  return scrubWebhookError(message, url);
}

/**
 * Entrega um fato (`call.ended`, `call.outcome`, `usage.alert`, `cadence.reduced`) a uma assinatura de
 * webhook da empresa. O corpo é JSON e vai assinado com HMAC-SHA256 em `X-Ozavo-Signature`
 * (`t=<segundos>,v1=<hex>`); o carimbo é refeito a cada tentativa. O destino é conferido AGORA: só
 * https, e o DNS é resolvido na hora da conexão, recusando IP privado, loopback, link-local e metadados
 * de nuvem; redirecionamento não é seguido. O resultado de cada tentativa vira `webhook_delivered` ou
 * `webhook_failed` na linha do tempo da empresa, e a falha devolve a tarefa à fila (recuo de `failTask`).
 */
const routine: Routine = {
  kind: DELIVER_SUBSCRIPTION_TASK,
  async run(task, deps) {
    const { subscriptionId, envelope } = payloadSchema.parse(task.payload);
    const now = deps.clock.now();
    // A assinatura é lida pela empresa da tarefa: a da empresa A nunca resolve uma assinatura da B.
    const subscription = await withOrg(deps.db, task.organizationId, (q) =>
      q.one<{ url: string; secret_enc: string; enabled: boolean }>("select url, secret_enc, enabled from webhook_subscriptions where id = $1", [subscriptionId]),
    );
    // Desligada ou removida depois do fato: não há a quem entregar, e repetir não muda isso.
    if (!subscription?.enabled) return;

    const body = JSON.stringify(envelope);
    let status: number | null = null;
    let failure: string | null = null;
    try {
      // As mesmas regras do cadastro, de novo: https, sem usuário e senha, porta 443 ou 1024 a 65535.
      const problem = checkWebhookUrl(subscription.url);
      if (problem !== null) throw new UnsafeDestinationError(`Webhook URL refused (${problem})`);
      const secret = decryptSecret(subscription.secret_enc, deps.secretKey);
      const response = await safeFetch(
        subscription.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Ozavo-Webhooks/1",
            "X-Ozavo-Event": envelope.event,
            "X-Ozavo-Delivery": envelope.id,
            [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body, now),
          },
          body,
        },
        { fetch: deps.fetch, lookup: deps.lookup, timeoutMs: TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES, maxRedirects: 0 },
      );
      status = response.status;
      if (!response.ok) failure = `http_${response.status}`;
    } catch (error) {
      failure = describeFailure(error, subscription.url);
    }

    const final = failure === null || task.attempts >= MAX_TASK_ATTEMPTS;
    const facts = { subscriptionId, host: new URL(subscription.url).host, event: envelope.event, eventId: envelope.id, attempt: task.attempts, status, final };
    await withOrg(deps.db, task.organizationId, (q) => recordOrgEvent(q, failure === null ? "webhook_delivered" : "webhook_failed", failure === null ? facts : { ...facts, error: failure }, deps.clock.now()));
    if (failure !== null) throw new Error(`Webhook delivery failed: ${failure}`);
  },
};

export default routine;
