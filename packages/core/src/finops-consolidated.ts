import type { Db } from "./types";
import { withSystem } from "./with-org";

const MICROCENTS_PER_CENT = 1_000_000;

export interface ConsolidatedOrganization {
  organizationId: string;
  name: string;
  platform: boolean;
  /** Plano contratado, ou `null` sem plano. */
  plan: string | null;
  monthlyPriceCents: number | null;
  includedMinutes: number | null;
  answeredCalls: number;
  seconds: number;
  /** Custo dos provedores no extrato do mês, em centavos de dólar. */
  providerCostUsdCents: number;
}

export interface ConsolidatedFinops {
  /** Mês do calendário em UTC: cada empresa tem o seu ciclo, e o consolidado precisa de um corte só. */
  period: { start: string; end: string };
  organizations: ConsolidatedOrganization[];
  totals: { organizations: number; answeredCalls: number; seconds: number; providerCostUsdCents: number; monthlyPriceCents: number };
}

/**
 * O FinOps de todas as empresas da instalação, para quem a administra. Atravessa organizações:
 * quem chama confere antes que a sessão é da organização da plataforma (`organizations.platform`).
 * Lê só números de consumo e plano; nenhum dado de ligação, contato ou transcrição sai daqui.
 */
export async function getConsolidatedFinops(db: Db, now: Date): Promise<ConsolidatedFinops> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rows = await withSystem(db, (q) =>
    q.many<{ id: string; name: string; platform: boolean; plan: string | null; price: number | null; minutes: number | null; calls: number; seconds: number; microcents: string }>(
      `select o.id, o.name, o.platform, p.plan, p.monthly_price_cents as price, p.included_minutes as minutes,
              coalesce(c.calls, 0)::int as calls, coalesce(c.seconds, 0)::int as seconds, coalesce(l.microcents, 0)::text as microcents
         from organizations o
         left join plan_subscriptions p on p.organization_id = o.id
         left join (select organization_id, count(*) as calls,
                           sum(greatest(extract(epoch from (coalesce(ended_at, $3::timestamptz) - answered_at)), 0)) as seconds
                      from calls
                     where answered_at >= $1 and answered_at < $2 and channel <> 'simulated'
                     group by organization_id) c on c.organization_id = o.id
         left join (select organization_id, sum(cost_microcents) as microcents
                      from usage_ledger where at >= $1 and at < $2 group by organization_id) l on l.organization_id = o.id
        order by o.platform desc, o.name, o.id`,
      [start, end, now],
    ),
  );
  const organizations = rows.map((row) => ({
    organizationId: row.id,
    name: row.name,
    platform: row.platform,
    plan: row.plan,
    monthlyPriceCents: row.price,
    includedMinutes: row.minutes,
    answeredCalls: row.calls,
    seconds: row.seconds,
    providerCostUsdCents: Math.round(Number(row.microcents) / MICROCENTS_PER_CENT),
  }));
  const sum = (pick: (row: ConsolidatedOrganization) => number): number => organizations.reduce((total, row) => total + pick(row), 0);
  return {
    period: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) },
    organizations,
    totals: {
      organizations: organizations.length,
      answeredCalls: sum((row) => row.answeredCalls),
      seconds: sum((row) => row.seconds),
      providerCostUsdCents: sum((row) => row.providerCostUsdCents),
      monthlyPriceCents: sum((row) => row.monthlyPriceCents ?? 0),
    },
  };
}
