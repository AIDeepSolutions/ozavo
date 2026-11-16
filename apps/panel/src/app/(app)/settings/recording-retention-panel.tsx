"use client";
import { useCanConfigure } from "../../../ui/me";
import { useState } from "react";
import ptBR from "../../../i18n/pt-BR/recordings";
import en from "../../../i18n/en/recordings";
import es from "../../../i18n/es/recordings";
import { useDict } from "../../../i18n/provider";
import { fill } from "../../../i18n/locales";
import { api, useApi } from "../../../ui/api";
import { useAction, ActionStatus } from "../../../ui/errors";
import { Panel, Field, TextInput, Button, Notice } from "../../../ui/kit";

export function RecordingRetentionPanel({ onChanged }: { onChanged?: () => void }) {
  const canConfigure = useCanConfigure();
  const t = useDict(ptBR, en, es);
  const state = useApi<{ days: number }>(canConfigure ? "/privacy/recordings-retention" : null);
  const action = useAction();
  const [days, setDays] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  function save(next: number) {
    void action.run(() => api("/privacy/recordings-retention", { method: "PUT", body: { days: next } })).then(ok => {
      if (ok) { setConfirming(null); state.reload(); onChanged?.(); }
    });
  }
  if (!canConfigure) return null;
  return <Panel title={t.title} description={t.lead}>
    <form className="grid max-w-xl gap-4" onSubmit={event => {
      event.preventDefault();
      const next = Number(days ?? state.data?.days);
      if (state.data && next < state.data.days) setConfirming(next);
      else save(next);
    }}>
      <Field label={t.days} hint={t.hint}>
        <TextInput aria-label={t.days} type="number" min={90} max={3650} required step={1} value={days ?? String(state.data?.days ?? 90)} onChange={event => setDays(event.target.value)} />
      </Field>
      {confirming === null ? <Button type="submit" busy={action.busy} disabled={!state.data}>{t.save}</Button> : <Notice tone="fail">
        <p>{fill(t.confirm, { days: confirming })}</p><p>{t.confirmBody}</p>
        <Button variant="danger" busy={action.busy} onClick={() => save(confirming)}>{t.yes}</Button>
        <Button variant="ghost" onClick={() => setConfirming(null)}>{t.cancel}</Button>
      </Notice>}
      <ActionStatus action={action} />
    </form>
  </Panel>;
}
