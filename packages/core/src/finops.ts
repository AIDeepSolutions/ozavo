import { DEFAULT_TIMEZONE, getPeriodUsage, localDay } from "./metering";
import { getOperationSettings, type OperationSettings } from "./operation-settings";
import type { PlanSubscription } from "./plans";
import { activeCadenceBreakers } from "./short-calls";
import type { OrgQuery } from "./types";

/**
 * FinOps: o que a operação custa contra o que o plano rende. O custo dos provedores (transcrição,
 * modelo e síntese) vem do extrato, que é medido em dólar; a telefonia é o custo por minuto que
 * quem opera informa. Sem cotação, nada é convertido: a margem fica sem número em vez de errada.
 */

/** Meta de custo variável por minuto falado, em centavos de real (especificação recebida em 2026-11-16). */
export const COST_TARGET_CENTS_PER_MINUTE = 28;

const MICROCENTS_PER_CENT = 1_000_000;

export interface MarginInput {
  monthlyPriceCents: number;
  overageRule: PlanSubscription["overageRule"];
  overagePriceCentsPerMinute: number;
  consumedSeconds: number;
  overageSeconds: number;
  /** Custo dos provedores no extrato, em micro-centavos de dólar. */
  providerCostUsdMicrocents: number;
  usdBrlRate: number | null;
  telephonyBrlPerMinute: number | null;
}

export interface Margin {
  /** Mensalidade mais excedente tarifado, em centavos de real. */
  revenueCents: number;
  overageRevenueCents: number;
  /** Custo dos provedores em centavos de real; `null` sem cotação. */
  providerCostCents: number | null;
  /** Custo de telefonia em centavos de real; `null` quando o custo por minuto não foi informado. */
  telephonyCostCents: number | null;
  /** Provedores mais telefonia; `null` enquanto faltar um dos dois. */
  variableCostCents: number | null;
  grossMarginCents: number | null;
  /** Margem bruta sobre a receita, de 0 a 100 (negativa quando o custo passa da receita). */
  grossMarginPercent: number | null;
  /** Custo variável por minuto falado, em centavos de real. */
  costPerMinuteCents: number | null;
  /** O custo por minuto está dentro da meta; `null` quando não há como dizer. */
  withinTarget: boolean | null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** A conta da margem, sem banco. Minuto de excedente tarifa por minuto começado. */
export function computeMargin(input: MarginInput): Margin {
  const overageRevenueCents = input.overageRule === "bill_overage" ? Math.ceil(input.overageSeconds / 60) * input.overagePriceCentsPerMinute : 0;
  const revenueCents = input.monthlyPriceCents + overageRevenueCents;
  const minutes = input.consumedSeconds / 60;
  const providerCostCents = input.usdBrlRate === null ? null : Math.round((input.providerCostUsdMicrocents / MICROCENTS_PER_CENT) * input.usdBrlRate);
  const telephonyCostCents = input.telephonyBrlPerMinute === null ? null : Math.round(minutes * input.telephonyBrlPerMinute * 100);
  const variableCostCents = providerCostCents === null || telephonyCostCents === null ? null : providerCostCents + telephonyCostCents;
  const grossMarginCents = variableCostCents === null ? null : revenueCents - variableCostCents;
  const costPerMinuteCents = variableCostCents === null || minutes <= 0 ? null : round2(variableCostCents / minutes);
  return {
    revenueCents,
    overageRevenueCents,
    providerCostCents,
    telephonyCostCents,
    variableCostCents,
    grossMarginCents,
    grossMarginPercent: grossMarginCents === null || revenueCents <= 0 ? null : round2((grossMarginCents / revenueCents) * 100),
    costPerMinuteCents,
    withinTarget: costPerMinuteCents === null ? null : costPerMinuteCents <= COST_TARGET_CENTS_PER_MINUTE,
  };
}

export interface FinopsSummary {
  /** `null` quando a organização não tem plano: o consumo é o do mês do calendário. */
  subscription: PlanSubscription | null;
  period: { start: string; end: string };
  consumedSeconds: number;
  includedSeconds: number | null;
  overageSeconds: number;
  answeredCalls: number;
  ttsCharacters: number;
  /** Custo dos provedores no extrato do período, em centavos de dólar. */
  providerCostUsdCents: number;
  margin: Margin;
  costTargetCentsPerMinute: number;
  settings: OperationSettings;
  alerts: Array<{ threshold: number; at: Date }>;
  cadenceBreakers: Array<{ lineE164: string; totalCalls: number; shortCalls: number; trippedAt: Date }>;
  byDay: Array<{ day: string; seconds: number; calls: number; ttsCharacters: number; providerCostUsdCents: number }>;
}

/** O resumo de FinOps do ciclo em curso da organização. */
export async function getFinopsSummary(q: OrgQuery, now: Date): Promise<FinopsSummary> {
  if (q.organizationId === "") throw new Error("getFinopsSummary runs inside withOrg: the summary is of one organization");
  const usage = await getPeriodUsage(q, now);
  const { day, zone } = await localDay(q, now);
  // Sem plano não há ciclo: vale o mês do calendário, só para o consumo aparecer.
  const period = usage?.period ?? { start: `${day.slice(0, 7)}-01`, end: nextMonth(day) };
  const range = [q.organizationId, zone || DEFAULT_TIMEZONE, period.start, period.end];

  const calls = await q.many<{ day: string; seconds: number; calls: number }>(
    `select to_char((answered_at at time zone $2::text)::date, 'YYYY-MM-DD') as day,
            coalesce(sum(greatest(extract(epoch from (coalesce(ended_at, $5::timestamptz) - answered_at)), 0)), 0)::int as seconds,
            count(*)::int as calls
       from calls
      where organization_id = $1 and answered_at is not null and channel <> 'simulated'
        and (answered_at at time zone $2::text)::date >= $3::date and (answered_at at time zone $2::text)::date < $4::date
      group by 1 order by 1`,
    [...range, now],
  );
  const ledger = await q.many<{ day: string; characters: number; microcents: string }>(
    `select to_char((at at time zone $2::text)::date, 'YYYY-MM-DD') as day, coalesce(sum(tts_characters), 0)::int as characters,
            coalesce(sum(cost_microcents), 0)::text as microcents
       from usage_ledger
      where organization_id = $1 and (at at time zone $2::text)::date >= $3::date and (at at time zone $2::text)::date < $4::date
      group by 1 order by 1`,
    range,
  );
  const alerts = await q.many<{ threshold: number; at: Date }>("select threshold, at from usage_alerts where organization_id = $1 and period_start = $2::date order by threshold", [
    q.organizationId,
    period.start,
  ]);

  const days = new Map<string, FinopsSummary["byDay"][number]>();
  const dayOf = (key: string): FinopsSummary["byDay"][number] => {
    const existing = days.get(key);
    if (existing) return existing;
    const created = { day: key, seconds: 0, calls: 0, ttsCharacters: 0, providerCostUsdCents: 0 };
    days.set(key, created);
    return created;
  };
  for (const row of calls) Object.assign(dayOf(row.day), { seconds: row.seconds, calls: row.calls });
  for (const row of ledger) Object.assign(dayOf(row.day), { ttsCharacters: row.characters, providerCostUsdCents: Math.round(Number(row.microcents) / MICROCENTS_PER_CENT) });

  const consumedSeconds = calls.reduce((sum, row) => sum + row.seconds, 0);
  const providerCostUsdMicrocents = ledger.reduce((sum, row) => sum + Number(row.microcents), 0);
  const settings = await getOperationSettings(q);
  const subscription = usage?.subscription ?? null;
  const includedSeconds = usage?.includedSeconds ?? null;
  const overageSeconds = includedSeconds === null ? 0 : Math.max(0, consumedSeconds - includedSeconds);
  return {
    subscription,
    period,
    consumedSeconds,
    includedSeconds,
    overageSeconds,
    answeredCalls: calls.reduce((sum, row) => sum + row.calls, 0),
    ttsCharacters: ledger.reduce((sum, row) => sum + row.characters, 0),
    providerCostUsdCents: Math.round(providerCostUsdMicrocents / MICROCENTS_PER_CENT),
    margin: computeMargin({
      monthlyPriceCents: subscription?.monthlyPriceCents ?? 0,
      overageRule: subscription?.overageRule ?? "pause_outbound",
      overagePriceCentsPerMinute: subscription?.overagePriceCentsPerMinute ?? 0,
      consumedSeconds,
      overageSeconds,
      providerCostUsdMicrocents,
      usdBrlRate: settings.usdBrlRate,
      telephonyBrlPerMinute: settings.telephonyBrlPerMinute,
    }),
    costTargetCentsPerMinute: COST_TARGET_CENTS_PER_MINUTE,
    settings,
    alerts,
    cadenceBreakers: await activeCadenceBreakers(q, now),
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

function nextMonth(day: string): string {
  const [year = 0, month = 1] = day.split("-").map(Number);
  const index = year * 12 + month;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}
