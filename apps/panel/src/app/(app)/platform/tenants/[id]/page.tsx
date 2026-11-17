"use client";

import { ArrowLeft } from "@phosphor-icons/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import enCommon from "../../../../../i18n/en/common";
import esCommon from "../../../../../i18n/es/common";
import { fill } from "../../../../../i18n/locales";
import ptBRCommon from "../../../../../i18n/pt-BR/common";
import { useDict, useLocale } from "../../../../../i18n/provider";
import { api, useApi } from "../../../../../ui/api";
import { formatBrl, formatDateTime, formatDay, formatMoney, formatPhone } from "../../../../../ui/format";
import { Badge, Button, Notice, PageHeader, Panel, Skeleton } from "../../../../../ui/kit";
import { formatCnpj, minutesOf, type TenantDetail } from "../../../../../ui/platform-tenants";
import { InviteLinkCard, LoadFailure, StatusBadge, UsageMeter, originText, planText, useTenantsDict, useTenantsError } from "../shared";
import { PlanChangePanel } from "./plan-change";

type Dict = ReturnType<typeof useTenantsDict>;

function Stat({ label, value, text = false }: { label: string; value: string; text?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[0.8rem] font-bold text-muted">{label}</dt>
      <dd className={`text-[1.05rem] ${text ? "font-bold" : "data"}`}>{value}</dd>
    </div>
  );
}

function CompanyPanel({ tenant }: { tenant: TenantDetail }) {
  const t = useTenantsDict();
  const missing = t.notInformedShort;
  return (
    <Panel title={t.companyPanel}>
      <dl className="grid gap-4 sm:grid-cols-3">
        <Stat label={t.companyName} value={tenant.legalName ?? missing} text />
        <Stat label={t.tradeName} value={tenant.tradeName ?? missing} text />
        <Stat label={t.cnpj} value={tenant.cnpj === null ? missing : formatCnpj(tenant.cnpj)} />
      </dl>
    </Panel>
  );
}

function PlanPanel({ tenant }: { tenant: TenantDetail }) {
  const t = useTenantsDict();
  const locale = useLocale();
  const { finops } = tenant;
  const margin = finops.margin;
  return (
    <Panel title={t.planPanel} description={fill(t.cycle, { start: formatDay(finops.period.start, locale), end: formatDay(finops.period.end, locale) })}>
      <div className="grid gap-5">
        <UsageMeter usage={tenant.usage} />
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t.columns.plan} value={planText(t, finops.subscription?.plan ?? tenant.planCode)} text />
          <Stat label={t.consumed} value={fill(t.minutes, { n: minutesOf(finops.consumedSeconds).toLocaleString(locale) })} />
          <Stat label={t.included} value={finops.includedSeconds === null ? t.noUsage : fill(t.minutes, { n: minutesOf(finops.includedSeconds).toLocaleString(locale) })} />
          <Stat label={t.calls} value={finops.answeredCalls.toLocaleString(locale)} />
          <Stat label={t.revenue} value={formatBrl(margin.revenueCents, locale)} />
          <Stat label={t.providerCost} value={formatMoney(finops.providerCostUsdCents, locale)} />
          <Stat label={t.variableCost} value={margin.variableCostCents === null ? "—" : formatBrl(margin.variableCostCents, locale)} />
          <Stat label={t.margin} value={margin.grossMarginPercent === null ? "—" : `${margin.grossMarginPercent.toLocaleString(locale)}%`} />
        </dl>
        {margin.variableCostCents === null ? <p className="text-[0.87rem] text-muted">{t.notInformed}</p> : null}
        <div className="grid gap-2">
          <h3 className="font-bold">{t.alertsTitle}</h3>
          {finops.alerts.length === 0 && finops.cadenceBreakers.length === 0 ? <p className="text-muted">{t.noAlerts}</p> : null}
          {finops.alerts.map((alert) => (
            <Notice key={`usage-${alert.threshold}`} tone={alert.threshold >= 100 ? "fail" : "warn"}>
              {fill(t.usageAlert, { threshold: alert.threshold, date: formatDateTime(alert.at, locale) })}
            </Notice>
          ))}
          {finops.cadenceBreakers.map((breaker) => (
            <Notice key={`breaker-${breaker.lineE164}`} tone="fail">
              {fill(t.breaker, { line: breaker.lineE164 === "*" ? t.wholeOrganization : formatPhone(breaker.lineE164), date: formatDateTime(breaker.trippedAt, locale) })}
            </Notice>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function StatusPanel({ tenant, reload }: { tenant: TenantDetail; reload(): void }) {
  const t = useTenantsDict();
  const cancel = useDict(ptBRCommon, enCommon, esCommon).actions.cancel;
  const errorText = useTenantsError();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const target = tenant.status === "suspended" ? "active" : "suspended";
  const change = (): void => {
    setBusy(true);
    setError("");
    void api(`/platform/tenants/${tenant.organizationId}/status`, { body: { status: target } })
      .then(() => {
        setConfirming(false);
        reload();
      }, (failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };
  return (
    <Panel title={t.statusPanel}>
      <div className="grid gap-3">
        <p>{fill(t.statusNow, { status: t.status[tenant.status].toLocaleLowerCase() })}</p>
        {tenant.status === "cancelled" ? <Notice tone="warn">{t.cancelledNotice}</Notice> : null}
        {tenant.heldByPlatform ? <Notice tone="warn">{t.heldNotice}</Notice> : null}
        {tenant.billedByAsaas ? <Notice>{t.asaasNotice}</Notice> : null}
        {!confirming ? (
          <div>
            <Button variant={target === "suspended" ? "danger" : "primary"} onClick={() => setConfirming(true)}>
              {target === "suspended" ? t.suspend : t.reactivate}
            </Button>
          </div>
        ) : (
          <Notice tone={target === "suspended" ? "fail" : "neutral"}>
            <p>{fill(target === "suspended" ? t.suspendConfirm : t.reactivateConfirm, { name: tenant.name })}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button variant={target === "suspended" ? "danger" : "primary"} busy={busy} onClick={change}>
                {fill(target === "suspended" ? t.suspendYes : t.reactivateYes, { name: tenant.name })}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {cancel}
              </Button>
            </div>
          </Notice>
        )}
        {error ? <Notice tone="fail">{error}</Notice> : null}
      </div>
    </Panel>
  );
}

function InvitePanel({ tenant, reload }: { tenant: TenantDetail; reload(): void }) {
  const t = useTenantsDict();
  const locale = useLocale();
  const errorText = useTenantsError();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renewed, setRenewed] = useState<{ ownerInviteUrl: string; ownerInviteExpiresAt: string } | null>(null);
  const { ownerActive, pending } = tenant.ownerInvite;
  const renew = (): void => {
    setBusy(true);
    setError("");
    void api<{ ownerInviteUrl: string; ownerInviteExpiresAt: string }>(`/platform/tenants/${tenant.organizationId}/owner-invite`, { method: "POST" })
      .then((data) => {
        setRenewed(data);
        reload();
      }, (failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };
  return (
    <Panel title={t.invitePanel}>
      <div className="grid gap-3">
        {ownerActive ? <p>{t.ownerActiveBody}</p> : null}
        {!ownerActive && pending ? (
          <p className={pending.expired ? "text-fail" : undefined}>{fill(pending.expired ? t.expiredBody : t.pendingBody, { email: pending.email, date: formatDateTime(pending.expiresAt, locale) })}</p>
        ) : null}
        {!ownerActive && !pending ? <p className="text-muted">{t.noInviteBody}</p> : null}
        {renewed ? <InviteLinkCard title={t.renewedTitle} link={renewed.ownerInviteUrl} expiresAt={renewed.ownerInviteExpiresAt} /> : null}
        {!ownerActive && !renewed ? (
          <div className="grid gap-1">
            <div>
              <Button variant="secondary" busy={busy} onClick={renew}>
                {t.renew}
              </Button>
            </div>
            <p className="text-[0.87rem] text-muted">{t.renewHint}</p>
          </div>
        ) : null}
        {error ? <Notice tone="fail">{error}</Notice> : null}
      </div>
    </Panel>
  );
}

function eventText(t: Dict, event: TenantDetail["events"][number]): string {
  if (event.kind === "tenant_status_changed") {
    const status = String(event.payload.status ?? "");
    return fill(t.events.tenant_status_changed, { status: (Object.hasOwn(t.status, status) ? t.status[status as keyof Dict["status"]] : status).toLocaleLowerCase() });
  }
  return Object.hasOwn(t.events, event.kind) && event.kind !== "other" ? t.events[event.kind as Exclude<keyof Dict["events"], "other">] : fill(t.events.other, { kind: event.kind });
}

function HistoryPanel({ tenant }: { tenant: TenantDetail }) {
  const t = useTenantsDict();
  const locale = useLocale();
  return (
    <Panel title={t.history} description={t.historyLead}>
      {tenant.events.length === 0 ? (
        <p className="text-muted">{t.historyEmpty}</p>
      ) : (
        <ol className="grid gap-2">
          {tenant.events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2 last:border-b-0">
              <span className="data text-[0.87rem] text-muted">{formatDateTime(event.at, locale)}</span>
              <span>{eventText(t, event)}</span>
              {typeof event.payload.byOrganizationId === "string" ? <Badge>{t.byPlatform}</Badge> : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

export default function TenantDetailPage() {
  const t = useTenantsDict();
  const locale = useLocale();
  const params = useParams<{ id: string }>();
  const state = useApi<TenantDetail>(`/platform/tenants/${params.id}`);
  const tenant = state.data;
  const back = (
    <Link href="/platform/tenants" className="inline-flex items-center gap-2 text-muted hover:text-ink">
      <ArrowLeft size={18} aria-hidden />
      {t.back}
    </Link>
  );
  if (state.error && !tenant) {
    return (
      <>
        {back}
        <LoadFailure error={state.error} />
      </>
    );
  }
  if (!tenant) {
    return (
      <>
        {back}
        <Skeleton lines={5} />
      </>
    );
  }
  return (
    <>
      {back}
      <PageHeader
        title={tenant.name}
        lead={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge status={tenant.status} />
            <span>{originText(t, tenant.origin)}</span>
            <span className="data">{fill(t.createdOn, { date: formatDateTime(tenant.createdAt, locale) })}</span>
          </span>
        }
      />
      <CompanyPanel tenant={tenant} />
      <PlanPanel tenant={tenant} />
      <PlanChangePanel key={tenant.finops.subscription?.plan ?? "none"} tenant={tenant} reload={state.reload} />
      <div className="grid gap-8 lg:grid-cols-2">
        <StatusPanel tenant={tenant} reload={state.reload} />
        <InvitePanel tenant={tenant} reload={state.reload} />
      </div>
      <HistoryPanel tenant={tenant} />
    </>
  );
}
