"use client";

import en from "../../../i18n/en/knowledge";
import es from "../../../i18n/es/knowledge";
import { fill } from "../../../i18n/locales";
import ptBR from "../../../i18n/pt-BR/knowledge";
import { useDict, useLocale } from "../../../i18n/provider";
import { formatCompactCount, formatCount, formatUsd, MICROCENTS_PER_USD, type KnowledgeUsageView } from "../../../ui/knowledge";
import { Panel, Skeleton } from "../../../ui/kit";

/** Uma barra de uso com texto ao lado: o número é a informação, a barra só ajuda a ver a proporção. */
function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const percent = max === 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-bold">{label}</span>
        <span className="data text-muted">{text}</span>
      </div>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} aria-valuetext={text} className="h-2 overflow-hidden rounded-full bg-sunken">
        <div className={`h-full rounded-full ${percent >= 90 ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.max(percent, value > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

/** Os tetos da base, o uso da empresa contra eles e o que a base custou no mês. */
export function LimitsPanel({ usage }: { usage: KnowledgeUsageView | undefined }) {
  const t = useDict(ptBR, en, es).limits;
  const locale = useLocale();
  if (!usage) {
    return (
      <Panel title={t.title} description={t.lead}>
        <Skeleton lines={2} />
      </Panel>
    );
  }
  const { limits } = usage;
  const price = formatUsd(usage.embeddingUsdPerMillionTokens * MICROCENTS_PER_USD, locale);
  return (
    <Panel title={t.title} description={t.lead}>
      <div className="grid gap-5">
        <div className="grid gap-x-10 gap-y-4 md:grid-cols-2">
          <Meter label={t.tokens} value={usage.tokens} max={limits.maxOrganizationTokens} text={fill(t.tokensOf, { used: formatCount(usage.tokens, locale), limit: formatCount(limits.maxOrganizationTokens, locale) })} />
          <Meter label={t.sources} value={usage.sources} max={limits.maxSources} text={fill(t.sourcesOf, { used: formatCount(usage.sources, locale), limit: formatCount(limits.maxSources, locale) })} />
        </div>
        <ul className="grid gap-1 text-muted">
          <li>
            {fill(t.ceilings, {
              file: limits.maxFileBytes / (1024 * 1024),
              source: formatCompactCount(limits.maxSourceTokens, locale),
              organization: formatCompactCount(limits.maxOrganizationTokens, locale),
              count: formatCount(limits.maxSources, locale),
            })}
          </li>
          <li>{fill(t.price, { price })}</li>
        </ul>
        <div className="grid gap-1 border-t border-line pt-4">
          <h3 className="font-bold">{t.month}</h3>
          <p className="data text-muted">
            {fill(t.monthIndex, { cost: formatUsd(usage.month.indexCostMicrocents, locale) })} · {fill(t.monthSearch, { cost: formatUsd(usage.month.searchCostMicrocents, locale) })}
          </p>
          <p className="text-[0.87rem] text-muted">{t.callNote}</p>
        </div>
      </div>
    </Panel>
  );
}
