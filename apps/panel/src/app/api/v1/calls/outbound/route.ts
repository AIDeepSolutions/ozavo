import { z } from "zod";
import { handle } from "../../../../../server/context";
import { bearerOf, handleApiKey } from "../../../../../server/api-auth";
import { outboundApiBody, requestOutboundCall } from "../../../../../server/outbound-api";
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

/**
 * Disparo reativo (Speed-to-Lead) por um sistema de fora, com chave de API `calls:outbound`. Não
 * passa pela fila de rotinas (uma tarefa por vez, que pode estar ocupada com um resumo): vai direto
 * ao processo de voz, que confere a política de saída e origina na hora. O prazo do pedido ao
 * processo de voz é 5 s; sem resposta nesse tempo, a resposta é `voice_unavailable`.
 */
const fromApi = handleApiKey({ scope: "calls:outbound", body: outboundApiBody }, async (args) => requestOutboundCall(args));

export const POST = (request: Request, context: { params: Promise<Record<string, string> | undefined> }): Promise<Response> =>
  bearerOf(request) === undefined ? fromPanel(request, context) : fromApi(request);
