"use client";

import { ChartLineUp } from "@phosphor-icons/react";
import Link from "next/link";
import en from "../../../../i18n/en/platform-finops";
import es from "../../../../i18n/es/platform-finops";
import { fill } from "../../../../i18n/locales";
import ptBR from "../../../../i18n/pt-BR/platform-finops";
import { useDict, useLocale } from "../../../../i18n/provider";
import { useApi } from "../../../../ui/api";
import { formatBrl, formatDateTime, formatMoney, formatPhone } from "../../../../ui/format";
import { Badge, EmptyState, Notice, PageHeader, Panel, Skeleton } from "../../../../ui/kit";
import type { PlatformFinopsView } from "../../../../ui/platform-tenants";
import { LoadFailure, StatusBadge, UsageMeter, planText, useTenantsDict } from "../tenants/shared";

const RATES_TONE = { tenant: "neutral", platform: "neutral", missing: "warn" } as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid gap-0.5 rounded-md border border-line bg-surface p-4">
      <dt className="text-[0.8rem] font-bold text-muted">{label}</dt>
      <dd className="data text-[1.25rem] font-bold">{value}</dd>
      {hint ? <dd className="text-[0.8rem] text-muted">{hint}</dd> : null}
    </div>
  );
}

export default function PlatformFinopsPage() {
  const t = useDict(ptBR, en, es);
  const tenants = useTenantsDict();
  const locale = useLocale();
  const state = useApi<PlatformFinopsView>("/platform/finops");
  if (state.error && !state.data) return <LoadFailure error={state.error} />;
  const data = state.data;
  const brl = (cents: number | null): string => (cents === null ? t.unknown : formatBrl(cents, locale));
  const minutes = (seconds: number): string => Math.ceil(seconds / 60).toLocaleString(locale);
  const percent = (value: number | null): string => (value === null ? t.unknown : `${value.toLocaleString(locale)}%`);

  return (
    <>
      <PageHeader title={t.title} lead={t.lead} />
      {!data ? <Skeleton lines={5} /> : null}
      {data && data.tenants.length === 0 ? (
        <EmptyState icon={<ChartLineUp size={32} weight="duotone" aria-hidden />} title={t.empty} />
      ) : null}
      {data && data.tenants.length > 0 ? (
        <>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t.activeTenants} value={fill(t.ofTotal, { active: data.totals.activeTenants, total: data.totals.tenants })} />
            <Stat label={t.mrr} value={formatBrl(data.totals.mrrCents, locale)} />
            <Stat label={t.revenue} value={formatBrl(data.totals.revenueCents, locale)} hint={fill(t.overageHint, { value: formatBrl(data.totals.overageRevenueCents, locale) })} />
            <Stat label={t.variableCost} value={brl(data.totals.variableCostCents)} hint={fill(t.providerHint, { value: formatMoney(data.totals.providerCostUsdCents, locale) })} />
            <Stat label={t.margin} value={brl(data.totals.grossMarginCents)} hint={percent(data.totals.grossMarginPercent)} />
            <Stat label={t.minutes} value={minutes(data.totals.consumedSeconds)} />
            <Stat label={t.calls} value={data.totals.answeredCalls.toLocaleString(locale)} />
            <Stat label={t.ttsCharacters} value={data.totals.ttsCharacters.toLocaleString(locale)} />
          </dl>

          {data.totals.variableCostCents === null ? <Notice tone="warn">{t.missingRates}</Notice> : null}

          <Panel title={t.criticalTitle} description={t.criticalLead}>
            {data.critical.length === 0 ? <p className="text-muted">{t.noCritical}</p> : null}
            <ul className="grid gap-2">
              {data.critical.map((alert) => (
                <li key={`${alert.organizationId}-${alert.kind}-${alert.lineE164 ?? alert.threshold}`}>
                  <Notice tone={alert.kind === "usage" && alert.threshold !== null && alert.threshold < 100 ? "warn" : "fail"}>
                    <Link href={`/platform/tenants/${alert.organizationId}`} className="underline underline-offset-4">
                      {alert.kind === "usage"
                        ? fill(t.usageAlert, { name: alert.name, threshold: alert.threshold ?? 0, date: formatDateTime(alert.at, locale) })
                        : fill(t.breakerAlert, { name: alert.name, line: alert.lineE164 === "*" || alert.lineE164 === "" ? t.wholeOrganization : formatPhone(alert.lineE164), date: formatDateTime(alert.at, locale) })}
                    </Link>
                  </Notice>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title={t.tableTitle} description={t.roundingNote}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[0.92rem]">
                <caption className="sr-only">{t.tableTitle}</caption>
                <thead className="text-[0.8rem] font-bold text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-4">{t.columns.company}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.status}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.plan}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.usage}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.calls}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.tts}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.providerCost}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.variableCost}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.revenue}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.overage}</th>
                    <th scope="col" className="py-2 pr-4">{t.columns.margin}</th>
                    <th scope="col" className="py-2">{t.columns.rates}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.tenants.map((row) => (
                    <tr key={row.organizationId} className="align-top">
                      <th scope="row" className="py-3 pr-4 font-bold">
                        <Link href={`/platform/tenants/${row.organizationId}`} className="underline-offset-4 hover:underline">
                          {row.name}
                        </Link>
                      </th>
                      <td className="py-3 pr-4">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="py-3 pr-4">{planText(tenants, row.plan)}</td>
                      <td className="py-3 pr-4">
                        <UsageMeter usage={row.includedSeconds === null ? null : { consumedSeconds: row.consumedSeconds, includedSeconds: row.includedSeconds, period: row.period }} />
                        {row.includedSeconds === null ? <span className="data block text-[0.87rem]">{minutes(row.consumedSeconds)}</span> : null}
                      </td>
                      <td className="data py-3 pr-4">{row.answeredCalls.toLocaleString(locale)}</td>
                      <td className="data py-3 pr-4">{row.ttsCharacters.toLocaleString(locale)}</td>
                      <td className="data py-3 pr-4">{formatMoney(row.providerCostUsdCents, locale)}</td>
                      <td className="data py-3 pr-4">{brl(row.margin.variableCostCents)}</td>
                      <td className="data py-3 pr-4">{formatBrl(row.margin.revenueCents, locale)}</td>
                      <td className="data py-3 pr-4">{formatBrl(row.margin.overageRevenueCents, locale)}</td>
                      <td className="data py-3 pr-4">{percent(row.margin.grossMarginPercent)}</td>
                      <td className="py-3">
                        <Badge tone={RATES_TONE[row.ratesFrom]}>{t.rates[row.ratesFrom]}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}
    </>
  );
}
