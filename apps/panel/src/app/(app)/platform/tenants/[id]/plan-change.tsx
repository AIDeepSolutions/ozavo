"use client";

import { useState, type FormEvent } from "react";
import enCommon from "../../../../../i18n/en/common";
import esCommon from "../../../../../i18n/es/common";
import { fill } from "../../../../../i18n/locales";
import ptBRCommon from "../../../../../i18n/pt-BR/common";
import { useDict } from "../../../../../i18n/provider";
import { api } from "../../../../../ui/api";
import { Button, Field, Notice, Panel, Select, TextInput } from "../../../../../ui/kit";
import { centsToReais, reaisToCents, wholeNumber, type TenantDetail } from "../../../../../ui/platform-tenants";
import { useTenantsDict, useTenantsError } from "../shared";

const PLANS = ["starter", "pro", "growth", "scale", "custom"] as const;
type Plan = (typeof PLANS)[number];
type Rule = "pause_outbound" | "bill_overage";
type Invalid = Partial<Record<"price" | "minutes" | "channels" | "overagePrice", true>>;

function draftOf(tenant: TenantDetail) {
  const current = tenant.finops.subscription;
  const plan = (PLANS as readonly string[]).includes(current?.plan ?? "") ? (current?.plan as Plan) : "starter";
  return {
    plan,
    overageRule: (current?.overageRule ?? "pause_outbound") as Rule,
    overagePrice: current ? centsToReais(current.overagePriceCentsPerMinute) : "0",
    price: current && plan === "custom" ? centsToReais(current.monthlyPriceCents) : "",
    minutes: current && plan === "custom" ? String(current.includedMinutes) : "",
    channels: current && plan === "custom" ? String(current.maxConcurrentCalls) : "",
  };
}

/** Troca o plano da empresa pela plataforma, com confirmação que nomeia a empresa e o plano novo. */
export function PlanChangePanel({ tenant, reload }: { tenant: TenantDetail; reload(): void }) {
  const t = useTenantsDict();
  const cancel = useDict(ptBRCommon, enCommon, esCommon).actions.cancel;
  const errorText = useTenantsError();
  const [draft, setDraft] = useState(() => draftOf(tenant));
  const [invalid, setInvalid] = useState<Invalid>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const custom = draft.plan === "custom";

  const values = () => {
    const overagePrice = reaisToCents(draft.overagePrice);
    const price = reaisToCents(draft.price);
    const minutes = wholeNumber(draft.minutes);
    const channels = wholeNumber(draft.channels);
    const wrong: Invalid = {
      ...(draft.overageRule === "bill_overage" && overagePrice === null && { overagePrice: true as const }),
      ...(custom && price === null && { price: true as const }),
      ...(custom && minutes === null && { minutes: true as const }),
      ...(custom && (channels === null || channels < 1) && { channels: true as const }),
    };
    return { wrong, overagePrice: overagePrice ?? 0, price, minutes, channels };
  };

  const ask = (event: FormEvent): void => {
    event.preventDefault();
    const { wrong } = values();
    setInvalid(wrong);
    setSaved(false);
    if (Object.keys(wrong).length === 0) setConfirming(true);
  };

  const save = (): void => {
    const { overagePrice, price, minutes, channels } = values();
    setBusy(true);
    setError("");
    void api(`/platform/tenants/${tenant.organizationId}/plan`, {
      method: "PUT",
      body: {
        plan: draft.plan,
        overageRule: draft.overageRule,
        overagePriceCentsPerMinute: draft.overageRule === "bill_overage" ? overagePrice : 0,
        ...(custom && { monthlyPriceCents: price, includedMinutes: minutes, maxConcurrentCalls: channels }),
      },
    })
      .then(() => {
        setConfirming(false);
        setSaved(true);
        reload();
      }, (failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <Panel title={t.planChange.title} description={t.planChange.lead}>
      <form onSubmit={ask} className="grid gap-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label={t.plan}>
            <Select value={draft.plan} onChange={(event) => setDraft({ ...draft, plan: event.target.value as Plan })}>
              {PLANS.map((plan) => (
                <option key={plan} value={plan}>
                  {t.plans[plan]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.planChange.overageRule} hint={t.planChange.overageHint}>
            <Select value={draft.overageRule} onChange={(event) => setDraft({ ...draft, overageRule: event.target.value as Rule })}>
              <option value="pause_outbound">{t.planChange.rules.pause_outbound}</option>
              <option value="bill_overage">{t.planChange.rules.bill_overage}</option>
            </Select>
          </Field>
          {draft.overageRule === "bill_overage" ? (
            <Field label={t.planChange.overagePrice} error={invalid.overagePrice ? t.invalidNumber : undefined}>
              <TextInput mono inputMode="decimal" value={draft.overagePrice} onChange={(event) => setDraft({ ...draft, overagePrice: event.target.value })} aria-invalid={invalid.overagePrice === true} />
            </Field>
          ) : null}
        </div>
        {custom ? (
          <fieldset className="grid gap-4 md:grid-cols-3">
            <legend className="sr-only">{t.plans.custom}</legend>
            <Field label={t.customPrice} error={invalid.price ? t.invalidNumber : undefined}>
              <TextInput mono inputMode="decimal" value={draft.price} onChange={(event) => setDraft({ ...draft, price: event.target.value })} required aria-invalid={invalid.price === true} />
            </Field>
            <Field label={t.customMinutes} error={invalid.minutes ? t.invalidNumber : undefined}>
              <TextInput mono inputMode="numeric" value={draft.minutes} onChange={(event) => setDraft({ ...draft, minutes: event.target.value })} required aria-invalid={invalid.minutes === true} />
            </Field>
            <Field label={t.customChannels} error={invalid.channels ? t.invalidNumber : undefined}>
              <TextInput mono inputMode="numeric" value={draft.channels} onChange={(event) => setDraft({ ...draft, channels: event.target.value })} required aria-invalid={invalid.channels === true} />
            </Field>
          </fieldset>
        ) : null}
        {tenant.billedByAsaas ? <Notice>{t.planChange.asaasNotice}</Notice> : null}
        {!confirming ? (
          <div>
            <Button type="submit" variant="primary">
              {t.planChange.submit}
            </Button>
          </div>
        ) : (
          <Notice>
            <p>{fill(t.planChange.confirm, { name: tenant.name, plan: t.plans[draft.plan] })}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button variant="primary" busy={busy} onClick={save}>
                {fill(t.planChange.confirmYes, { name: tenant.name })}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {cancel}
              </Button>
            </div>
          </Notice>
        )}
        {saved ? (
          <p role="status" className="text-ok">
            {t.planChange.saved}
          </p>
        ) : null}
        {error ? <Notice tone="fail">{error}</Notice> : null}
      </form>
    </Panel>
  );
}
