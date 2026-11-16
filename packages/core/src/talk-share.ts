import { getPeriodUsage, localDay } from "./metering";
import type { OrgQuery } from "./types";

/** A meta da especificação: a IA fala menos da metade do tempo da ligação. */
export const AGENT_TALK_SHARE_TARGET = 0.5;

export interface AgentTalkShare {
  period: { start: string; end: string };
  /** Chamadas atendidas e encerradas no período que trazem a medida (as anteriores à medição não contam). */
  calls: number;
  callSeconds: number;
  agentSeconds: number;
  /** `agentSeconds / callSeconds`, ou `null` sem chamada medida. */
  share: number | null;
  /** Quantas chamadas passaram da meta. */
  callsOverTarget: number;
  target: number;
}

const nextMonth = (day: string): string => {
  const [year = 0, month = 1] = day.split("-").map(Number);
  const index = year * 12 + month;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
};

/**
 * Quanto do tempo das ligações foi fala da IA, no mesmo período do FinOps (o ciclo do plano, ou o
 * mês do calendário sem plano). A fala é o áudio que o agente mandou para a linha, gravado em
 * `call_ended.agentSpeechSeconds`; o tempo da ligação vai do atendimento ao fim. O áudio cortado
 * por quem ligou (barge-in) já foi enviado e conta: a medida é um teto, não uma estimativa baixa.
 */
export async function getAgentTalkShare(q: OrgQuery, now: Date): Promise<AgentTalkShare> {
  if (q.organizationId === "") throw new Error("getAgentTalkShare runs inside withOrg: the share is of one organization");
  const usage = await getPeriodUsage(q, now);
  const { day, zone } = await localDay(q, now);
  const period = usage?.period ?? { start: `${day.slice(0, 7)}-01`, end: nextMonth(day) };
  const row = await q.one<{ calls: number; call_seconds: number; agent_seconds: number; over: number }>(
    `select count(*)::int as calls, coalesce(sum(m.call_seconds), 0)::int as call_seconds, coalesce(sum(m.agent_seconds), 0)::int as agent_seconds,
            count(*) filter (where m.agent_seconds > m.call_seconds * $5)::int as over
       from (select greatest(extract(epoch from (c.ended_at - c.answered_at)), 0) as call_seconds,
                    (e.payload->>'agentSpeechSeconds')::numeric as agent_seconds
               from calls c
               join call_events e on e.call_id = c.id and e.organization_id = c.organization_id and e.kind = 'call_ended'
              where c.organization_id = $1 and c.answered_at is not null and c.ended_at is not null and c.channel <> 'simulated'
                and e.payload ? 'agentSpeechSeconds'
                and (c.answered_at at time zone $2::text)::date >= $3::date and (c.answered_at at time zone $2::text)::date < $4::date) m`,
    [q.organizationId, zone, period.start, period.end, AGENT_TALK_SHARE_TARGET],
  );
  const callSeconds = row?.call_seconds ?? 0;
  const agentSeconds = row?.agent_seconds ?? 0;
  return {
    period,
    calls: row?.calls ?? 0,
    callSeconds,
    agentSeconds,
    share: callSeconds > 0 ? agentSeconds / callSeconds : null,
    callsOverTarget: row?.over ?? 0,
    target: AGENT_TALK_SHARE_TARGET,
  };
}
