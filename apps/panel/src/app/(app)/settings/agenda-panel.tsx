"use client";

import { Plus, X } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import commonEn from "../../../i18n/en/common";
import en from "../../../i18n/en/company";
import commonEs from "../../../i18n/es/common";
import es from "../../../i18n/es/company";
import { fill } from "../../../i18n/locales";
import commonPtBR from "../../../i18n/pt-BR/common";
import ptBR, { type CompanyDictionary } from "../../../i18n/pt-BR/company";
import { useDict } from "../../../i18n/provider";
import { api, useApi } from "../../../ui/api";
import { ActionStatus, useAction } from "../../../ui/errors";
import { Button, Field, Notice, Panel, Select, Skeleton, TextArea, TextInput } from "../../../ui/kit";
import { useCanConfigure } from "../../../ui/me";
import type { Setting } from "../../../ui/types";
import { put } from "./setting-api";

type AgendaType = keyof CompanyDictionary["agendaTypes"];
type FailReason = keyof CompanyDictionary["authorizeFailed"];

interface Service {
  name: string;
  /** O id do tipo de evento (Cal.com) ou a duração em minutos (Google), como texto do campo. */
  value: string;
}

/** O que a API devolve da agenda salva: dos segredos, só se existem. */
type Stored =
  | { type: "calcom"; timezone: string; services: Array<{ name: string; eventTypeId: number }>; apiKey: { configured: boolean } }
  | {
      type: "google_calendar";
      clientId: string;
      calendarId: string;
      timezone: string;
      workStart: string;
      workEnd: string;
      workDays: number[];
      slotMinutes: number;
      services: Array<{ name: string; durationMinutes: number }>;
      clientSecret: { configured: boolean };
      authorized: boolean;
    }
  | {
      type: "google_service_account";
      clientEmail: string;
      calendarId: string;
      timezone: string;
      workStart: string;
      workEnd: string;
      workDays: number[];
      slotMinutes: number;
      services: Array<{ name: string; durationMinutes: number }>;
      keyFile: { configured: boolean };
    };

const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const FAIL_REASONS = new Set<string>(["denied", "invalid_state", "session", "not_google", "exchange", "changed"]);

export function AgendaPanel() {
  const t = useDict(ptBR, en, es);
  const common = useDict(commonPtBR, commonEn, commonEs);
  const canConfigure = useCanConfigure();
  const search = useSearchParams();
  const stored = useApi<Setting<Stored>>("/settings/agenda.connector");
  const save = useAction();
  const authorize = useAction();
  const remove = useAction();
  const [type, setType] = useState<AgendaType>("none");
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [secret, setSecret] = useState("");
  const [clientId, setClientId] = useState("");
  // A conta de serviço gravada: o e-mail volta da API; a chave, nunca.
  const [clientEmail, setClientEmail] = useState("");
  const [calendarId, setCalendarId] = useState("primary");
  const [workStart, setWorkStart] = useState("09:00");
  const [workEnd, setWorkEnd] = useState("18:00");
  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [slotMinutes, setSlotMinutes] = useState("30");
  const [services, setServices] = useState<Service[]>([]);
  const [removing, setRemoving] = useState(false);
  const [redirectUri, setRedirectUri] = useState("");

  useEffect(() => {
    const value = stored.data?.value;
    if (!value) return;
    setType(value.type);
    setTimezone(value.timezone);
    setSecret("");
    if (value.type === "calcom") {
      setServices(value.services.map((service) => ({ name: service.name, value: String(service.eventTypeId) })));
    } else {
      if (value.type === "google_calendar") setClientId(value.clientId);
      else setClientEmail(value.clientEmail);
      setCalendarId(value.calendarId);
      setWorkStart(value.workStart);
      setWorkEnd(value.workEnd);
      setWorkDays(value.workDays);
      setSlotMinutes(String(value.slotMinutes));
      setServices(value.services.map((service) => ({ name: service.name, value: String(service.durationMinutes) })));
    }
  }, [stored.data]);

  // O endereço de retorno para cadastrar no Google é o desta instalação.
  useEffect(() => {
    setRedirectUri(`${window.location.origin}/api/v1/connectors/google/callback`);
  }, []);

  if (stored.data === undefined) return <Panel title={t.agendaTitle}><Skeleton /></Panel>;
  const current = stored.data.value;
  const result = search.get("agenda");
  const reason = search.get("reason") ?? "";

  const setService = (index: number, patch: Partial<Service>): void => setServices(services.map((service, position) => (position === index ? { ...service, ...patch } : service)));
  const body = (): unknown =>
    type === "calcom"
      ? { type, timezone, ...(secret && { apiKey: secret }), services: services.map((service) => ({ name: service.name, eventTypeId: Number(service.value) })) }
      : {
          type,
          ...(type === "google_service_account" ? { ...(secret ? { keyFile: secret } : { clientEmail }) } : { clientId, ...(secret && { clientSecret: secret }) }),
          calendarId,
          timezone,
          workStart,
          workEnd,
          workDays,
          slotMinutes: Number(slotMinutes),
          services: services.map((service) => ({ name: service.name, durationMinutes: Number(service.value) })),
        };

  return (
    <Panel title={t.agendaTitle} description={t.agendaLead}>
      {result === "authorized" ? <Notice tone="ok">{t.authorizedNow}</Notice> : null}
      {result === "failed" ? <Notice tone="fail">{t.authorizeFailed[(FAIL_REASONS.has(reason) ? reason : "exchange") as FailReason]}</Notice> : null}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save.run(() => put("agenda.connector", body())).then(stored.reload);
        }}
      >
        <fieldset disabled={!canConfigure} className="grid gap-4">
          <Field label={t.agendaType}>
            <Select className="max-w-md" value={type} onChange={(event) => setType(event.target.value as AgendaType)}>
              {(Object.keys(t.agendaTypes) as AgendaType[]).map((option) => (
                <option key={option} value={option} disabled={option === "none" && current !== null}>
                  {t.agendaTypes[option]}
                </option>
              ))}
            </Select>
          </Field>
          {type === "none" ? null : (
            <>
              {type === "calcom" ? (
                <Field label={t.calcomKey} hint={t.calcomKeyHint}>
                  <TextInput
                    mono
                    type="password"
                    autoComplete="off"
                    className="max-w-md"
                    placeholder={current?.type === "calcom" && current.apiKey.configured ? t.keyKept : undefined}
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </Field>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {type === "google_service_account" ? (
                    <div className="grid gap-2 md:col-span-2">
                      <Field label={t.serviceAccountKey} hint={t.serviceAccountKeyHint}>
                        <TextArea className="data" autoComplete="off" spellCheck={false} rows={4} value={secret} required={!(current?.type === "google_service_account" && current.keyFile.configured)} onChange={(event) => setSecret(event.target.value)} />
                      </Field>
                      {current?.type === "google_service_account" ? (
                        <>
                          <p className="text-sm text-muted">{fill(t.serviceAccountKept, { email: current.clientEmail })}</p>
                          <Notice tone="warn">{fill(t.serviceAccountShare, { email: current.clientEmail })}</Notice>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <Field label={t.googleClientId} hint={fill(t.googleClientHint, { uri: redirectUri })}>
                        <TextInput mono autoComplete="off" value={clientId} required onChange={(event) => setClientId(event.target.value)} />
                      </Field>
                      <Field label={t.googleClientSecret}>
                    <TextInput
                      mono
                      type="password"
                      autoComplete="off"
                      placeholder={current?.type === "google_calendar" && current.clientSecret.configured && current.clientId === clientId ? t.keyKept : undefined}
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                    />
                      </Field>
                    </>
                  )}
                  <Field label={t.calendarId} hint={type === "google_service_account" ? t.serviceAccountCalendarHint : t.calendarIdHint}>
                    <TextInput mono value={calendarId} required onChange={(event) => setCalendarId(event.target.value)} />
                  </Field>
                  <Field label={t.slotMinutes}>
                    <TextInput type="number" min={5} max={480} value={slotMinutes} required onChange={(event) => setSlotMinutes(event.target.value)} />
                  </Field>
                  <Field label={t.workStart}>
                    <TextInput type="time" value={workStart} required onChange={(event) => setWorkStart(event.target.value)} />
                  </Field>
                  <Field label={t.workEnd}>
                    <TextInput type="time" value={workEnd} required onChange={(event) => setWorkEnd(event.target.value)} />
                  </Field>
                  <fieldset className="md:col-span-2">
                    <legend className="mb-1 text-[0.87rem] font-bold">{t.workDays}</legend>
                    <div className="flex flex-wrap gap-3">
                      {t.weekdays.map((label, day) => (
                        <label key={label} className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={workDays.includes(day)}
                            onChange={() => setWorkDays(workDays.includes(day) ? workDays.filter((item) => item !== day) : [...workDays, day].sort())}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>
              )}
              <Field label={t.timezone}>
                <TextInput mono className="max-w-md" value={timezone} required onChange={(event) => setTimezone(event.target.value)} />
              </Field>
              <fieldset className="grid gap-3">
                <legend className="mb-1 text-[0.87rem] font-bold">{t.services}</legend>
                <p className="text-sm text-muted">{t.servicesHint}</p>
                {services.map((service, index) => (
                  <div key={index} className="grid items-end gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]">
                    <Field label={t.serviceName}>
                      <TextInput value={service.name} required maxLength={80} onChange={(event) => setService(index, { name: event.target.value })} />
                    </Field>
                    <Field label={type === "calcom" ? t.eventTypeId : t.duration}>
                      <TextInput type="number" min={1} value={service.value} required onChange={(event) => setService(index, { value: event.target.value })} />
                    </Field>
                    <button
                      type="button"
                      aria-label={fill(t.removeService, { name: service.name })}
                      className="grid size-10 cursor-pointer place-items-center rounded-xs text-muted hover:bg-sunken hover:text-fail"
                      onClick={() => setServices(services.filter((_, position) => position !== index))}
                    >
                      <X size={16} weight="bold" aria-hidden />
                    </button>
                  </div>
                ))}
                <div>
                  <Button variant="ghost" icon={<Plus size={18} weight="bold" aria-hidden />} onClick={() => setServices([...services, { name: "", value: type === "calcom" ? "" : slotMinutes }])}>
                    {t.addService}
                  </Button>
                </div>
              </fieldset>
            </>
          )}
        </fieldset>
        {canConfigure && type !== "none" ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" busy={save.busy}>
              {t.saveAgenda}
            </Button>
            <ActionStatus action={save} />
          </div>
        ) : null}
      </form>
      {current?.type === "google_calendar" ? (
        <div className="grid gap-2">
          <Notice tone={current.authorized ? "ok" : "warn"}>{current.authorized ? t.authorized : t.notAuthorized}</Notice>
          {canConfigure ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                busy={authorize.busy}
                onClick={() => {
                  void authorize.run(async () => {
                    const { url } = await api<{ url: string }>("/connectors/google/authorize", { method: "POST" });
                    window.location.assign(url);
                  });
                }}
              >
                {current.authorized ? t.reauthorize : t.authorize}
              </Button>
              <ActionStatus action={authorize} />
            </div>
          ) : null}
        </div>
      ) : null}
      {canConfigure && current !== null ? (
        <div className="grid gap-2">
          {removing ? (
            <Notice tone="fail">
              <p>{t.removeAgendaConfirm}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  busy={remove.busy}
                  onClick={() => {
                    void remove.run(() => put("agenda.connector", null)).then(() => {
                      setRemoving(false);
                      setType("none");
                      setServices([]);
                      stored.reload();
                    });
                  }}
                >
                  {t.removeAgendaYes}
                </Button>
                <Button variant="ghost" onClick={() => setRemoving(false)}>
                  {common.actions.cancel}
                </Button>
              </div>
              <ActionStatus action={remove} />
            </Notice>
          ) : (
            <div>
              <Button variant="danger" onClick={() => setRemoving(true)}>
                {t.removeAgenda}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </Panel>
  );
}
