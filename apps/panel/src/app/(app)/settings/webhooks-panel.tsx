"use client";

import { useState } from "react";
import commonEn from "../../../i18n/en/common";
import en from "../../../i18n/en/webhooks";
import commonEs from "../../../i18n/es/common";
import es from "../../../i18n/es/webhooks";
import { fill } from "../../../i18n/locales";
import commonPtBR from "../../../i18n/pt-BR/common";
import ptBR from "../../../i18n/pt-BR/webhooks";
import { useDict, useLocale } from "../../../i18n/provider";
import { api, useApi } from "../../../ui/api";
import { ActionStatus, useAction } from "../../../ui/errors";
import { formatDateTime } from "../../../ui/format";
import { Badge, Button, Field, Notice, Panel, Skeleton, Switch, TextInput } from "../../../ui/kit";
import { useCanConfigure } from "../../../ui/me";

type WebhookEvent = "call.ended" | "call.outcome" | "usage.alert" | "cadence.reduced";

interface Subscription {
  id: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  createdAt: string;
  secretRotatedAt: string | null;
  hasQuery: boolean;
}

interface Delivery {
  id: number;
  at: string;
  kind: "webhook_delivered" | "webhook_failed";
  event: string;
  attempt: number;
  status: number | null;
  error: string | null;
  final: boolean;
}

type Pending = { id: string; what: "rotate" | "remove" };

function Deliveries({ id }: { id: string }) {
  const t = useDict(ptBR, en, es);
  const locale = useLocale();
  const deliveries = useApi<{ deliveries: Delivery[] }>(`/webhook-subscriptions/${id}/deliveries`);
  if (deliveries.data === undefined) return <p className="text-muted">{t.deliveriesLoading}</p>;
  if (deliveries.data.deliveries.length === 0) return <p className="text-muted">{t.deliveriesEmpty}</p>;
  return (
    <ul className="grid gap-2">
      {deliveries.data.deliveries.map((delivery) => (
        <li key={delivery.id} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={delivery.kind === "webhook_delivered" ? "ok" : delivery.final ? "fail" : "warn"}>
            {delivery.kind === "webhook_delivered" ? t.delivered : delivery.final ? t.finalFailure : t.failed}
          </Badge>
          <span className="data">{delivery.event}</span>
          <span className="text-muted">
            {[formatDateTime(delivery.at, locale), fill(t.attempt, { n: String(delivery.attempt) }), delivery.status === null ? null : fill(t.httpStatus, { status: String(delivery.status) }), delivery.error]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WebhooksPanel() {
  const t = useDict(ptBR, en, es);
  const common = useDict(commonPtBR, commonEn, commonEs);
  const locale = useLocale();
  const canConfigure = useCanConfigure();
  const list = useApi<{ subscriptions: Subscription[]; events: WebhookEvent[] }>(canConfigure ? "/webhook-subscriptions" : null);
  const create = useAction();
  const toggle = useAction();
  const confirm = useAction();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["call.ended"]);
  // O segredo em claro só existe aqui, na resposta de criar ou de trocar; sai da tela ao recarregar.
  const [secret, setSecret] = useState<{ value: string; rotated: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!canConfigure) return null;
  const flip = (event: WebhookEvent): void => setEvents(events.includes(event) ? events.filter((item) => item !== event) : [...events, event]);

  return (
    <Panel title={t.title} description={t.lead}>
      <form
        className="grid gap-4"
        onSubmit={(submit) => {
          submit.preventDefault();
          void create
            .run(async () => {
              const result = await api<{ secret: string }>("/webhook-subscriptions", { body: { url, events } });
              setSecret({ value: result.secret, rotated: false });
              setCopied(false);
              setUrl("");
            })
            .then(list.reload);
        }}
      >
        <Field label={t.url} hint={t.urlHint}>
          <TextInput className="max-w-xl" type="url" mono value={url} required maxLength={2000} onChange={(input) => setUrl(input.target.value)} />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[0.87rem] font-bold">{t.eventsLabel}</legend>
          {(list.data?.events ?? []).map((event) => (
            <label key={event} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={events.includes(event)} onChange={() => flip(event)} />
              <span>{t.events[event]}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" busy={create.busy} disabled={events.length === 0}>
            {t.create}
          </Button>
          <ActionStatus action={create} />
        </div>
      </form>

      {secret ? (
        <Notice tone="ok">
          <p className="font-bold">{secret.rotated ? t.rotatedTitle : t.createdTitle}</p>
          <p>{secret.rotated ? t.rotatedLead : t.createdLead}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="data break-all">{secret.value}</code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(secret.value).then(() => setCopied(true));
              }}
            >
              {copied ? t.copied : t.copy}
            </Button>
          </div>
        </Notice>
      ) : null}

      {list.data === undefined ? <Skeleton lines={2} /> : null}
      {list.data?.subscriptions.length === 0 ? <p className="text-muted">{t.empty}</p> : null}
      <ul className="grid gap-3">
        {(list.data?.subscriptions ?? []).map((subscription) => (
          <li key={subscription.id} className="grid gap-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="grid gap-1">
                <span className="data break-all font-bold">{subscription.url}</span>
                {subscription.hasQuery ? <span className="text-sm text-muted">{t.queryHidden}</span> : null}
                <span className="text-sm text-muted">
                  {[fill(t.createdAt, { when: formatDateTime(subscription.createdAt, locale) }), subscription.secretRotatedAt ? fill(t.rotatedAt, { when: formatDateTime(subscription.secretRotatedAt, locale) }) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Badge tone={subscription.enabled ? "ok" : "neutral"}>{subscription.enabled ? t.enabled : t.disabled}</Badge>
                  {subscription.events.map((event) => (
                    <Badge key={event} tone="accent">
                      {event}
                    </Badge>
                  ))}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  checked={subscription.enabled}
                  disabled={toggle.busy}
                  label={subscription.enabled ? t.enabled : t.disabled}
                  onChange={(next) => {
                    void toggle.run(() => api(`/webhook-subscriptions/${subscription.id}`, { method: "PATCH", body: { enabled: next } })).then(list.reload);
                  }}
                />
                <Button onClick={() => setOpen(open === subscription.id ? null : subscription.id)}>{open === subscription.id ? t.hideDeliveries : t.showDeliveries}</Button>
                <Button onClick={() => setPending({ id: subscription.id, what: "rotate" })}>{t.rotate}</Button>
                <Button variant="danger" onClick={() => setPending({ id: subscription.id, what: "remove" })}>
                  {t.remove}
                </Button>
              </div>
            </div>
            {open === subscription.id ? <Deliveries id={subscription.id} /> : null}
            {pending?.id === subscription.id ? (
              <Notice tone="fail">
                <p>{fill(pending.what === "rotate" ? t.rotateConfirm : t.removeConfirm, { url: subscription.url })}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    busy={confirm.busy}
                    onClick={() => {
                      void confirm
                        .run(async () => {
                          if (pending.what === "rotate") {
                            const result = await api<{ secret: string }>(`/webhook-subscriptions/${subscription.id}/rotate`, { method: "POST", body: {} });
                            setSecret({ value: result.secret, rotated: true });
                            setCopied(false);
                          } else {
                            await api(`/webhook-subscriptions/${subscription.id}`, { method: "DELETE" });
                          }
                          setPending(null);
                        })
                        .then(list.reload);
                    }}
                  >
                    {pending.what === "rotate" ? t.rotateYes : t.removeYes}
                  </Button>
                  <Button variant="ghost" onClick={() => setPending(null)}>
                    {common.actions.cancel}
                  </Button>
                </div>
                <ActionStatus action={confirm} />
              </Notice>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
