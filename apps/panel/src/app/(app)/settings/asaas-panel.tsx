"use client";
import { useEffect, useState } from "react";
import { useDict } from "../../../i18n/provider";
import pt from "../../../i18n/pt-BR/asaas";
import en from "../../../i18n/en/asaas";
import es from "../../../i18n/es/asaas";
import { api, useApi } from "../../../ui/api";
import { ActionStatus, useAction } from "../../../ui/errors";
import { Button, Field, Panel, TextInput } from "../../../ui/kit";
import { useCanConfigure } from "../../../ui/me";

interface View {
  environment: "sandbox" | "production";
  configured: boolean;
  webhookUrl: string;
  mappings: unknown[];
  events: Array<{ id: string; event: string; receivedAt: string; processedAt: string | null }>;
  subscriptions: Array<{ subscriptionId: string; tenantId: string; ownerInviteUrl?: string }>;
}
export function AsaasPanel() {
  const t = useDict(pt, en, es);
  const canConfigure = useCanConfigure();
  const state = useApi<View>(canConfigure ? "/asaas" : null);
  const action = useAction();
  const [environment, setEnvironment] = useState<"sandbox" | "production">("sandbox");
  const [apiKey, setApiKey] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [mappings, setMappings] = useState("[]");
  useEffect(() => { if (state.data) { setEnvironment(state.data.environment); setMappings(JSON.stringify(state.data.mappings, null, 2)); } }, [state.data]);
  // A resposta 403 não revela configuração nem oferece controles a empresas clientes.
  if (!canConfigure || state.error?.status === 403 || !state.data) return null;
  return <Panel title={t.title} description={t.lead}>
    <p className="break-all font-mono text-sm">{state.data.webhookUrl}</p>
    <form className="mt-4 grid gap-4" onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(mappings); } catch { throw new Error(t.invalidMappings); }
        await api("/asaas", { method: "PUT", body: { environment, mappings: parsed, ...(apiKey && { apiKey }), ...(webhookToken && { webhookToken }) } });
        setApiKey(""); setWebhookToken(""); state.reload();
      });
    }}>
      <Field label={t.environment}><select className="rounded-xs border border-line bg-surface p-2" value={environment} onChange={(event) => setEnvironment(event.target.value as "sandbox" | "production")}>
        <option value="sandbox">{t.sandbox}</option><option value="production">{t.production}</option>
      </select></Field>
      <Field label={t.apiKey}><TextInput type="password" autoComplete="off" value={apiKey} placeholder={state.data.configured ? t.kept : undefined} onChange={(event) => setApiKey(event.target.value)} /></Field>
      <Field label={t.webhookToken}><TextInput type="password" autoComplete="off" value={webhookToken} minLength={32} placeholder={state.data.configured ? t.kept : undefined} onChange={(event) => setWebhookToken(event.target.value)} /></Field>
      <p className="text-sm text-muted">{t.mappingHelp}</p>
      <Field label={t.mappings}><textarea className="min-h-32 rounded-xs border border-line bg-surface p-2 font-mono" value={mappings} onChange={(event) => setMappings(event.target.value)} /></Field>
      <div className="flex gap-3"><Button type="submit" busy={action.busy}>{t.save}</Button><Button onClick={() => { void action.run(async () => { await api("/asaas", { method: "POST" }); state.reload(); }); }}>{t.retry}</Button><ActionStatus action={action} /></div>
    </form>
    <h3 className="mt-5 font-semibold">{t.invites}</h3>
    {state.data.subscriptions.map((sub) => <p key={sub.subscriptionId} className="break-all">{sub.subscriptionId}{sub.ownerInviteUrl ? <> · <a href={sub.ownerInviteUrl} className="underline" rel="noreferrer">{t.ownerInvite}</a></> : null}</p>)}
    <h3 className="mt-5 font-semibold">{t.events}</h3>
    {state.data.events.map((event) => <p key={event.id} className="text-sm">{event.event} · {event.processedAt ? t.processed : t.pending}</p>)}
  </Panel>;
}
