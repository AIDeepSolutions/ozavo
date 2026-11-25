"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import en from "../../../../i18n/en/knowledge";
import es from "../../../../i18n/es/knowledge";
import { fill } from "../../../../i18n/locales";
import ptBR from "../../../../i18n/pt-BR/knowledge";
import { useDict, useLocale } from "../../../../i18n/provider";
import { api, useApi } from "../../../../ui/api";
import { ActionStatus, useAction } from "../../../../ui/errors";
import { chosenTokens, formatCount, resolveMode, type KnowledgeAgentView, type KnowledgeMode, type KnowledgeSourceView } from "../../../../ui/knowledge";
import { Badge, Button, Notice, Panel, Skeleton, Switch } from "../../../../ui/kit";
import { useCanConfigure } from "../../../../ui/me";

const MODES: readonly KnowledgeMode[] = ["auto", "rag", "full"];

/**
 * As bases que o agente consulta, o modo e "responder só com o que está na base". Grava por conta própria
 * (`PUT /agents/[id]/knowledge`): o vínculo não faz parte dos campos do agente.
 */
export function AgentKnowledgePanel({ agentId }: { agentId: string }) {
  const t = useDict(ptBR, en, es);
  const k = t.agent;
  const locale = useLocale();
  const canConfigure = useCanConfigure();
  const sources = useApi<{ sources: KnowledgeSourceView[] }>("/knowledge");
  const saved = useApi<KnowledgeAgentView>(`/agents/${agentId}/knowledge`);
  const save = useAction();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<KnowledgeMode>("auto");
  const [only, setOnly] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [limit, setLimit] = useState<number | null>(null);

  useEffect(() => {
    if (saved.data) {
      setChosen(new Set(saved.data.linkedIds));
      setMode(saved.data.mode);
      setOnly(saved.data.only);
      setLimit(saved.data.fullPromptMaxTokens);
      setDirty(false);
    }
  }, [saved.data]);

  const all = sources.data?.sources;
  if (!all || !saved.data || limit === null) {
    return (
      <Panel title={k.title} description={k.lead}>
        <Skeleton lines={2} />
      </Panel>
    );
  }
  const total = chosenTokens(all, chosen);
  const effective = resolveMode(mode, total, limit);
  const edit = (change: () => void): void => {
    change();
    setDirty(true);
  };
  const toggle = (id: string): void =>
    edit(() => {
      const next = new Set(chosen);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setChosen(next);
    });

  return (
    <Panel title={k.title} description={k.lead}>
      {all.length === 0 ? (
        <div className="grid justify-items-start gap-2">
          <p className="text-muted">{k.noSources}</p>
          <Link href="/knowledge" className="font-bold underline underline-offset-4">
            {k.manage}
          </Link>
        </div>
      ) : (
        <div className="grid gap-6">
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-[0.87rem] font-bold">{k.sources}</legend>
            <ul className="grid gap-1">
              {all.map((source) => (
                <li key={source.id}>
                  <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 rounded-sm px-3 py-2.5 transition-colors duration-[120ms] hover:bg-sunken has-checked:bg-sunken">
                    <input type="checkbox" className="mt-1 size-4 accent-(--oz-accent)" checked={chosen.has(source.id)} onChange={() => toggle(source.id)} />
                    <span className="grid min-w-0">
                      <span className="font-medium break-words">{source.name}</span>
                      <span className="data text-[0.87rem] text-muted">{fill(t.list.tokens, { n: formatCount(source.tokenCount, locale) })}</span>
                    </span>
                    {source.currentVersionId === null ? <Badge tone={source.status === "failed" ? "fail" : "neutral"}>{k.notReady}</Badge> : null}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[0.87rem] font-bold">{k.modeLabel}</legend>
            {MODES.map((option) => (
              <label key={option} className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-sm px-3 py-2.5 transition-colors duration-[120ms] hover:bg-sunken has-checked:bg-sunken">
                <input type="radio" name={`knowledge-mode-${agentId}`} className="mt-1 size-4 accent-(--oz-accent)" checked={mode === option} onChange={() => edit(() => setMode(option))} />
                <span className="font-medium">{k.modes[option]}</span>
                <span className="col-start-2 max-w-[70ch] text-[0.87rem] text-muted">{fill(k.modeHints[option], { limit: formatCount(limit, locale) })}</span>
              </label>
            ))}
          </fieldset>

          <div className="grid gap-2">
            <p className="data text-muted">{fill(k.total, { total: formatCount(total, locale), limit: formatCount(limit, locale) })}</p>
            {mode === "auto" ? <p className="text-muted">{fill(k.autoWillUse, { mode: k.modes[effective] })}</p> : null}
            {mode === "full" && total > limit ? <Notice tone="warn">{fill(k.fullTooBig, { total: formatCount(total, locale), limit: formatCount(limit, locale) })}</Notice> : null}
          </div>

          <div className="grid gap-1.5 border-t border-line pt-5">
            <Switch checked={only} onChange={(next) => edit(() => setOnly(next))} label={k.onlyLabel} />
            <p className="max-w-[70ch] text-[0.87rem] text-muted">{k.onlyHint}</p>
            {only && chosen.size === 0 ? <Notice tone="warn">{k.onlyNoSources}</Notice> : null}
          </div>

          {canConfigure ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                busy={save.busy}
                onClick={() =>
                  void save.run(async () => {
                    await api(`/agents/${agentId}/knowledge`, { method: "PUT", body: { sourceIds: [...chosen], mode, only } });
                    saved.reload();
                  })
                }
              >
                {k.save}
              </Button>
              {dirty && !save.busy && !save.done ? <span className="text-muted">{k.unsaved}</span> : null}
              <ActionStatus action={save} />
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
