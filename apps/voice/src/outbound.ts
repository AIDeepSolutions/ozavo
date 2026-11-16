import { recordEvent, toE164, withOrg, type Clock, type Db } from "@ozavo/core";
import { dialString, type AriClient } from "./ari";
import type { AsteriskCalls } from "./asterisk-transport";
import { messageOf, type Logger } from "./log";
import { checkOutboundAllowed } from "./outbound-policy";

export interface OutboundDeps {
  db: Db;
  ari: AriClient;
  clock: Clock;
  calls: AsteriskCalls;
  log: Logger;
}

export type OutboundResult = { callId: string; repeated?: boolean } | { code: string; message: string };

/** O que vem a mais quando quem pede é um sistema de fora (chave de API). */
export interface OutboundRequest {
  /** A chave que pediu, gravada na chamada. */
  apiKeyId?: string;
  /** Dados do lead e do motivo, entregues ao agente como contexto (nunca como instrução). */
  context?: Record<string, unknown>;
  /** Chave de repetição: o mesmo pedido reenviado devolve a mesma chamada e não liga de novo. */
  requestKey?: string;
}

/**
 * Origina uma ligação do agente para `toE164`. Só depois de `checkOutboundAllowed`: não existe
 * outro caminho que origine chamada. A recusa da política também fica gravada, como chamada
 * `refused` com o evento `call_refused`, para quem audita ver o que foi tentado.
 */
export async function startOutboundCall(deps: OutboundDeps, input: { organizationId: string; agentId: string; toE164: string } & OutboundRequest): Promise<OutboundResult> {
  const { db, ari, clock, log } = deps;
  const to = toE164(input.toE164);
  if (!to) return { code: "invalid_number", message: "The destination is not a valid phone number." };

  type Line = { id: string; caller_id_e164: string | null };
  const prepare = (): Promise<{ callId: string; trunk: Line } | OutboundResult> => withOrg(db, input.organizationId, async (q): Promise<{ callId: string; trunk: Line } | OutboundResult> => {
    if (input.requestKey !== undefined) {
      const earlier = await q.one<{ id: string; status: string; end_reason: string | null }>("select id, status, end_reason from calls where request_key = $1", [input.requestKey]);
      // O pedido repetido devolve o que o primeiro deu: a mesma chamada, ou a mesma recusa.
      if (earlier) return earlier.status === "refused" ? { code: earlier.end_reason ?? "refused", message: "This request was already refused." } : { callId: earlier.id, repeated: true };
    }
    const agent = await q.one<{ enabled: boolean }>("select enabled from agents where id = $1", [input.agentId]);
    if (!agent) return { code: "agent_not_found", message: "This agent does not exist in this organization." };
    if (!agent.enabled) return { code: "agent_disabled", message: "This agent is turned off." };
    // A linha de saída é a do número do agente; sem número, a única linha da organização.
    const trunks = await q.many<Line>(
      `select t.id, t.caller_id_e164 from trunks t
        where exists (select 1 from phone_numbers p where p.trunk_id = t.id and p.agent_id = $1)
           or not exists (select 1 from phone_numbers p where p.agent_id = $1)
        order by t.id limit 2`,
      [input.agentId],
    );
    const trunk = trunks.length === 1 ? trunks[0] : undefined;
    if (!trunk) return { code: "no_line", message: "There is no single phone line for this agent to call from. Give the agent a number in the phone line settings." };

    const decision = await checkOutboundAllowed(q, to, clock, trunk.caller_id_e164);
    const call = await q.one<{ id: string }>(
      `insert into calls (organization_id, agent_id, direction, channel, from_e164, to_e164, status, end_reason, started_at, ended_at, requested_by_key_id, request_context, request_key)
       values ($1, $2, 'outbound', 'phone', $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        input.organizationId,
        input.agentId,
        trunk.caller_id_e164,
        to,
        decision.allowed ? "ringing" : "refused",
        decision.allowed ? null : decision.code,
        clock.now(),
        decision.allowed ? null : clock.now(),
        input.apiKeyId ?? null,
        input.context === undefined ? null : JSON.stringify(input.context),
        input.requestKey ?? null,
      ],
    );
    if (!call) throw new Error("Outbound call was not created");
    if (!decision.allowed) {
      await recordEvent(q, call.id, "call_refused", { reason: decision.code, message: decision.message, to }, clock.now());
      return { code: decision.code, message: decision.message };
    }
    return { callId: call.id, trunk };
  });
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare();
  } catch (error) {
    // Dois pedidos com a mesma chave ao mesmo tempo: o índice único deixa um gravar, e o outro,
    // repetido, já encontra a chamada do primeiro e devolve a mesma.
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (input.requestKey === undefined || code !== "23505") throw error;
    prepared = await prepare();
  }
  if (!("trunk" in prepared)) return prepared;

  const { callId, trunk } = prepared;
  // O id do canal é o da chamada, escolhido antes de originar: quando o AudioSocket conectar, a
  // chamada já é esperada.
  deps.calls.expect({ callId, channelId: callId, organizationId: input.organizationId, agentId: input.agentId, trunkId: trunk.id });
  try {
    await ari.originate({
      endpoint: dialString(to, trunk.id),
      context: "ozavo-audio",
      extension: "s",
      channelId: callId,
      callerId: trunk.caller_id_e164 ?? undefined,
      variables: { AUDIOSOCKET_UUID: callId },
    });
  } catch (error) {
    log("error", "could not originate the outbound call", { callId, error: messageOf(error) });
    // Fecha a chamada como falha (o canal não chegou a existir).
    await deps.calls.channelDestroyed(callId, messageOf(error));
    return { code: "originate_failed", message: `The telephony server could not place the call: ${messageOf(error)}` };
  }
  return { callId };
}
