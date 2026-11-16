import { checkUsageAlerts, getPeriodUsage } from "./metering";
import type { Db } from "./types";
import { getOperationSettings } from "./operation-settings";
import { takeProviderSlots } from "./provider-slots";
import { SHORT_CALL_WATCH_INTERVAL_MS, activeCadenceBreakers, scheduleShortCallWatch } from "./short-calls";
import type { OrgQuery } from "./types";

/**
 * O que segura uma ligação de saída além da política de saída: a franquia do plano, o número de
 * chamadas ao mesmo tempo e a cadência reduzida. Ligação recebida não passa por aqui: quem ligou
 * nunca fica sem atendimento por causa de plano.
 */
export type PacingRefusalCode = "plan_quota_exhausted" | "concurrency_limit" | "cadence_reduced";
export type PacingDecision = { allowed: true } | { allowed: false; code: PacingRefusalCode; message: string };

const refuse = (code: PacingRefusalCode, message: string): PacingDecision => ({ allowed: false, code, message });
const HOUR_MS = 60 * 60 * 1000;

/**
 * O semáforo, sem banco: a ligação nova cabe se as que estão em curso ficam abaixo de cada teto.
 * `tenantActive` são as chamadas da organização; `globalActive`, as de todas as organizações da
 * instalação (elas dividem a mesma conta do provedor de síntese, `provider-slots.ts`). Teto nulo não limita.
 */
export function concurrencyAllows(input: { tenantActive: number; globalActive: number; tenantLimit: number | null; providerLimit: number | null }): "ok" | "tenant" | "provider" {
  if (input.tenantLimit !== null && input.tenantActive >= input.tenantLimit) return "tenant";
  if (input.providerLimit !== null && Math.max(input.tenantActive, input.globalActive) >= input.providerLimit) return "provider";
  return "ok";
}

/**
 * Confere franquia, concorrência e cadência para uma ligação de saída. Chame depois de
 * `checkOutboundAllowed`, na MESMA transação que cria a linha em `calls`: a política de saída já
 * trancou a linha da organização, então duas ligações conferem e gravam uma de cada vez.
 *
 * `db` (com o papel de sistema) conta as vagas do provedor de síntese na instalação inteira, sob a
 * trava global de `takeProviderSlots`. `lineE164` é o número de origem da linha por onde a ligação vai sair.
 */
export async function checkPacingAllowed(q: OrgQuery, now: Date, input: { db: Db; lineE164?: string | null }): Promise<PacingDecision> {
  if (q.organizationId === "") throw new Error("checkPacingAllowed runs inside withOrg: the limits belong to one organization");
  const usage = await getPeriodUsage(q, now);
  if (usage) {
    // O aviso sai mesmo quando ninguém está em chamada para medir: a tentativa de ligar também confere.
    // Franquia zero com pausa é saída pausada desde o começo, não ilimitada: ilimitado é tarifar.
    await checkUsageAlerts(q, now);
    if (usage.subscription.overageRule === "pause_outbound" && usage.consumedSeconds >= usage.includedSeconds) {
      return refuse("plan_quota_exhausted", `The plan allowance of ${usage.subscription.includedMinutes} minutes is used up for this cycle, and outbound calls are paused until ${usage.period.end}.`);
    }
  }

  const settings = await getOperationSettings(q);
  const active = await q.one<{ count: number }>(
    "select count(*)::int as count from calls where organization_id = $1 and status in ('ringing', 'in_progress') and channel <> 'simulated'",
    [q.organizationId],
  );
  const tenantActive = active?.count ?? 0;
  const slots = await takeProviderSlots(q, input.db, now);
  const verdict = concurrencyAllows({
    tenantActive,
    globalActive: slots.active,
    tenantLimit: usage?.subscription.maxConcurrentCalls ?? null,
    providerLimit: slots.limit,
  });
  if (verdict === "tenant") return refuse("concurrency_limit", `There are already ${tenantActive} calls in progress; the plan allows ${usage?.subscription.maxConcurrentCalls} at the same time.`);
  if (verdict === "provider") {
    return refuse("concurrency_limit", `The speech provider account accepts ${slots.limit} calls at the same time, and all of them are in use.`);
  }

  const line = input.lineE164 ?? "";
  const breakers = await activeCadenceBreakers(q, now);
  if (breakers.some((breaker) => breaker.lineE164 === line)) {
    const recent = await q.one<{ count: number }>(
      `select count(*)::int as count from calls
        where organization_id = $1 and direction = 'outbound' and channel = 'phone' and status <> 'refused'
          and coalesce(from_e164, '') = $2 and started_at > $3`,
      [q.organizationId, line, new Date(now.getTime() - HOUR_MS)],
    );
    if ((recent?.count ?? 0) >= settings.reducedCallsPerHour) {
      return refuse("cadence_reduced", `Too many short calls today: this line is limited to ${settings.reducedCallsPerHour} outbound calls per hour until the end of the day.`);
    }
  }

  // A ligação vai sair: a rotina que confere as chamadas curtas precisa estar de pé.
  await scheduleShortCallWatch(q, new Date(now.getTime() + SHORT_CALL_WATCH_INTERVAL_MS));
  return { allowed: true };
}
