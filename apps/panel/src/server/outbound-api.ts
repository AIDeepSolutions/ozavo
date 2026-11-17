import { readTenantProfile } from "@ozavo/core";
import { z } from "zod";
import type { ApiKeyArgs } from "./api-auth";
import { ApiError } from "./context";
import { phone, requireAgent } from "./shapes";
import { voiceRequest } from "./voice";

const CONTEXT_MAX_BYTES = 8192;

/** O pedido de UMA ligação de saída por um sistema de fora: `POST /api/v1/calls/outbound` e `POST /api/v1/hooks/call`. */
export const outboundApiBody = z.object({
  // Telefone digitado livremente; sai em E.164 (`toE164`) ou reprova.
  toE164: phone,
  // Sem agente, liga o agente padrão da empresa (o que o provisionamento criou).
  agentId: z.uuid().optional(),
  // O lead e o motivo, entregues ao agente como contexto. Nunca como instrução.
  context: z
    .record(z.string(), z.unknown())
    .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= CONTEXT_MAX_BYTES, `context must have at most ${CONTEXT_MAX_BYTES} bytes as JSON`)
    .optional(),
  // Também aceito no cabeçalho `Idempotency-Key`. O mesmo valor devolve a mesma ligação.
  requestKey: z.string().trim().min(1).max(200).optional(),
});
const voiceAnswer = z.object({ callId: z.string(), repeated: z.boolean().optional() });

/**
 * Entrega o pedido ao processo de voz, que confere a política de saída (`checkOutboundAllowed`: política
 * ligada, janela, lista de não ligar, teto diário e tentativas) e origina a ligação na hora. Uma
 * requisição, uma ligação: não existe lote.
 */
export async function requestOutboundCall({ key, body, request, deps, org }: ApiKeyArgs<z.output<typeof outboundApiBody>>): Promise<{ status: number; data: { callId: string; repeated: boolean } }> {
  const requestKey = body.requestKey ?? request.headers.get("idempotency-key")?.trim().slice(0, 200) ?? undefined;
  const agentId = await org(async (q) => {
    const chosen = body.agentId ?? (await readTenantProfile(q)).defaultAgentId;
    if (!chosen) throw new ApiError(422, "agent_required", "Send agentId: this company has no default agent.");
    await requireAgent(q, chosen);
    return chosen;
  });
  const answer = await voiceRequest(deps, "POST", "/calls/outbound", voiceAnswer, {
    organizationId: key.organizationId,
    agentId,
    toE164: body.toE164,
    apiKeyId: key.id,
    ...(body.context !== undefined && { context: body.context }),
    ...(requestKey ? { requestKey } : {}),
  });
  return { status: answer.repeated ? 200 : 202, data: { callId: answer.callId, repeated: answer.repeated === true } };
}
