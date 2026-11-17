"use client";

import { ArrowLeft } from "@phosphor-icons/react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { fill } from "../../../../../i18n/locales";
import { useLocale } from "../../../../../i18n/provider";
import { api, useApi } from "../../../../../ui/api";
import { formatBrl } from "../../../../../ui/format";
import { Button, Field, Notice, PageHeader, Panel, Select, TextInput } from "../../../../../ui/kit";
import { reaisToCents, wholeNumber } from "../../../../../ui/platform-tenants";
import { InviteLinkCard, useTenantsDict, useTenantsError } from "../shared";

const PLANS = ["starter", "pro", "growth", "scale", "custom"] as const;
type Plan = (typeof PLANS)[number];
type Status = "active" | "suspended";

interface Created {
  created: boolean;
  organizationId: string;
  ownerInviteUrl: string | null;
  ownerInviteExpiresAt: string | null;
}

type Catalog = Record<Exclude<Plan, "custom">, { monthlyPriceCents: number; includedMinutes: number; maxConcurrentCalls: number }>;

const emptyDraft = { companyName: "", tradeName: "", cnpj: "", ownerName: "", ownerEmail: "", plan: "starter" as Plan, price: "", minutes: "", channels: "", initialStatus: "active" as Status };

export default function NewTenantPage() {
  const t = useTenantsDict();
  const locale = useLocale();
  const errorText = useTenantsError();
  const [draft, setDraft] = useState(emptyDraft);
  // Um por formulário: o mesmo envio repetido (clique duplo, rede que caiu) devolve a mesma empresa.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<Partial<Record<"price" | "minutes" | "channels", true>>>({});
  const [result, setResult] = useState<{ name: string; data: Created } | null>(null);
  // O catálogo de preço e franquia vem do servidor: a tela não guarda uma segunda cópia.
  const catalogs = useApi<{ catalog: Catalog }>("/finops/plan").data?.catalog;

  const custom = draft.plan === "custom";
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const price = reaisToCents(draft.price);
    const minutes = wholeNumber(draft.minutes);
    const channels = wholeNumber(draft.channels);
    const wrong = custom ? { ...(price === null && { price: true as const }), ...(minutes === null && { minutes: true as const }), ...((channels === null || channels < 1) && { channels: true as const }) } : {};
    setInvalid(wrong);
    if (Object.keys(wrong).length > 0) return;
    setBusy(true);
    setError("");
    void api<Created>("/platform/tenants", {
      body: {
        requestId,
        companyName: draft.companyName,
        ...(draft.tradeName.trim() !== "" && { tradeName: draft.tradeName }),
        ...(draft.cnpj.trim() !== "" && { cnpj: draft.cnpj }),
        owner: { name: draft.ownerName, email: draft.ownerEmail },
        plan: draft.plan,
        ...(custom && { custom: { monthlyPriceCents: price, includedMinutes: minutes, maxConcurrentCalls: channels } }),
        initialStatus: draft.initialStatus,
      },
    })
      .then((data) => {
        setResult({ name: draft.tradeName.trim() || draft.companyName, data });
        setDraft(emptyDraft);
        setRequestId(crypto.randomUUID());
      }, (failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  const catalog = draft.plan === "custom" ? null : (catalogs?.[draft.plan] ?? null);
  return (
    <>
      <Link href="/platform/tenants" className="inline-flex items-center gap-2 text-muted hover:text-ink">
        <ArrowLeft size={18} aria-hidden />
        {t.back}
      </Link>
      <PageHeader title={t.newTitle} lead={t.newLead} />

      {result ? (
        result.data.ownerInviteUrl && result.data.ownerInviteExpiresAt ? (
          <InviteLinkCard
            title={fill(result.data.created ? t.createdTitle : t.repeatedTitle, { name: result.name })}
            link={result.data.ownerInviteUrl}
            expiresAt={result.data.ownerInviteExpiresAt}
            href={`/platform/tenants/${result.data.organizationId}`}
          />
        ) : (
          <Notice tone="ok">{t.noLink}</Notice>
        )
      ) : null}

      <Panel>
        <form onSubmit={submit} className="grid gap-5" noValidate={false}>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label={t.companyName}>
              <TextInput value={draft.companyName} onChange={(event) => setDraft({ ...draft, companyName: event.target.value })} required maxLength={200} autoFocus />
            </Field>
            <Field label={t.tradeName} hint={t.tradeNameHint}>
              <TextInput value={draft.tradeName} onChange={(event) => setDraft({ ...draft, tradeName: event.target.value })} maxLength={200} />
            </Field>
            <Field label={t.cnpj} hint={t.cnpjHint}>
              <TextInput mono inputMode="numeric" value={draft.cnpj} onChange={(event) => setDraft({ ...draft, cnpj: event.target.value })} maxLength={18} autoComplete="off" />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t.ownerName}>
              <TextInput value={draft.ownerName} onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })} required maxLength={120} autoComplete="off" />
            </Field>
            <Field label={t.ownerEmail}>
              <TextInput type="email" value={draft.ownerEmail} onChange={(event) => setDraft({ ...draft, ownerEmail: event.target.value })} required maxLength={254} autoComplete="off" />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label={t.plan}
              hint={catalog ? fill(t.planHint, { price: formatBrl(catalog.monthlyPriceCents, locale), minutes: catalog.includedMinutes.toLocaleString(locale), channels: catalog.maxConcurrentCalls }) : undefined}
            >
              <Select value={draft.plan} onChange={(event) => setDraft({ ...draft, plan: event.target.value as Plan })}>
                {PLANS.map((plan) => (
                  <option key={plan} value={plan}>
                    {t.plans[plan]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.initialStatus} hint={t.initialHint}>
              <Select value={draft.initialStatus} onChange={(event) => setDraft({ ...draft, initialStatus: event.target.value as Status })}>
                <option value="active">{t.initial.active}</option>
                <option value="suspended">{t.initial.suspended}</option>
              </Select>
            </Field>
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

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" busy={busy}>
              {t.create}
            </Button>
          </div>
          {error ? <Notice tone="fail">{error}</Notice> : null}
        </form>
      </Panel>
    </>
  );
}
