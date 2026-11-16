"use client";
import en from "../../../i18n/en/finops-consolidated";
import es from "../../../i18n/es/finops-consolidated";
import ptBR from "../../../i18n/pt-BR/finops-consolidated";
import { useDict, useLocale } from "../../../i18n/provider";
import { useApi } from "../../../ui/api";
import { formatBrl, formatMoney } from "../../../ui/format";
import { Panel, Skeleton } from "../../../ui/kit";

interface Row {
  organizationId: string;
  name: string;
  plan: string | null;
  monthlyPriceCents: number | null;
  answeredCalls: number;
  seconds: number;
  providerCostUsdCents: number;
}
interface Consolidated {
  organizations: Row[];
  totals: { answeredCalls: number; seconds: number; providerCostUsdCents: number; monthlyPriceCents: number };
}

/** O FinOps de todas as empresas, só na tela da organização que administra a instalação. */
export function ConsolidatedPanel() {
  const t = useDict(ptBR, en, es);
  const locale = useLocale();
  const state = useApi<Consolidated>("/finops/consolidated");
  const minutes = (seconds: number): string => Math.ceil(seconds / 60).toLocaleString(locale);
  const data = state.data;
  return (
    <Panel title={t.title} description={t.lead}>
      {!data ? (
        <Skeleton lines={3} />
      ) : data.organizations.length === 0 ? (
        <p className="text-muted">{t.none}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[0.92rem]">
            <thead className="text-[0.8rem] font-bold text-muted">
              <tr>
                <th className="py-2 pr-4">{t.company}</th>
                <th className="py-2 pr-4">{t.plan}</th>
                <th className="py-2 pr-4">{t.calls}</th>
                <th className="py-2 pr-4">{t.minutes}</th>
                <th className="py-2 pr-4">{t.providerCost}</th>
                <th className="py-2">{t.monthlyFee}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.organizations.map((row) => (
                <tr key={row.organizationId}>
                  <td className="py-2 pr-4">{row.name}</td>
                  <td className="py-2 pr-4">{row.plan ?? t.noPlan}</td>
                  <td className="data py-2 pr-4">{row.answeredCalls.toLocaleString(locale)}</td>
                  <td className="data py-2 pr-4">{minutes(row.seconds)}</td>
                  <td className="data py-2 pr-4">{formatMoney(row.providerCostUsdCents, locale)}</td>
                  <td className="data py-2">{row.monthlyPriceCents === null ? "—" : formatBrl(row.monthlyPriceCents, locale)}</td>
                </tr>
              ))}
              <tr className="font-bold">
                <td className="py-2 pr-4" colSpan={2}>{t.total}</td>
                <td className="data py-2 pr-4">{data.totals.answeredCalls.toLocaleString(locale)}</td>
                <td className="data py-2 pr-4">{minutes(data.totals.seconds)}</td>
                <td className="data py-2 pr-4">{formatMoney(data.totals.providerCostUsdCents, locale)}</td>
                <td className="data py-2">{formatBrl(data.totals.monthlyPriceCents, locale)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
