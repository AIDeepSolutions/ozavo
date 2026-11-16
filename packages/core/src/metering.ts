import { recordOrgEvent } from "./events";
import { notifyPanel } from "./notices";
import { billingPeriod, getPlanSubscription, type PlanSubscription } from "./plans";
import type { OrgQuery } from "./types";

/**
 * Medição da franquia em tempo real. O consumo é a duração das ligações atendidas no ciclo (do
 * atendimento ao fim; a que ainda está em curso conta até agora), e não o `seconds` do extrato:
 * esse é o uso que cada motor declara para cobrar, e há motor que cobra por token e declara zero.
 * A chamada simulada pelo painel não consome franquia.
 */

/** Os limiares de alerta, em % da franquia. O maior é a franquia inteira. */
export const USAGE_ALERT_THRESHOLDS = [80, 100] as const;
export type UsageAlertThreshold = (typeof USAGE_ALERT_THRESHOLDS)[number];

export const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** O fuso da organização: o da janela de ligações de saída, que é o único fuso que ela escolhe. */
const ZONE_SQL = `coalesce((select timezone from outbound_policy where organization_id = $1), '${DEFAULT_TIMEZONE}')`;

/** O dia de hoje no calendário da organização, `AAAA-MM-DD`. */
export async function localDay(q: OrgQuery, now: Date): Promise<{ day: string; zone: string }> {
  const row = await q.one<{ day: string; zone: string }>(
    `select to_char(($2::timestamptz at time zone z.zone)::date, 'YYYY-MM-DD') as day, z.zone from (select ${ZONE_SQL} as zone) z`,
    [q.organizationId, now],
  );
  if (!row) throw new Error("Could not read the organization calendar day");
  return row;
}

export interface PeriodUsage {
  subscription: PlanSubscription;
  /** O ciclo em curso; `end` é o primeiro dia do ciclo seguinte. */
  period: { start: string; end: string };
  consumedSeconds: number;
  includedSeconds: number;
  /** Segundos além da franquia. */
  overageSeconds: number;
  answeredCalls: number;
}

/** Os limiares que o consumo já alcançou. Franquia zero não tem limiar: não há do que avisar. */
export function reachedThresholds(consumedSeconds: number, includedSeconds: number): UsageAlertThreshold[] {
  if (includedSeconds <= 0) return [];
  return USAGE_ALERT_THRESHOLDS.filter((threshold) => consumedSeconds * 100 >= includedSeconds * threshold);
}

/** O consumo do ciclo em curso, ou `null` quando a organização não tem plano. */
export async function getPeriodUsage(q: OrgQuery, now: Date): Promise<PeriodUsage | null> {
  const subscription = await getPlanSubscription(q);
  if (!subscription) return null;
  const { day, zone } = await localDay(q, now);
  const period = billingPeriod(subscription.cycleStartedOn, day);
  const row = await q.one<{ seconds: number; calls: number }>(
    `select coalesce(sum(greatest(extract(epoch from (coalesce(ended_at, $2::timestamptz) - answered_at)), 0)), 0)::int as seconds,
            count(*)::int as calls
       from calls
      where organization_id = $1 and answered_at is not null and channel <> 'simulated'
        and (answered_at at time zone $3::text)::date >= $4::date and (answered_at at time zone $3::text)::date < $5::date`,
    [q.organizationId, now, zone, period.start, period.end],
  );
  const consumedSeconds = row?.seconds ?? 0;
  const includedSeconds = subscription.includedMinutes * 60;
  return { subscription, period, consumedSeconds, includedSeconds, overageSeconds: Math.max(0, consumedSeconds - includedSeconds), answeredCalls: row?.calls ?? 0 };
}

const minutesOf = (seconds: number): number => Math.ceil(seconds / 60);

function alertBody(threshold: UsageAlertThreshold, usage: PeriodUsage): string {
  const used = `${minutesOf(usage.consumedSeconds)} de ${usage.subscription.includedMinutes} minutos`;
  if (threshold < 100) return `A franquia do plano chegou a ${threshold}%: ${used} usados neste ciclo. O consumo está em FinOps.`;
  const after =
    usage.subscription.overageRule === "pause_outbound"
      ? "As ligações de saída ficam pausadas até o próximo ciclo; as recebidas continuam sendo atendidas."
      : "As ligações continuam, e os minutos além da franquia são tarifados como excedente.";
  return `A franquia do plano acabou: ${used} usados neste ciclo. ${after} A regra se ajusta em FinOps.`;
}

/**
 * Confere a franquia e avisa quando um limiar é cruzado pela primeira vez no ciclo: aviso no
 * painel e evento `plan_usage_alert`. Devolve os limiares avisados agora. A chave única de
 * `usage_alerts` garante um aviso só por limiar e por ciclo, mesmo com duas chamadas medindo juntas.
 */
export async function checkUsageAlerts(q: OrgQuery, now: Date): Promise<UsageAlertThreshold[]> {
  if (q.organizationId === "") throw new Error("checkUsageAlerts runs inside withOrg: the plan belongs to one organization");
  const usage = await getPeriodUsage(q, now);
  if (!usage) return [];
  const fired: UsageAlertThreshold[] = [];
  for (const threshold of reachedThresholds(usage.consumedSeconds, usage.includedSeconds)) {
    const inserted = await q.exec(
      `insert into usage_alerts (organization_id, period_start, threshold, consumed_seconds, included_seconds, at)
       values ($1, $2, $3, $4, $5, $6) on conflict (organization_id, period_start, threshold) do nothing`,
      [q.organizationId, usage.period.start, threshold, usage.consumedSeconds, usage.includedSeconds, now],
    );
    if (inserted !== 1) continue;
    fired.push(threshold);
    await notifyPanel(q, alertBody(threshold, usage), now);
    await recordOrgEvent(
      q,
      "plan_usage_alert",
      { threshold, periodStart: usage.period.start, consumedSeconds: usage.consumedSeconds, includedSeconds: usage.includedSeconds, overageRule: usage.subscription.overageRule },
      now,
    );
  }
  return fired;
}
