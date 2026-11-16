"use client";
import { useState } from "react";
import ptBR from "../../../i18n/pt-BR/rcd";
import en from "../../../i18n/en/rcd";
import es from "../../../i18n/es/rcd";
import { fill } from "../../../i18n/locales";
import { useDict } from "../../../i18n/provider";
import { api, useApi } from "../../../ui/api";
import { useAction, ActionStatus } from "../../../ui/errors";
import { useCanConfigure } from "../../../ui/me";
import { Panel, Field, Button } from "../../../ui/kit";
import type { Trunk } from "../../../ui/types";

export function RcdLogoPanel({ trunk }: { trunk: Trunk }) {
  const t = useDict(ptBR, en, es);
  const canConfigure = useCanConfigure();
  const state = useApi<{ logo: string | null }>(canConfigure ? `/trunks/${trunk.id}/rcd-logo` : null);
  const action = useAction();
  const [file, setFile] = useState<File | null>(null);
  if (!canConfigure) return null;
  return <Panel title={fill(t.title, { line: trunk.name })} description={t.hint}>
    <form className="grid gap-3" onSubmit={event => {
      event.preventDefault();
      if (!file) return;
      void action.run(async () => {
        const image = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error(t.error));
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.readAsDataURL(file);
        });
        await api(`/trunks/${trunk.id}/rcd-logo`, { method: "PUT", body: { image } });
        state.reload();
      });
    }}>
      <Field label={t.label}><input aria-label={t.label} type="file" accept="image/png,image/jpeg,image/bmp" required onChange={event => setFile(event.target.files?.[0] ?? null)} /></Field>
      <Button type="submit" busy={action.busy} disabled={!file}>{t.save}</Button>
      <ActionStatus action={action} />
      {state.data?.logo ? <a href={`data:image/png;base64,${state.data.logo}`} download="rcd-256.png">{t.download}</a> : null}
    </form>
  </Panel>;
}
