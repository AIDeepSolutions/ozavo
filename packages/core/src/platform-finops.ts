import { computeMargin, getFinopsSummary, type Margin } from "./finops";
import { DEFAULT_TIMEZONE } from "./metering";
import { getOperationSettings } from "./operation-settings";
import { assertPlatform, displayStatus, type PlatformTenantStatus } from "./platform-tenants";
import type { TenantStatus } from "./tenants";
import type { Db } from "./types";
import { withSystem } from "./with-org";

/**
 * O painel administrativo de FinOps da especificação: por empresa e consolidado, os minutos do
 * ciclo contra a franquia, o custo variável estimado (provedores e telefonia) contra a receita, a
 * margem bruta e os alertas críticos (franquia em 80% e 100%, disjuntor de chamadas curtas).
 *
 * Reaproveita o resumo de FinOps de cada empresa (`getFinopsSummary`), lido pelo papel de sistema
 * com a organização da empresa: cada consulta do resumo filtra por ela. A cotação do dólar e o
 * custo de telefonia são os da empresa quando ela informou os dela, e senão os da plataforma, que
 * é quem paga os provedores numa instalação que vende o serviço.
 */

const MICROCENTS_PER_CENT = 1_000_000;
/** Mais que o mês mais longo: quem não teve nada nesse prazo não tem o que medir no mês corrente. */
const QUIET_DAYS = 62;

export interface PlatformFinopsTenant {
  organizationId: string;
  name: string;
  status: PlatformTenantStatus;
  plan: string | null;
  period: { start: string; end: string };
  consumedSeconds: number;
  includedSeconds: number | null;
  /** Segundos além da franquia no ciclo. */
  overageSeconds: number;
  answeredCalls: number;
  ttsCharacters: number;
  providerCostUsdCents: number;
  monthlyPriceCents: number;
  margin: Margin;
  /** De onde vieram a cotação e o custo de telefonia usados na margem. */
  ratesFrom: "tenant" | "platform" | "missing";
  alerts: Array<{ threshold: number; at: Date }>;
  cadenceBreakers: Array<{ lineE164: string; totalCalls: number; shortCalls: number; trippedAt: Date }>;
}

export interface PlatformCriticalAlert {
  organizationId: string;
  name: string;
  kind: "usage" | "breaker";
  /** `usage`: 80 ou 100. */
  threshold: number | null;
  /** `breaker`: a linha, ou `*` para a empresa inteira. */
  lineE164: string | null;
  at: Date;
}

export interface PlatformFinops {
  tenants: PlatformFinopsTenant[];
  totals: {
    tenants: number;
    activeTenants: number;
    /** Soma das mensalidades das empresas ativas, em centavos de real. */
    mrrCents: number;
    revenueCents: number;
    /** A parte da receita que vem do excedente tarifado. */
    overageRevenueCents: number;
    overageSeconds: number;
    consumedSeconds: number;
    answeredCalls: number;
    ttsCharacters: number;
    providerCostUsdCents: number;
    /** `null` enquanto alguma empresa com consumo não tiver como estimar o custo. */
    variableCostCents: number | null;
    grossMarginCents: number | null;
    grossMarginPercent: number | null;
  };
  /** Os alertas que pedem a plataforma agora: franquia de 100% primeiro, depois disjuntor, depois 80%. */
  critical: PlatformCriticalAlert[];
}

const ALERT_ORDER = (alert: PlatformCriticalAlert): number => (alert.kind === "usage" && alert.threshold === 100 ? 0 : alert.kind === "breaker" ? 1 : 2);

export function getPlatformFinops(db: Db, platformId: string, now: Date): Promise<PlatformFinops> {
  return withSystem(db, async (q) => {
    await assertPlatform(q, platformId);
    const platformRates = await getOperationSettings({ ...q, organizationId: platformId });
    // "Parada" é a empresa sem plano e sem nada a medir: nenhuma ligação atendida, nenhum lançamento
    // no extrato e nenhum disjuntor desde QUIET_DAYS atrás, o que cobre o mês do calendário inteiro.
    // Ela entra com consumo zero, sem as consultas do resumo; as outras passam pelo resumo completo.
    const rows = await q.many<{ id: string; name: string; status: TenantStatus | null; cancelled: boolean; quiet: boolean; monthStart: string; monthEnd: string }>(
      `select o.id, o.name, p.status, exists(select from asaas_subscriptions s where s.tenant_id = o.id and s.cancelled) as cancelled,
              not exists(select from plan_subscriptions s where s.organization_id = o.id)
                and not exists(select from calls c where c.organization_id = o.id and c.answered_at >= $1::timestamptz - make_interval(days => $2))
                and not exists(select from usage_ledger l where l.organization_id = o.id and l.at >= $1::timestamptz - make_interval(days => $2))
                and not exists(select from cadence_breakers b where b.organization_id = o.id and b.tripped_at >= $1::timestamptz - make_interval(days => $2)) as quiet,
              to_char(date_trunc('month', ($1::timestamptz at time zone z.zone)), 'YYYY-MM-DD') as "monthStart",
              to_char(date_trunc('month', ($1::timestamptz at time zone z.zone)) + interval '1 month', 'YYYY-MM-DD') as "monthEnd"
         from organizations o
         left join tenant_profiles p on p.organization_id = o.id
         cross join lateral (select coalesce((select timezone from outbound_policy op where op.organization_id = o.id), '${DEFAULT_TIMEZONE}') as zone) z
        where not o.platform order by o.name, o.id`,
      [now, QUIET_DAYS],
    );
    const ratesKnown = platformRates.usdBrlRate !== null && platformRates.telephonyBrlPerMinute !== null;
    const tenants: PlatformFinopsTenant[] = [];
    for (const row of rows) {
      if (row.quiet) {
        tenants.push({
          organizationId: row.id,
          name: row.name,
          status: displayStatus(row.status, row.cancelled),
          plan: null,
          period: { start: row.monthStart, end: row.monthEnd },
          consumedSeconds: 0,
          includedSeconds: null,
          overageSeconds: 0,
          answeredCalls: 0,
          ttsCharacters: 0,
          providerCostUsdCents: 0,
          monthlyPriceCents: 0,
          margin: computeMargin({ monthlyPriceCents: 0, overageRule: "pause_outbound", overagePriceCentsPerMinute: 0, consumedSeconds: 0, overageSeconds: 0, providerCostUsdMicrocents: 0, usdBrlRate: 0, telephonyBrlPerMinute: 0 }),
          // Sem consumo, a cotação não muda nada: vale a da plataforma, quando há.
          ratesFrom: ratesKnown ? "platform" : "missing",
          alerts: [],
          cadenceBreakers: [],
        });
        continue;
      }
      const summary = await getFinopsSummary({ ...q, organizationId: row.id }, now);
      const own = summary.settings.usdBrlRate !== null && summary.settings.telephonyBrlPerMinute !== null;
      const usdBrlRate = summary.settings.usdBrlRate ?? platformRates.usdBrlRate;
      const telephonyBrlPerMinute = summary.settings.telephonyBrlPerMinute ?? platformRates.telephonyBrlPerMinute;
      const margin = own
        ? summary.margin
        : computeMargin({
            monthlyPriceCents: summary.subscription?.monthlyPriceCents ?? 0,
            overageRule: summary.subscription?.overageRule ?? "pause_outbound",
            overagePriceCentsPerMinute: summary.subscription?.overagePriceCentsPerMinute ?? 0,
            consumedSeconds: summary.consumedSeconds,
            overageSeconds: summary.overageSeconds,
            // O resumo traz o custo em centavos inteiros: a diferença para o extrato fica abaixo de um centavo de dólar.
            providerCostUsdMicrocents: summary.providerCostUsdCents * MICROCENTS_PER_CENT,
            usdBrlRate,
            telephonyBrlPerMinute,
          });
      tenants.push({
        organizationId: row.id,
        name: row.name,
        status: displayStatus(row.status, row.cancelled),
        plan: summary.subscription?.plan ?? null,
        period: summary.period,
        consumedSeconds: summary.consumedSeconds,
        includedSeconds: summary.includedSeconds,
        overageSeconds: summary.overageSeconds,
        answeredCalls: summary.answeredCalls,
        ttsCharacters: summary.ttsCharacters,
        providerCostUsdCents: summary.providerCostUsdCents,
        monthlyPriceCents: summary.subscription?.monthlyPriceCents ?? 0,
        margin,
        ratesFrom: own ? "tenant" : usdBrlRate !== null && telephonyBrlPerMinute !== null ? "platform" : "missing",
        alerts: summary.alerts,
        cadenceBreakers: summary.cadenceBreakers,
      });
    }
    return { tenants, totals: totalsOf(tenants), critical: criticalOf(tenants) };
  });
}

export function totalsOf(tenants: PlatformFinopsTenant[]): PlatformFinops["totals"] {
  const sum = (pick: (tenant: PlatformFinopsTenant) => number): number => tenants.reduce((total, tenant) => total + pick(tenant), 0);
  const revenueCents = sum((tenant) => tenant.margin.revenueCents);
  // Empresa sem consumo não tem custo a estimar: só falta o custo de quem consumiu sem cotação.
  const unknown = tenants.some((tenant) => tenant.margin.variableCostCents === null && (tenant.consumedSeconds > 0 || tenant.providerCostUsdCents > 0));
  const variableCostCents = unknown ? null : sum((tenant) => tenant.margin.variableCostCents ?? 0);
  const grossMarginCents = variableCostCents === null ? null : revenueCents - variableCostCents;
  return {
    tenants: tenants.length,
    activeTenants: tenants.filter((tenant) => tenant.status === "active").length,
    mrrCents: sum((tenant) => (tenant.status === "active" ? tenant.monthlyPriceCents : 0)),
    revenueCents,
    overageRevenueCents: sum((tenant) => tenant.margin.overageRevenueCents),
    overageSeconds: sum((tenant) => tenant.overageSeconds),
    consumedSeconds: sum((tenant) => tenant.consumedSeconds),
    answeredCalls: sum((tenant) => tenant.answeredCalls),
    ttsCharacters: sum((tenant) => tenant.ttsCharacters),
    providerCostUsdCents: sum((tenant) => tenant.providerCostUsdCents),
    variableCostCents,
    grossMarginCents,
    grossMarginPercent: grossMarginCents === null || revenueCents <= 0 ? null : Math.round((grossMarginCents / revenueCents) * 10_000) / 100,
  };
}

export function criticalOf(tenants: PlatformFinopsTenant[]): PlatformCriticalAlert[] {
  const alerts: PlatformCriticalAlert[] = [];
  for (const tenant of tenants) {
    // Do mesmo ciclo, só o maior limiar alcançado interessa: 100% já diz que passou de 80%.
    const top = tenant.alerts.reduce<{ threshold: number; at: Date } | null>((best, alert) => (best === null || alert.threshold > best.threshold ? alert : best), null);
    if (top) alerts.push({ organizationId: tenant.organizationId, name: tenant.name, kind: "usage", threshold: top.threshold, lineE164: null, at: top.at });
    for (const breaker of tenant.cadenceBreakers) {
      alerts.push({ organizationId: tenant.organizationId, name: tenant.name, kind: "breaker", threshold: null, lineE164: breaker.lineE164, at: breaker.trippedAt });
    }
  }
  return alerts.sort((a, b) => ALERT_ORDER(a) - ALERT_ORDER(b) || b.at.getTime() - a.at.getTime());
}
