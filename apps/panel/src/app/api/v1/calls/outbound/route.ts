import { readTenantProfile } from "@ozavo/core";
import { z } from "zod";
import { ApiError, handle } from "../../../../../server/context";
import { bearerOf, handleApiKey } from "../../../../../server/api-auth";
import { phone, requireAgent } from "../../../../../server/shapes";
import { voiceRequest } from "../../../../../server/voice";

const body = z.object({ agentId: z.uuid(), toE164: phone });

// O painel não decide se pode ligar: quem aplica a política de saída é o processo de voz
// (`checkOutboundAllowed`), e a recusa dele chega à tela com o código próprio.
const fromPanel = handle(
  {
    body,
    configure: true,
    after: (_agent, { deps, session, body }) =>
      voiceRequest(deps, "POST", "/calls/outbound", z.object({ callId: z.string() }), { organizationId: session.organizationId, agentId: body.agentId, toE164: body.toE164 }),
  },
  ({ q, body }) => requireAgent(q, body.agentId),
);

const CONTEXT_MAX_BYTES = 8192;
const apiBody = z.object({
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
 * Disparo reativo (Speed-to-Lead) por um sistema de fora, com chave de API `calls:outbound`. Não
 * passa pela fila de rotinas (uma tarefa por vez, que pode estar ocupada com um resumo): vai direto
 * ao processo de voz, que confere a política de saída e origina na hora. O prazo do pedido ao
 * processo de voz é 5 s; sem resposta nesse tempo, a resposta é `voice_unavailable`.
 */
const fromApi = handleApiKey({ scope: "calls:outbound", body: apiBody }, async ({ key, body, request, deps, org }) => {
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
});

export const POST = (request: Request, context: { params: Promise<Record<string, string> | undefined> }): Promise<Response> =>
  bearerOf(request) === undefined ? fromPanel(request, context) : fromApi(request);
