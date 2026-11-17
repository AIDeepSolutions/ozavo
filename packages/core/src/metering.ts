import { recordOrgEvent } from "./events";
import { notifyPanel } from "./notices";
import { enqueueTask } from "./queue";
import { billingPeriod, getPlanSubscription, type PlanSubscription } from "./plans";
import { queuePlatformAlert } from "./platform-alerts";
import { queueWebhookEventOrReport } from "./webhooks";
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

/** Mandar também o aviso de franquia pelo WhatsApp ao dono (ou administrador) com número. Ausente vale desligado. */
export const PLAN_ALERT_WHATSAPP_SETTING = "plan.alert_whatsapp";
/** O nome de um webhook cadastrado que recebe o aviso de franquia (o n8n, por exemplo). Ausente: nenhum. */
export const PLAN_ALERT_WEBHOOK_SETTING = "plan.alert_webhook";

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
    const body = alertBody(threshold, usage);
    const facts = { threshold, periodStart: usage.period.start, consumedSeconds: usage.consumedSeconds, includedSeconds: usage.includedSeconds, overageRule: usage.subscription.overageRule };
    await notifyPanel(q, body, now);
    await deliverAlertOutside(q, body, facts, now);
    await recordOrgEvent(q, "plan_usage_alert", facts, now);
    await queueWebhookEventOrReport(q, "usage.alert", { ...facts, message: body }, now);
    await queuePlatformAlert(q, { kind: "usage", threshold, periodStart: usage.period.start, consumedSeconds: usage.consumedSeconds, includedSeconds: usage.includedSeconds }, now);
  }
  return fired;
}

/**
 * O aviso de franquia também fora do painel, como a organização escolheu em FinOps: pelo WhatsApp ao
 * dono ou administrador com número (com o conector configurado), e para um webhook cadastrado. Roda na
 * mesma transação que grava o limiar, então sai uma vez por limiar e ciclo, como o aviso do painel. O
 * texto não leva dado de quem ligou: só o consumo do plano.
 */
async function deliverAlertOutside(q: OrgQuery, body: string, facts: Record<string, unknown>, now: Date): Promise<void> {
  const stored = await q.many<{ key: string; value: unknown }>("select key, value from settings where key = any($1)", [[PLAN_ALERT_WHATSAPP_SETTING, PLAN_ALERT_WEBHOOK_SETTING, "whatsapp.connector"]]);
  const valueOf = (key: string): unknown => stored.find((row) => row.key === key)?.value;
  if (valueOf(PLAN_ALERT_WHATSAPP_SETTING) === true && valueOf("whatsapp.connector") !== undefined) {
    const owner = await q.one<{ whatsapp_e164: string }>(
      `select whatsapp_e164 from users where role in ('owner', 'admin') and whatsapp_e164 is not null
        order by case when role = 'owner' then 0 else 1 end, created_at limit 1`,
    );
    if (owner) {
      const row = await q.one<{ id: string }>(
        "insert into notifications (organization_id, call_id, channel, target, body, created_at) values ($1, null, 'whatsapp', $2, $3, $4) returning id",
        [q.organizationId, owner.whatsapp_e164, body, now],
      );
      if (!row) throw new Error("WhatsApp plan alert was not created");
      await enqueueTask(q, { kind: "deliver_notification", payload: { notificationId: row.id }, runAt: now });
    }
  }
  const webhook = valueOf(PLAN_ALERT_WEBHOOK_SETTING);
  if (typeof webhook === "string" && webhook.trim() !== "") {
    await enqueueTask(q, { kind: "deliver_webhook", payload: { name: webhook, payload: { event: "plan_usage_alert", ...facts, message: body } }, runAt: now });
  }
}
