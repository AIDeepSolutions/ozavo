"use client";

import { Check, Copy } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import en from "../../../../i18n/en/platform-tenants";
import es from "../../../../i18n/es/platform-tenants";
import { fill } from "../../../../i18n/locales";
import ptBR from "../../../../i18n/pt-BR/platform-tenants";
import { useDict, useLocale } from "../../../../i18n/provider";
import { ApiFailure } from "../../../../ui/api";
import { useErrorText } from "../../../../ui/errors";
import { formatDateTime } from "../../../../ui/format";
import { Badge, Button, Field, Notice, TextInput, type Tone } from "../../../../ui/kit";
import { minutesOf, usagePercent, type PlatformTenantStatus, type TenantRow } from "../../../../ui/platform-tenants";

export const useTenantsDict = () => useDict(ptBR, en, es);

const STATUS_TONE: Record<PlatformTenantStatus, Tone> = { active: "ok", suspended: "warn", cancelled: "fail" };

export function StatusBadge({ status }: { status: PlatformTenantStatus }) {
  const t = useTenantsDict();
  return <Badge tone={STATUS_TONE[status]}>{t.status[status]}</Badge>;
}

export function originText(t: ReturnType<typeof useTenantsDict>, origin: TenantRow["origin"]): string {
  return origin.kind === "api" ? fill(t.origin.api, { source: origin.source }) : t.origin[origin.kind];
}

export function planText(t: ReturnType<typeof useTenantsDict>, code: string | null): string {
  if (code === null) return t.noPlan;
  return Object.hasOwn(t.plans, code) ? t.plans[code as keyof typeof t.plans] : code;
}

/** Usado e total do ciclo, com uma barra que não depende só da cor: o número está ao lado. */
export function UsageMeter({ usage }: { usage: TenantRow["usage"] }) {
  const t = useTenantsDict();
  const locale = useLocale();
  if (!usage) return <span className="text-muted">{t.noUsage}</span>;
  const percent = usagePercent(usage.consumedSeconds, usage.includedSeconds);
  const label = fill(t.usageOf, { used: minutesOf(usage.consumedSeconds).toLocaleString(locale), total: minutesOf(usage.includedSeconds).toLocaleString(locale) });
  const bar = percent >= 100 ? "bg-fail" : percent >= 80 ? "bg-warn" : "bg-accent";
  return (
    <div className="grid min-w-36 gap-1">
      <span className="data text-[0.87rem]">{label}</span>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 overflow-hidden rounded-full bg-sunken">
        <div className={`h-full ${bar}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** "Pronta" ou "Faltam N": a lista mostra o resumo, o detalhe mostra cada item. */
export function ReadinessBadge({ readiness }: { readiness: TenantRow["readiness"] }) {
  const t = useTenantsDict();
  return readiness.ready ? <Badge tone="ok">{t.readiness.ready}</Badge> : <Badge tone="warn">{fill(t.readiness.missing, { n: readiness.missingRequired })}</Badge>;
}

export function inviteText(t: ReturnType<typeof useTenantsDict>, invite: TenantRow["ownerInvite"], locale: ReturnType<typeof useLocale>): { text: string; tone: Tone } {
  if (invite.ownerActive) return { text: t.invite.ownerActive, tone: "ok" };
  if (!invite.pending) return { text: t.invite.none, tone: "neutral" };
  const date = formatDateTime(invite.pending.expiresAt, locale);
  return invite.pending.expired ? { text: fill(t.invite.expired, { date }), tone: "fail" } : { text: fill(t.invite.pending, { date }), tone: "warn" };
}

/** O link do convite de dono: existe só na memória desta tela, a API não o devolve de novo. */
export function InviteLinkCard({ title, link, expiresAt, href }: { title: string; link: string; expiresAt: string; href?: string }) {
  const t = useTenantsDict();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <section className="grid gap-4 rounded-md border border-accent bg-surface p-5" aria-live="polite">
      <div className="grid max-w-[70ch] gap-1">
        <h2 className="text-[1.07rem] font-bold">{title}</h2>
        <p className="text-muted">{fill(t.linkBody, { date: formatDateTime(expiresAt, locale) })}</p>
      </div>
      <div className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
        <Field label={t.linkLabel}>
          <TextInput mono readOnly value={link} onFocus={(event) => event.target.select()} />
        </Field>
        <Button
          variant="primary"
          icon={copied ? <Check size={18} weight="bold" aria-hidden /> : <Copy size={18} weight="duotone" aria-hidden />}
          onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
        >
          {t.copy}
        </Button>
        {href ? (
          <Link href={href} className="inline-flex h-10 items-center rounded-xs px-4 font-bold text-muted hover:bg-sunken hover:text-ink">
            {t.viewCompany}
          </Link>
        ) : null}
      </div>
      {copied ? (
        <p role="status" className="text-ok">
          {t.copied}
        </p>
      ) : null}
    </section>
  );
}

/** A frase de um erro da área: os códigos próprios daqui, ou a frase comum do painel. */
export function useTenantsError(): (error: unknown) => string {
  const t = useTenantsDict();
  const common = useErrorText();
  return (error) => {
    if (error instanceof ApiFailure && (error.code === "platform_only" || error.code === "forbidden")) return t.forbidden;
    if (error instanceof ApiFailure && Object.hasOwn(t.errors, error.code)) return t.errors[error.code as keyof typeof t.errors];
    return common(error);
  };
}

export function LoadFailure({ error }: { error: unknown }) {
  const text = useTenantsError();
  return <Notice tone="fail">{text(error)}</Notice>;
}
