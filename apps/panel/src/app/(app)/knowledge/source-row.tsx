"use client";

import { ArrowsClockwise, FileArrowUp, FileDoc, FilePdf, FileText, PencilSimple, TextAa, Trash } from "@phosphor-icons/react";
import { useRef, useState, type ReactNode } from "react";
import commonEn from "../../../i18n/en/common";
import en from "../../../i18n/en/knowledge";
import commonEs from "../../../i18n/es/common";
import es from "../../../i18n/es/knowledge";
import { fill } from "../../../i18n/locales";
import commonPtBR from "../../../i18n/pt-BR/common";
import ptBR from "../../../i18n/pt-BR/knowledge";
import { useDict, useLocale } from "../../../i18n/provider";
import { api, apiForm } from "../../../ui/api";
import { ActionStatus, useAction } from "../../../ui/errors";
import { formatDateTime } from "../../../ui/format";
import { formatCompactCount, formatCount, formatUsd, type KnowledgeKind, type KnowledgeSourceView, type KnowledgeStatus, type KnowledgeUsageView } from "../../../ui/knowledge";
import { Badge, Button, Field, Notice, TextArea, TextInput, type Tone } from "../../../ui/kit";
import { UploadStatus, useFileUploads } from "./add-panel";

const KIND_ICON: Record<KnowledgeKind, ReactNode> = {
  pdf: <FilePdf size={22} weight="duotone" aria-hidden />,
  docx: <FileDoc size={22} weight="duotone" aria-hidden />,
  md: <FileText size={22} weight="duotone" aria-hidden />,
  txt: <FileText size={22} weight="duotone" aria-hidden />,
  text: <TextAa size={22} weight="duotone" aria-hidden />,
};
const STATUS_TONE: Record<KnowledgeStatus, Tone> = { queued: "neutral", processing: "accent", ready: "ok", failed: "fail" };

type Editor = "rename" | "replace" | "remove" | null;

/** Uma fonte da lista: o estado, os números e as quatro ações (reindexar, substituir, renomear, apagar). */
export function SourceRow({ source, usage, canConfigure, onChanged }: { source: KnowledgeSourceView; usage: KnowledgeUsageView | undefined; canConfigure: boolean; onChanged: () => void }) {
  const t = useDict(ptBR, en, es);
  const common = useDict(commonPtBR, commonEn, commonEs);
  const locale = useLocale();
  const [editor, setEditor] = useState<Editor>(null);
  const [name, setName] = useState(source.name);
  const [text, setText] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const reindex = useAction();
  const rename = useAction();
  const replaceText = useAction();
  const remove = useAction();
  const replaceFile = useFileUploads(
    usage?.limits.maxFileBytes,
    (chosen) => {
      const form = new FormData();
      form.set("file", chosen);
      return apiForm(`/knowledge/${source.id}/replace`, form);
    },
    () => {
      setEditor(null);
      onChanged();
    },
  );
  const open = (next: Exclude<Editor, null>): void => {
    setEditor(editor === next ? null : next);
    setName(source.name);
    setText("");
  };
  const failedReason = source.status === "failed" ? fill(Object.hasOwn(t.errorCodes, source.errorCode ?? "") ? t.errorCodes[source.errorCode as keyof typeof t.errorCodes] : t.errorCodes.fallback, limitsFor(usage, locale)) : null;
  const agents = source.agentCount === 0 ? t.list.agentsNone : source.agentCount === 1 ? t.list.agentsOne : fill(t.list.agentsMany, { n: source.agentCount });
  const removeAgents = source.agentCount === 0 ? t.remove.agentsNone : source.agentCount === 1 ? t.remove.agentsOne : fill(t.remove.agentsMany, { n: source.agentCount });
  const busyIndexing = source.status === "queued" || source.status === "processing";

  return (
    <li className="grid gap-3 border-b border-line px-5 py-4 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 text-muted">{KIND_ICON[source.kind]}</span>
          <div className="grid min-w-0 gap-1">
            <span className="text-[1.07rem] font-bold break-words">{source.name}</span>
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[source.status]} live={source.status === "processing"}>
                {t.status[source.status]}
              </Badge>
              <Badge>{t.kinds[source.kind]}</Badge>
              {source.originalFilename ? <span className="text-[0.87rem] text-muted break-all">{fill(t.list.file, { name: source.originalFilename })}</span> : null}
            </span>
          </div>
        </div>
        {canConfigure ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button busy={reindex.busy} disabled={busyIndexing} icon={<ArrowsClockwise size={18} weight="bold" aria-hidden />} onClick={() => void reindex.run(() => api(`/knowledge/${source.id}/reindex`, { method: "POST", body: {} })).then((ok) => ok && onChanged())}>
              {t.actions.reindex}
            </Button>
            <Button aria-expanded={editor === "replace"} icon={<FileArrowUp size={18} weight="bold" aria-hidden />} onClick={() => open("replace")}>
              {t.actions.replace}
            </Button>
            <Button aria-expanded={editor === "rename"} icon={<PencilSimple size={18} weight="bold" aria-hidden />} onClick={() => open("rename")}>
              {t.actions.rename}
            </Button>
            <Button variant="danger" aria-expanded={editor === "remove"} icon={<Trash size={18} weight="bold" aria-hidden />} onClick={() => open("remove")}>
              {t.actions.remove}
            </Button>
          </div>
        ) : null}
      </div>

      {failedReason ? <Notice tone="fail">{failedReason}</Notice> : null}
      {source.status !== "ready" && source.status !== "failed" ? <p className="text-[0.87rem] text-muted">{source.currentVersionId ? t.list.keepsAnswering : t.list.notYetAnswering}</p> : null}
      {source.status === "failed" && source.currentVersionId ? <p className="text-[0.87rem] text-muted">{t.list.keepsAnswering}</p> : null}

      <p className="data flex flex-wrap gap-x-4 gap-y-1 text-[0.87rem] text-muted">
        <span>{fill(t.list.tokens, { n: formatCount(source.tokenCount, locale) })}</span>
        <span>{source.chunkCount === 1 ? t.list.chunksOne : fill(t.list.chunks, { n: formatCount(source.chunkCount, locale) })}</span>
        <span>{fill(t.list.cost, { cost: formatUsd(source.indexCostMicrocents, locale) })}</span>
        <span>{fill(t.list.version, { n: source.latestVersion })}</span>
        <span>{agents}</span>
        <span>{fill(t.list.createdAt, { when: formatDateTime(source.createdAt, locale) })}</span>
        {source.indexedAt ? <span>{fill(t.list.indexedAt, { when: formatDateTime(source.indexedAt, locale) })}</span> : null}
      </p>
      <ActionStatus action={reindex} />

      {editor === "rename" ? (
        <form
          className="grid gap-3 border-t border-line pt-3"
          onSubmit={(submit) => {
            submit.preventDefault();
            void rename.run(() => api(`/knowledge/${source.id}`, { method: "PATCH", body: { name } })).then((ok) => {
              if (ok) {
                setEditor(null);
                onChanged();
              }
            });
          }}
        >
          <Field label={t.rename.label}>
            <TextInput className="max-w-xl" value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" busy={rename.busy}>
              {t.actions.save}
            </Button>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              {common.actions.cancel}
            </Button>
            <ActionStatus action={rename} />
          </div>
        </form>
      ) : null}

      {editor === "replace" ? (
        <div className="grid gap-3 border-t border-line pt-3">
          <h3 className="font-bold">{fill(t.replace.title, { name: source.name })}</h3>
          <p className="max-w-[64ch] text-muted">{fill(t.replace.lead, { n: source.latestVersion + 1 })}</p>
          <input
            ref={file}
            type="file"
            accept=".pdf,.docx,.md,.markdown,.txt"
            aria-label={t.replace.file}
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              void replaceFile.run([...(event.target.files ?? [])].slice(0, 1));
              event.target.value = "";
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" busy={replaceFile.busy} icon={<FileArrowUp size={18} weight="bold" aria-hidden />} onClick={() => file.current?.click()}>
              {t.actions.send}
            </Button>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              {common.actions.cancel}
            </Button>
          </div>
          <UploadStatus failures={replaceFile.failures} sent={replaceFile.sent} />
          <form
            className="grid gap-3"
            onSubmit={(submit) => {
              submit.preventDefault();
              void replaceText.run(() => api(`/knowledge/${source.id}/replace`, { body: { text } })).then((ok) => {
                if (ok) {
                  setEditor(null);
                  onChanged();
                }
              });
            }}
          >
            <Field label={t.replace.orPaste}>
              <TextArea aria-label={t.replace.pasteLabel} value={text} rows={5} onChange={(event) => setText(event.target.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" busy={replaceText.busy} disabled={text.trim() === ""}>
                {t.replace.pasteSubmit}
              </Button>
              <ActionStatus action={replaceText} />
            </div>
          </form>
        </div>
      ) : null}

      {editor === "remove" ? (
        <Notice tone="fail">
          <p>{fill(t.remove.confirm, { name: source.name, agents: removeAgents })}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <Button
              variant="danger"
              busy={remove.busy}
              onClick={() =>
                void remove.run(() => api(`/knowledge/${source.id}`, { method: "DELETE" })).then((ok) => {
                  if (ok) onChanged();
                })
              }
            >
              {fill(t.remove.yes, { name: source.name })}
            </Button>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              {common.actions.cancel}
            </Button>
          </div>
          <ActionStatus action={remove} />
        </Notice>
      ) : null}
    </li>
  );
}

/** Os números que as frases de falha citam (teto da fonte e da empresa). */
function limitsFor(usage: KnowledgeUsageView | undefined, locale: Parameters<typeof formatCompactCount>[1]): Record<string, string> {
  return {
    source: formatCompactCount(usage?.limits.maxSourceTokens ?? 1_000_000, locale),
    organization: formatCompactCount(usage?.limits.maxOrganizationTokens ?? 5_000_000, locale),
  };
}
