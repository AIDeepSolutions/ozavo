"use client";

import { useEffect, useState, type ReactNode } from "react";
import en from "../../../i18n/en/finops";
import es from "../../../i18n/es/finops";
import { fill } from "../../../i18n/locales";
import ptBR from "../../../i18n/pt-BR/finops";
import { useDict, useLocale } from "../../../i18n/provider";
import { api, useApi } from "../../../ui/api";
import { ActionStatus, ReadOnlyNotice, useAction, useErrorText } from "../../../ui/errors";
import { formatBrl, formatDay, formatMoney, formatPhone } from "../../../ui/format";
import { Badge, Button, Field, Notice, PageHeader, Panel, Select, Skeleton, TextInput } from "../../../ui/kit";
import { useCanConfigure } from "../../../ui/me";
import type { Finops, OperationSettings, OverageRule, PlanId, PlanState } from "../../../ui/types";
import { ConsolidatedPanel } from "./consolidated-panel";
import { TalkSharePanel } from "./talk-share-panel";
import { AlertDeliveryPanel } from "./alert-delivery-panel";

const PLAN_ORDER: PlanId[] = ["starter", "pro", "growth", "scale", "custom"];
const RULES: OverageRule[] = ["pause_outbound", "bill_overage"];

interface PlanDraft {
  plan: PlanId;
  overageRule: OverageRule;
  /** Em reais, como a pessoa digita. */
  overagePrice: string;
  monthlyPrice: string;
  includedMinutes: string;
  maxConcurrentCalls: string;
  cycleStartedOn: string;
}

interface LimitsDraft {
  ttsConcurrencyLimit: string;
  reducedCallsPerHour: string;
  telephonyBrlPerMinute: string;
  usdBrlRate: string;
}

const reais = (cents: number): string => (cents / 100).toFixed(2);
const centsOf = (text: string): number => Math.round(Number(text.replace(",", ".")) * 100);
const numberOrNull = (text: string): number | null => (text.trim() === "" ? null : Number(text.replace(",", ".")));
const minutesOf = (seconds: number): number => Math.ceil(seconds / 60);

/** Um número grande com o rótulo em cima e o detalhe embaixo. */
function Stat({ label, value, detail, badge }: { label: string; value: string; detail?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="grid content-start gap-1.5 rounded-md border border-line bg-surface p-5">
      <span className="flex items-center justify-between gap-2 text-[0.8rem] font-bold text-muted">
        {label}
        {badge}
      </span>
      <span className="data text-[1.9rem] leading-none font-medium tracking-[-0.03em]">{value}</span>
      {detail ? <span className="text-[0.87rem] text-muted">{detail}</span> : null}
    </div>
  );
}

/** Barra do consumo da franquia. Muda de tom nos mesmos limiares dos alertas: 80% e 100%. */
function Meter({ share, label }: { share: number; label: string }) {
  const tone = share >= 1 ? "bg-fail" : share >= 0.8 ? "bg-warn" : "bg-accent";
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(share * 100))} className="block h-2 overflow-hidden rounded-full bg-sunken">
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(share * 100, 1.5))}%` }} />
    </span>
  );
}

function Line({ label, value, strong, hint }: { label: string; value: string; strong?: boolean; hint?: string }) {
  return (
    <li className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 ${strong ? "font-bold" : ""}`}>
      <span>{label}</span>
      <span className="data text-right">
        {value}
        {hint ? <span className="block text-[0.87rem] font-normal text-muted">{hint}</span> : null}
      </span>
    </li>
  );
}

export default function FinopsPage() {
  const t = useDict(ptBR, en, es);
  const locale = useLocale();
  const errorText = useErrorText();
  const canConfigure = useCanConfigure();
  const summary = useApi<Finops>("/finops");
  const plan = useApi<PlanState>("/finops/plan");
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);
  const [limitsDraft, setLimitsDraft] = useState<LimitsDraft | null>(null);
  const savePlan = useAction();
  const saveLimits = useAction();

  useEffect(() => {
    if (!plan.data) return;
    const current = plan.data.subscription;
    setPlanDraft({
      plan: current?.plan ?? "starter",
      overageRule: current?.overageRule ?? "pause_outbound",
      overagePrice: reais(current?.overagePriceCentsPerMinute ?? 0),
      monthlyPrice: reais(current?.monthlyPriceCents ?? 0),
      includedMinutes: String(current?.includedMinutes ?? 0),
      maxConcurrentCalls: String(current?.maxConcurrentCalls ?? 1),
      cycleStartedOn: current?.cycleStartedOn ?? "",
    });
  }, [plan.data]);

  const settings = summary.data?.settings;
  useEffect(() => {
    if (!settings) return;
    setLimitsDraft({
      ttsConcurrencyLimit: settings.ttsConcurrencyLimit === null ? "" : String(settings.ttsConcurrencyLimit),
      reducedCallsPerHour: String(settings.reducedCallsPerHour),
      telephonyBrlPerMinute: settings.telephonyBrlPerMinute === null ? "" : String(settings.telephonyBrlPerMinute),
      usdBrlRate: settings.usdBrlRate === null ? "" : String(settings.usdBrlRate),
    });
    // Só quando os valores gravados mudam: o que a pessoa está digitando não é sobrescrito a cada leitura.
  }, [settings?.ttsConcurrencyLimit, settings?.reducedCallsPerHour, settings?.telephonyBrlPerMinute, settings?.usdBrlRate]);

  const failed = summary.error && !summary.data ? summary.error : plan.error && !plan.data ? plan.error : null;
  if (failed) return <Notice tone="fail">{errorText(failed)}</Notice>;
  const data = summary.data;
  if (!data || !plan.data || !planDraft || !limitsDraft) return <Skeleton lines={5} />;

  // Plano e limites são comerciais: quem não é a plataforma lê, mas não grava.
  const canEdit = canConfigure && plan.data.platform;
  const { margin } = data;
  const usedMinutes = minutesOf(data.consumedSeconds);
  const share = data.includedSeconds ? data.consumedSeconds / data.includedSeconds : 0;
  const money = (cents: number | null): string => (cents === null ? t.unknown : formatBrl(cents, locale));
  const reached = new Set(data.alerts.map((alert) => alert.threshold));
  const custom = planDraft.plan === "custom";
  const maxSeconds = Math.max(1, ...data.byDay.map((row) => row.seconds));

  const submitPlan = async (): Promise<void> => {
    await api("/finops/plan", {
      method: "PUT",
      body: {
        plan: planDraft.plan,
        overageRule: planDraft.overageRule,
        overagePriceCentsPerMinute: centsOf(planDraft.overagePrice),
        ...(custom && {
          monthlyPriceCents: centsOf(planDraft.monthlyPrice),
          includedMinutes: Number(planDraft.includedMinutes),
          maxConcurrentCalls: Number(planDraft.maxConcurrentCalls),
        }),
        ...(planDraft.cycleStartedOn && { cycleStartedOn: planDraft.cycleStartedOn }),
      },
    });
    plan.reload();
    summary.reload();
  };
  const submitLimits = async (): Promise<void> => {
    const body: OperationSettings = {
      ttsConcurrencyLimit: numberOrNull(limitsDraft.ttsConcurrencyLimit),
      reducedCallsPerHour: Number(limitsDraft.reducedCallsPerHour),
      telephonyBrlPerMinute: numberOrNull(limitsDraft.telephonyBrlPerMinute),
      usdBrlRate: numberOrNull(limitsDraft.usdBrlRate),
    };
    await api("/finops/settings", { method: "PUT", body });
    summary.reload();
  };

  return (
    <>
      <PageHeader title={t.title} lead={t.lead} actions={<span className="data text-[0.87rem] text-muted">{fill(t.period, { start: formatDay(data.period.start, locale), end: formatDay(data.period.end, locale) })}</span>} />
      <ReadOnlyNotice />
      {canConfigure && !plan.data.platform ? <Notice>{t.platformOnly}</Notice> : null}

      {data.cadenceBreakers.map((breaker) => (
        <Notice key={breaker.lineE164} tone="fail">
          {fill(t.breaker, {
            line: breaker.lineE164 === "" ? t.breakerAllLines : formatPhone(breaker.lineE164),
            short: breaker.shortCalls,
            total: breaker.totalCalls,
            limit: data.settings.reducedCallsPerHour,
          })}
        </Notice>
      ))}
      {reached.has(100) ? (
        <Notice tone="fail">{data.subscription?.overageRule === "bill_overage" ? t.alert100Bill : fill(t.alert100Pause, { end: formatDay(data.period.end, locale) })}</Notice>
      ) : reached.has(80) ? (
        <Notice tone="warn">{t.alert80}</Notice>
      ) : null}
      {data.subscription ? null : <Notice>{t.noPlan}</Notice>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="grid content-start gap-2.5 rounded-md border border-line bg-surface p-5">
          <span className="text-[0.8rem] font-bold text-muted">{t.minutes}</span>
          <span className="data text-[1.9rem] leading-none font-medium tracking-[-0.03em]">
            {data.subscription ? fill(t.minutesOf, { used: usedMinutes, included: data.subscription.includedMinutes }) : fill(t.minutesOnly, { used: usedMinutes })}
          </span>
          {data.includedSeconds ? (
            <>
              <Meter share={share} label={t.minutes} />
              <span className="text-[0.87rem] text-muted">
                {fill(t.usedPercent, { n: Math.round(share * 100) })}
                {data.overageSeconds > 0 ? ` · ${fill(t.overage, { n: minutesOf(data.overageSeconds) })}` : ""}
              </span>
            </>
          ) : null}
        </div>
        <Stat label={t.answeredCalls} value={data.answeredCalls.toLocaleString(locale)} />
        <Stat
          label={t.ttsCharacters}
          value={data.ttsCharacters.toLocaleString(locale)}
          detail={data.consumedSeconds > 0 ? fill(t.ttsPerMinute, { n: Math.round(data.ttsCharacters / (data.consumedSeconds / 60)).toLocaleString(locale) }) : undefined}
        />
        <Stat
          label={t.costPerMinute}
          value={money(margin.costPerMinuteCents === null ? null : Math.round(margin.costPerMinuteCents))}
          detail={fill(t.target, { value: formatBrl(data.costTargetCentsPerMinute, locale) })}
          badge={margin.withinTarget === null ? undefined : <Badge tone={margin.withinTarget ? "ok" : "fail"}>{margin.withinTarget ? t.withinTarget : t.aboveTarget}</Badge>}
        />
      </div>

      <TalkSharePanel />
      {canConfigure && plan.data.platform ? <ConsolidatedPanel /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={t.marginTitle} description={t.marginLead}>
          <ul className="divide-y divide-line">
            <Line label={t.mrr} value={formatBrl(data.subscription?.monthlyPriceCents ?? 0, locale)} />
            <Line label={t.overageRevenue} value={formatBrl(margin.overageRevenueCents, locale)} />
            <Line label={t.revenue} value={formatBrl(margin.revenueCents, locale)} strong />
            <Line label={t.providerCost} value={money(margin.providerCostCents)} hint={fill(t.providerCostUsd, { value: formatMoney(data.providerCostUsdCents, locale) })} />
            <Line label={t.telephonyCost} value={money(margin.telephonyCostCents)} />
            <Line label={t.variableCost} value={money(margin.variableCostCents)} strong />
            <Line
              label={t.grossMargin}
              value={money(margin.grossMarginCents)}
              strong
              hint={margin.grossMarginPercent === null ? undefined : fill(t.grossMarginPercent, { n: margin.grossMarginPercent.toLocaleString(locale) })}
            />
          </ul>
          <div className="mt-4 grid gap-2">
            {data.settings.usdBrlRate === null ? <Notice tone="warn">{t.missingRate}</Notice> : null}
            {data.settings.telephonyBrlPerMinute === null ? <Notice tone="warn">{t.missingTelephony}</Notice> : null}
          </div>
        </Panel>

        <Panel title={t.byDay}>
          {data.byDay.length === 0 ? (
            <p className="text-muted">{t.byDayEmpty}</p>
          ) : (
            <ul className="grid gap-2.5">
              {data.byDay.map((row) => (
                <li key={row.day} className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-4" title={fill(t.dayCalls, { n: row.calls })}>
                  <span className="data text-muted">{formatDay(row.day, locale)}</span>
                  <span className="block h-2 overflow-hidden rounded-full bg-sunken">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max((row.seconds / maxSeconds) * 100, 1.5)}%` }} />
                  </span>
                  <span className="data text-right">{fill(t.dayMinutes, { n: minutesOf(row.seconds) })}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={t.planTitle} description={t.planLead}>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void savePlan.run(submitPlan);
          }}
        >
          <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Field label={t.plan}>
              <Select value={planDraft.plan} onChange={(event) => setPlanDraft({ ...planDraft, plan: event.target.value as PlanId })}>
                {PLAN_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {id === "custom"
                      ? t.plans.custom
                      : fill(t.planOption, { name: t.plans[id], minutes: plan.data?.catalog[id].includedMinutes ?? 0, price: formatBrl(plan.data?.catalog[id].monthlyPriceCents ?? 0, locale) })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.overageRule} hint={t.overageRuleHint}>
              <Select value={planDraft.overageRule} onChange={(event) => setPlanDraft({ ...planDraft, overageRule: event.target.value as OverageRule })}>
                {RULES.map((rule) => (
                  <option key={rule} value={rule}>
                    {t.overageRules[rule]}
                  </option>
                ))}
              </Select>
            </Field>
            {planDraft.overageRule === "bill_overage" ? (
              <Field label={t.overagePrice}>
                <TextInput mono type="number" min={0} step="0.01" value={planDraft.overagePrice} onChange={(event) => setPlanDraft({ ...planDraft, overagePrice: event.target.value })} required />
              </Field>
            ) : null}
            {custom ? (
              <>
                <Field label={t.monthlyPrice}>
                  <TextInput mono type="number" min={0} step="0.01" value={planDraft.monthlyPrice} onChange={(event) => setPlanDraft({ ...planDraft, monthlyPrice: event.target.value })} required />
                </Field>
                <Field label={t.includedMinutes}>
                  <TextInput mono type="number" min={0} step={1} value={planDraft.includedMinutes} onChange={(event) => setPlanDraft({ ...planDraft, includedMinutes: event.target.value })} required />
                </Field>
                <Field label={t.maxConcurrentCalls}>
                  <TextInput mono type="number" min={1} max={500} step={1} value={planDraft.maxConcurrentCalls} onChange={(event) => setPlanDraft({ ...planDraft, maxConcurrentCalls: event.target.value })} required />
                </Field>
              </>
            ) : null}
            <Field label={t.cycleStartedOn} hint={t.cycleStartedOnHint}>
              <TextInput mono type="date" value={planDraft.cycleStartedOn} onChange={(event) => setPlanDraft({ ...planDraft, cycleStartedOn: event.target.value })} />
            </Field>
          </fieldset>
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" busy={savePlan.busy}>
                {t.savePlan}
              </Button>
              <ActionStatus action={savePlan} />
            </div>
          ) : null}
        </form>
      </Panel>

      <Panel title={t.limitsTitle} description={t.limitsLead}>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void saveLimits.run(submitLimits);
          }}
        >
          <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2">
            <Field label={t.ttsLimit} hint={t.ttsLimitHint}>
              <TextInput mono type="number" min={1} max={1000} step={1} value={limitsDraft.ttsConcurrencyLimit} onChange={(event) => setLimitsDraft({ ...limitsDraft, ttsConcurrencyLimit: event.target.value })} />
            </Field>
            <Field label={t.reducedCallsPerHour} hint={t.reducedCallsPerHourHint}>
              <TextInput mono type="number" min={1} max={10000} step={1} value={limitsDraft.reducedCallsPerHour} onChange={(event) => setLimitsDraft({ ...limitsDraft, reducedCallsPerHour: event.target.value })} required />
            </Field>
            <Field label={t.telephonyCostPerMinute} hint={t.telephonyCostHint}>
              <TextInput mono type="number" min={0} step="0.0001" value={limitsDraft.telephonyBrlPerMinute} onChange={(event) => setLimitsDraft({ ...limitsDraft, telephonyBrlPerMinute: event.target.value })} />
            </Field>
            <Field label={t.usdBrlRate} hint={t.usdBrlRateHint}>
              <TextInput mono type="number" min={0} step="0.0001" value={limitsDraft.usdBrlRate} onChange={(event) => setLimitsDraft({ ...limitsDraft, usdBrlRate: event.target.value })} />
            </Field>
          </fieldset>
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" busy={saveLimits.busy}>
                {t.saveLimits}
              </Button>
              <ActionStatus action={saveLimits} />
            </div>
          ) : null}
        </form>
      </Panel>

      <AlertDeliveryPanel />
    </>
  );
}
