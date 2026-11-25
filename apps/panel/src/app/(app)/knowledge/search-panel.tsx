"use client";

import { MagnifyingGlass } from "@phosphor-icons/react";
import { useState } from "react";
import en from "../../../i18n/en/knowledge";
import es from "../../../i18n/es/knowledge";
import { fill } from "../../../i18n/locales";
import ptBR from "../../../i18n/pt-BR/knowledge";
import { useDict, useLocale } from "../../../i18n/provider";
import { api } from "../../../ui/api";
import { useAction } from "../../../ui/errors";
import { formatCount, formatUsd, similarityPercent, type KnowledgeHitView } from "../../../ui/knowledge";
import { Badge, Button, Field, Notice, Panel, TextInput } from "../../../ui/kit";

interface SearchResult {
  hits: KnowledgeHitView[];
  ms: number;
  tokens: number;
  costMicrocents: number;
}

/** A busca de teste: a mesma pergunta que o agente faria, com os trechos achados, de que fonte e seção vieram. */
export function SearchPanel({ canConfigure, hasReadySource }: { canConfigure: boolean; hasReadySource: boolean }) {
  const t = useDict(ptBR, en, es).search;
  const locale = useLocale();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const run = useAction();
  return (
    <Panel title={t.title} description={t.lead}>
      {!canConfigure ? <Notice>{t.adminOnly}</Notice> : null}
      {canConfigure && !hasReadySource ? <p className="text-muted">{t.noReady}</p> : null}
      {canConfigure && hasReadySource ? (
        <div className="grid gap-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(submit) => {
              submit.preventDefault();
              void run.run(async () => setResult(await api<SearchResult>("/knowledge/search", { body: { question, k: 5 } })));
            }}
          >
            <div className="min-w-[16rem] flex-1">
              <Field label={t.question}>
                <TextInput value={question} required maxLength={500} onChange={(event) => setQuestion(event.target.value)} />
              </Field>
            </div>
            <Button type="submit" variant="primary" busy={run.busy} disabled={question.trim() === ""} icon={<MagnifyingGlass size={18} weight="bold" aria-hidden />}>
              {t.submit}
            </Button>
          </form>
          {run.error ? <Notice tone="fail">{run.error}</Notice> : null}
          {result ? (
            <div className="grid gap-3" aria-live="polite">
              {result.hits.length === 0 ? <p className="text-muted">{t.empty}</p> : <h3 className="font-bold">{fill(t.found, { n: result.hits.length })}</h3>}
              <ol className="grid gap-3">
                {result.hits.map((hit) => (
                  <li key={hit.chunkId} className="grid gap-2 rounded-sm border border-line bg-sunken px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-[0.87rem]">
                      <span className="font-bold">{fill(t.from, { name: hit.sourceName })}</span>
                      {hit.section ? <span className="text-muted">{fill(t.section, { name: hit.section })}</span> : null}
                      {hit.vectorScore !== null ? <Badge tone="accent">{fill(t.similarity, { pct: similarityPercent(hit.vectorScore) })}</Badge> : null}
                      {hit.lexicalRank !== null ? <Badge>{fill(t.words, { n: hit.lexicalRank })}</Badge> : null}
                    </div>
                    <p className="max-w-[80ch] whitespace-pre-line">{hit.content}</p>
                  </li>
                ))}
              </ol>
              <p className="data text-[0.87rem] text-muted">{fill(t.footer, { ms: formatCount(result.ms, locale), tokens: formatCount(result.tokens, locale), cost: formatUsd(result.costMicrocents, locale) })}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
