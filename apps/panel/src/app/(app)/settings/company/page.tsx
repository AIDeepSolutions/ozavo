"use client";

import { useEffect, useState } from "react";
import commonEn from "../../../../i18n/en/common";
import en from "../../../../i18n/en/company";
import commonEs from "../../../../i18n/es/common";
import es from "../../../../i18n/es/company";
import { fill } from "../../../../i18n/locales";
import commonPtBR from "../../../../i18n/pt-BR/common";
import ptBR, { type CompanyDictionary } from "../../../../i18n/pt-BR/company";
import { useDict, useLocale } from "../../../../i18n/provider";
import { api, useApi } from "../../../../ui/api";
import { ActionStatus, useAction } from "../../../../ui/errors";
import { formatDateTime } from "../../../../ui/format";
import { Badge, Button, Field, Notice, Panel, Select, Skeleton, TextArea, TextInput } from "../../../../ui/kit";
import { useCanConfigure } from "../../../../ui/me";
import type { Agent } from "../../../../ui/types";

type Scope = keyof CompanyDictionary["scopes"];

interface Profile {
  legalName: string | null;
  cnpj: string | null;
  tradeName: string | null;
  personaName: string;
  defaultVoiceId: string | null;
  basePrompt: string;
  defaultAgentId: string | null;
  planCode: string | null;
  monthlyMinutes: number | null;
  status: "active" | "suspended";
}

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function CompanyProfile({ t }: { t: CompanyDictionary }) {
  const canConfigure = useCanConfigure();
  const profile = useApi<Profile>("/tenant-profile");
  const agents = useApi<Agent[]>("/agents");
  const save = useAction();
  const [form, setForm] = useState<Profile | null>(null);
  useEffect(() => {
    if (profile.data) setForm(profile.data);
  }, [profile.data]);
  if (!form) return <Panel title={t.profileTitle}><Skeleton /></Panel>;
  const set = (patch: Partial<Profile>): void => setForm({ ...form, ...patch });
  const text = (value: string | null): string => value ?? "";

  return (
    <Panel title={t.profileTitle} description={t.profileLead}>
      {form.status === "suspended" ? <Notice tone="fail">{t.suspended}</Notice> : null}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = {
            legalName: form.legalName,
            cnpj: form.cnpj,
            tradeName: form.tradeName,
            personaName: form.personaName,
            defaultVoiceId: form.defaultVoiceId,
            basePrompt: form.basePrompt,
            defaultAgentId: form.defaultAgentId,
          };
          void save.run(() => api("/tenant-profile", { method: "PUT", body })).then(profile.reload);
        }}
      >
        <fieldset disabled={!canConfigure} className="grid gap-4 md:grid-cols-2">
          <Field label={t.legalName}>
            <TextInput value={text(form.legalName)} maxLength={200} onChange={(event) => set({ legalName: event.target.value })} />
          </Field>
          <Field label={t.tradeName}>
            <TextInput value={text(form.tradeName)} maxLength={200} onChange={(event) => set({ tradeName: event.target.value })} />
          </Field>
          <Field label={t.cnpj} hint={t.cnpjHint}>
            <TextInput mono inputMode="numeric" value={text(form.cnpj)} maxLength={18} onChange={(event) => set({ cnpj: event.target.value })} />
          </Field>
          <Field label={t.personaName} hint={t.personaNameHint}>
            <TextInput value={form.personaName} required maxLength={60} onChange={(event) => set({ personaName: event.target.value })} />
          </Field>
          <Field label={t.defaultVoice} hint={t.defaultVoiceHint}>
            <TextInput mono autoComplete="off" value={text(form.defaultVoiceId)} maxLength={200} onChange={(event) => set({ defaultVoiceId: event.target.value })} />
          </Field>
          <Field label={t.defaultAgent} hint={t.defaultAgentHint}>
            <Select value={form.defaultAgentId ?? ""} onChange={(event) => set({ defaultAgentId: event.target.value === "" ? null : event.target.value })}>
              <option value="">{t.noDefaultAgent}</option>
              {(agents.data ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="md:col-span-2">
            <Field label={t.basePrompt} hint={t.basePromptHint}>
              <TextArea value={form.basePrompt} maxLength={8000} rows={6} onChange={(event) => set({ basePrompt: event.target.value })} />
            </Field>
          </div>
        </fieldset>
        <div className="grid gap-1">
          <span className="text-[0.87rem] font-bold">{t.plan}</span>
          <p className="text-muted">
            {form.planCode === null
              ? t.planNone
              : form.monthlyMinutes === null
                ? fill(t.planNoMinutes, { plan: form.planCode })
                : fill(t.planLine, { plan: form.planCode, minutes: form.monthlyMinutes })}
          </p>
        </div>
        {canConfigure ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" busy={save.busy}>
              {t.saveProfile}
            </Button>
            <ActionStatus action={save} />
          </div>
        ) : null}
      </form>
    </Panel>
  );
}

function ApiKeys({ t }: { t: CompanyDictionary }) {
  const common = useDict(commonPtBR, commonEn, commonEs);
  const locale = useLocale();
  const canConfigure = useCanConfigure();
  const keys = useApi<{ keys: ApiKey[]; scopes: Scope[] }>(canConfigure ? "/api-keys" : null);
  const create = useAction();
  const revoke = useAction();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["calls:outbound"]);
  const [created, setCreated] = useState<{ token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  if (!canConfigure) return null;
  const toggle = (scope: Scope): void => setScopes(scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope]);

  return (
    <Panel title={t.keysTitle} description={t.keysLead}>
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create
            .run(async () => {
              const result = await api<{ token: string }>("/api-keys", { body: { name, scopes } });
              setCreated(result);
              setCopied(false);
              setName("");
            })
            .then(keys.reload);
        }}
      >
        <Field label={t.keyName} hint={t.keyNameHint}>
          <TextInput className="max-w-md" value={name} required maxLength={60} onChange={(event) => setName(event.target.value)} />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[0.87rem] font-bold">{t.scopesLabel}</legend>
          {(keys.data?.scopes ?? []).map((scope) => (
            <label key={scope} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
              <span>
                <span className="data">{scope}</span> — {t.scopes[scope]}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" busy={create.busy} disabled={scopes.length === 0}>
            {t.createKey}
          </Button>
          <ActionStatus action={create} />
        </div>
      </form>
      {created ? (
        <Notice tone="ok">
          <p className="font-bold">{t.createdTitle}</p>
          <p>{t.createdLead}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="data break-all">{created.token}</code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(created.token).then(() => setCopied(true));
              }}
            >
              {copied ? t.copied : t.copy}
            </Button>
          </div>
        </Notice>
      ) : null}
      {keys.data === undefined ? <Skeleton lines={2} /> : null}
      {keys.data?.keys.length === 0 ? <p className="text-muted">{t.keysEmpty}</p> : null}
      <ul className="grid gap-3">
        {(keys.data?.keys ?? []).map((key) => (
          <li key={key.id} className="grid gap-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="grid gap-1">
                <span className="font-bold">{key.name}</span>
                <span className="text-sm text-muted">
                  {[
                    fill(t.keyCreatedAt, { prefix: key.prefix, when: formatDateTime(key.createdAt, locale) }),
                    key.lastUsedAt ? fill(t.keyLastUsed, { when: formatDateTime(key.lastUsedAt, locale) }) : t.keyNeverUsed,
                    key.revokedAt ? fill(t.keyRevokedAt, { when: formatDateTime(key.revokedAt, locale) }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="flex flex-wrap gap-1">
                  {key.scopes.map((scope) => (
                    <Badge key={scope} tone={key.revokedAt ? "neutral" : "accent"}>
                      {scope}
                    </Badge>
                  ))}
                </span>
              </div>
              {key.revokedAt === null ? (
                <Button variant="danger" onClick={() => setRevoking(revoking === key.id ? null : key.id)}>
                  {t.revoke}
                </Button>
              ) : null}
            </div>
            {revoking === key.id ? (
              <Notice tone="fail">
                <p>{fill(t.revokeConfirm, { name: key.name })}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    busy={revoke.busy}
                    onClick={() => {
                      void revoke.run(() => api(`/api-keys/${key.id}`, { method: "DELETE" })).then(() => {
                        setRevoking(null);
                        keys.reload();
                      });
                    }}
                  >
                    {fill(t.revokeYes, { name: key.name })}
                  </Button>
                  <Button variant="ghost" onClick={() => setRevoking(null)}>
                    {common.actions.cancel}
                  </Button>
                </div>
                <ActionStatus action={revoke} />
              </Notice>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export default function CompanySettings() {
  const t = useDict(ptBR, en, es);
  return (
    <>
      <CompanyProfile t={t} />
      <ApiKeys t={t} />
    </>
  );
}
