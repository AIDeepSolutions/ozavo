import { z } from "zod";
import { recordOrgEvent } from "./events";
import type { OrgQuery } from "./types";

/**
 * Motor de planos. O catálogo mora aqui, e a organização guarda em `plan_subscriptions` a cópia
 * dos valores em vigor: é o que deixa o plano Personalizado existir sem tabela à parte, e o que
 * faz uma mudança de preço do catálogo não alterar calada quem já contratou.
 *
 * Dinheiro em centavos de real.
 */
export const PLAN_IDS = ["starter", "pro", "growth", "scale", "custom"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export type CatalogPlanId = Exclude<PlanId, "custom">;

export const OVERAGE_RULES = ["pause_outbound", "bill_overage"] as const;
export type OverageRule = (typeof OVERAGE_RULES)[number];

export interface PlanDefinition {
  monthlyPriceCents: number;
  includedMinutes: number;
  /**
   * Chamadas simultâneas do plano. A especificação comercial só diz que o Scale tem "canais
   * simultâneos ampliados": os números são o padrão desta versão, à espera da decisão do dono
   * (docs/guides/planos-e-finops.md, "Decisões em aberto").
   */
  maxConcurrentCalls: number;
}

/** Preço e franquia da especificação comercial (seção 5, recebida em 2026-11-16). */
export const PLAN_CATALOG: Readonly<Record<CatalogPlanId, PlanDefinition>> = {
  starter: { monthlyPriceCents: 49_700, includedMinutes: 300, maxConcurrentCalls: 2 },
  pro: { monthlyPriceCents: 99_700, includedMinutes: 750, maxConcurrentCalls: 3 },
  growth: { monthlyPriceCents: 149_700, includedMinutes: 1_500, maxConcurrentCalls: 4 },
  scale: { monthlyPriceCents: 199_700, includedMinutes: 2_500, maxConcurrentCalls: 8 },
};

export interface PlanSubscription {
  plan: PlanId;
  monthlyPriceCents: number;
  includedMinutes: number;
  overageRule: OverageRule;
  overagePriceCentsPerMinute: number;
  maxConcurrentCalls: number;
  /** Dia em que o ciclo mensal começou a contar, `AAAA-MM-DD`. */
  cycleStartedOn: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * O que se pede para contratar ou trocar de plano. Num plano do catálogo, preço, franquia e
 * chamadas simultâneas vêm do catálogo e o que for mandado é ignorado; no Personalizado, os três
 * são obrigatórios.
 */
export const planSubscriptionInput = z
  .object({
    plan: z.enum(PLAN_IDS),
    overageRule: z.enum(OVERAGE_RULES),
    overagePriceCentsPerMinute: z.number().int().min(0).max(100_000),
    monthlyPriceCents: z.number().int().min(0).max(100_000_000).optional(),
    includedMinutes: z.number().int().min(0).max(10_000_000).optional(),
    maxConcurrentCalls: z.number().int().min(1).max(500).optional(),
    cycleStartedOn: z.string().regex(DAY, "use YYYY-MM-DD").optional(),
  })
  .superRefine((input, ctx) => {
    if (input.plan !== "custom") return;
    for (const key of ["monthlyPriceCents", "includedMinutes", "maxConcurrentCalls"] as const) {
      if (input[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: "required for the custom plan" });
    }
  });
export type PlanSubscriptionInput = z.output<typeof planSubscriptionInput>;

/** Os valores que valem para o pedido: os do catálogo, ou os informados no Personalizado. */
export function resolvePlan(input: PlanSubscriptionInput): PlanDefinition {
  if (input.plan !== "custom") return PLAN_CATALOG[input.plan];
  return {
    monthlyPriceCents: input.monthlyPriceCents ?? 0,
    includedMinutes: input.includedMinutes ?? 0,
    maxConcurrentCalls: input.maxConcurrentCalls ?? 1,
  };
}

const COLUMNS = `plan, monthly_price_cents as "monthlyPriceCents", included_minutes as "includedMinutes", overage_rule as "overageRule",
  overage_price_cents_per_minute as "overagePriceCentsPerMinute", max_concurrent_calls as "maxConcurrentCalls",
  to_char(cycle_started_on, 'YYYY-MM-DD') as "cycleStartedOn"`;

/** O plano da organização, ou `null` quando ela não tem plano (nada é limitado nem alertado). */
export function getPlanSubscription(q: OrgQuery): Promise<PlanSubscription | null> {
  return q.one<PlanSubscription>(`select ${COLUMNS} from plan_subscriptions where organization_id = $1`, [q.organizationId]);
}

/**
 * Contrata ou troca o plano da organização e registra `plan_changed`. É o único caminho que grava
 * em `plan_subscriptions`: a tela e o provisionamento por API chamam aqui.
 *
 * Sem `cycleStartedOn`, o ciclo continua de onde estava; na primeira contratação, começa em `today`.
 */
export async function setPlanSubscription(q: OrgQuery, input: PlanSubscriptionInput, at: Date, today: string, actorUserId: string | null = null): Promise<PlanSubscription> {
  if (q.organizationId === "") throw new Error("setPlanSubscription runs inside withOrg: the plan belongs to one organization");
  const values = resolvePlan(input);
  const previous = await getPlanSubscription(q);
  const cycleStartedOn = input.cycleStartedOn ?? previous?.cycleStartedOn ?? today;
  const saved = await q.one<PlanSubscription>(
    `insert into plan_subscriptions (organization_id, plan, monthly_price_cents, included_minutes, overage_rule, overage_price_cents_per_minute, max_concurrent_calls, cycle_started_on, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (organization_id) do update set plan = excluded.plan, monthly_price_cents = excluded.monthly_price_cents,
       included_minutes = excluded.included_minutes, overage_rule = excluded.overage_rule,
       overage_price_cents_per_minute = excluded.overage_price_cents_per_minute, max_concurrent_calls = excluded.max_concurrent_calls,
       cycle_started_on = excluded.cycle_started_on, updated_at = excluded.updated_at
     returning ${COLUMNS}`,
    [q.organizationId, input.plan, values.monthlyPriceCents, values.includedMinutes, input.overageRule, input.overagePriceCentsPerMinute, values.maxConcurrentCalls, cycleStartedOn, at],
  );
  if (!saved) throw new Error("Plan subscription was not saved");
  await recordOrgEvent(q, "plan_changed", { from: previous?.plan ?? null, to: saved.plan, includedMinutes: saved.includedMinutes, overageRule: saved.overageRule }, at, actorUserId);
  return saved;
}

const pad = (value: number): string => String(value).padStart(2, "0");
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** O dia `day` do mês `index` (meses contados desde o ano zero), encolhido para caber no mês. */
function dayOfMonth(index: number, day: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

/**
 * O ciclo mensal em que `today` cai, para um ciclo que começou em `cycleStartedOn`. As duas datas
 * são dias do calendário da organização (`AAAA-MM-DD`), então a conta não depende de fuso.
 * `end` é o primeiro dia do ciclo seguinte (fora do ciclo).
 *
 * Quem começou no dia 31 renova no último dia dos meses mais curtos. Antes do começo, o ciclo é o
 * primeiro.
 */
export function billingPeriod(cycleStartedOn: string, today: string): { start: string; end: string } {
  const [year = 0, month = 1, day = 1] = cycleStartedOn.split("-").map(Number);
  const [currentYear = 0, currentMonth = 1] = today.split("-").map(Number);
  const first = year * 12 + (month - 1);
  let index = Math.max(first, currentYear * 12 + (currentMonth - 1));
  // O dia de renovação deste mês ainda não chegou: o ciclo em curso é o que começou no mês anterior.
  if (index > first && dayOfMonth(index, day) > today) index -= 1;
  return { start: dayOfMonth(index, day), end: dayOfMonth(index + 1, day) };
}
