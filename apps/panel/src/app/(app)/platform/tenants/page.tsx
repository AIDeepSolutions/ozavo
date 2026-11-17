"use client";

import { Buildings, Plus } from "@phosphor-icons/react";
import Link from "next/link";
import { fill } from "../../../../i18n/locales";
import { useLocale } from "../../../../i18n/provider";
import { useApi } from "../../../../ui/api";
import { formatDateTime } from "../../../../ui/format";
import { Badge, EmptyState, PageHeader, Skeleton, buttonClass } from "../../../../ui/kit";
import { formatCnpj, type TenantRow } from "../../../../ui/platform-tenants";
import { LoadFailure, StatusBadge, UsageMeter, inviteText, originText, planText, useTenantsDict } from "./shared";

export default function TenantsPage() {
  const t = useTenantsDict();
  const locale = useLocale();
  const state = useApi<TenantRow[]>("/platform/tenants");
  const newButton = (
    <Link href="/platform/tenants/new" className={buttonClass("primary")}>
      <Plus size={18} weight="bold" aria-hidden />
      {t.newCompany}
    </Link>
  );

  if (state.error && !state.data) return <LoadFailure error={state.error} />;
  const rows = state.data;
  const count = (status: TenantRow["status"]): number => (rows ?? []).filter((row) => row.status === status).length;

  return (
    <>
      <PageHeader title={t.title} lead={t.lead} actions={newButton} />
      {!rows ? <Skeleton lines={4} /> : null}
      {rows && rows.length === 0 ? (
        <EmptyState icon={<Buildings size={32} weight="duotone" aria-hidden />} title={t.emptyTitle} action={newButton}>
          <p>{t.emptyBody}</p>
        </EmptyState>
      ) : null}
      {rows && rows.length > 0 ? (
        <section className="grid gap-3 rounded-md border border-line bg-surface p-5">
          <p className="text-muted">{fill(t.summary, { n: rows.length, active: count("active"), suspended: count("suspended"), cancelled: count("cancelled") })}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[0.92rem]">
              <caption className="sr-only">{t.title}</caption>
              <thead className="text-[0.8rem] font-bold text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4">{t.columns.company}</th>
                  <th scope="col" className="py-2 pr-4">{t.columns.plan}</th>
                  <th scope="col" className="py-2 pr-4">{t.columns.status}</th>
                  <th scope="col" className="py-2 pr-4">{t.columns.origin}</th>
                  <th scope="col" className="py-2 pr-4">{t.columns.usage}</th>
                  <th scope="col" className="py-2 pr-4">{t.columns.alerts}</th>
                  <th scope="col" className="py-2 pr-4">{t.columns.lines}</th>
                  <th scope="col" className="py-2 pr-4">{t.columns.createdAt}</th>
                  <th scope="col" className="py-2">{t.columns.ownerInvite}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((row) => {
                  const invite = inviteText(t, row.ownerInvite, locale);
                  return (
                    <tr key={row.organizationId} className="align-top">
                      <th scope="row" className="py-3 pr-4 font-bold">
                        <Link href={`/platform/tenants/${row.organizationId}`} aria-label={fill(t.open, { name: row.name })} className="underline-offset-4 hover:underline">
                          {row.name}
                        </Link>
                        {row.cnpj ? <span className="data block text-[0.8rem] font-normal whitespace-nowrap text-muted">{formatCnpj(row.cnpj)}</span> : null}
                      </th>
                      <td className="py-3 pr-4">{planText(t, row.planCode)}</td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="py-3 pr-4">{originText(t, row.origin)}</td>
                      <td className="py-3 pr-4">
                        <UsageMeter usage={row.usage} />
                      </td>
                      <td className="py-3 pr-4">
                        <span className="flex flex-wrap gap-1">
                          {row.usageAlert !== null ? <Badge tone={row.usageAlert >= 100 ? "fail" : "warn"}>{fill(t.listAlert.usage, { n: row.usageAlert })}</Badge> : null}
                          {row.activeBreakers > 0 ? <Badge tone="fail">{fill(t.listAlert.breaker, { n: row.activeBreakers })}</Badge> : null}
                          {row.usageAlert === null && row.activeBreakers === 0 ? <span className="text-muted">{t.listAlert.none}</span> : null}
                        </span>
                      </td>
                      <td className="data py-3 pr-4">{row.lines.toLocaleString(locale)}</td>
                      <td className="data py-3 pr-4 whitespace-nowrap">{formatDateTime(row.createdAt, locale)}</td>
                      <td className="py-3">
                        <Badge tone={invite.tone}>{invite.text}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
