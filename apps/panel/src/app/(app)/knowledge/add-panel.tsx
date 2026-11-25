"use client";

import { FileArrowUp, TextAa } from "@phosphor-icons/react";
import { useRef, useState, type DragEvent } from "react";
import en from "../../../i18n/en/knowledge";
import es from "../../../i18n/es/knowledge";
import { fill } from "../../../i18n/locales";
import ptBR from "../../../i18n/pt-BR/knowledge";
import { useDict } from "../../../i18n/provider";
import { api, apiForm } from "../../../ui/api";
import { ActionStatus, useAction, useErrorText } from "../../../ui/errors";
import { Button, Field, Notice, Panel, TextArea, TextInput } from "../../../ui/kit";

const ACCEPT = ".pdf,.docx,.md,.markdown,.txt";

/**
 * Envia os arquivos escolhidos ou arrastados, um de cada vez, e junta o que não passou, cada um com a
 * sua frase. Confere o tamanho antes de mandar quando o teto já é conhecido.
 */
export function useFileUploads(maxFileBytes: number | undefined, send: (file: File) => Promise<unknown>, done: () => void) {
  const t = useDict(ptBR, en, es).add;
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const run = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setBusy(true);
    setSent(false);
    const failed: string[] = [];
    let ok = 0;
    for (const file of files) {
      if (maxFileBytes !== undefined && file.size > maxFileBytes) {
        failed.push(fill(t.tooBig, { name: file.name, mb: maxFileBytes / (1024 * 1024) }));
        continue;
      }
      try {
        await send(file);
        ok += 1;
      } catch (error) {
        failed.push(fill(t.failedFile, { name: file.name, reason: errorText(error) }));
      }
    }
    setFailures(failed);
    setSent(ok > 0);
    setBusy(false);
    if (ok > 0) done();
  };
  return { busy, failures, sent, run };
}

/** Os arquivos recusados e o "enviado" sóbrio; some quando a pessoa envia de novo. */
export function UploadStatus({ failures, sent }: { failures: string[]; sent: boolean }) {
  const t = useDict(ptBR, en, es).add;
  return (
    <>
      {failures.map((line) => (
        <Notice key={line} tone="fail">
          {line}
        </Notice>
      ))}
      {sent ? (
        <span role="status" className="text-ok">
          {t.sent}
        </span>
      ) : null}
    </>
  );
}

/** Arrastar, escolher ou colar: as três portas de entrada de uma base nova. */
export function AddPanel({ canConfigure, maxFileBytes, onAdded }: { canConfigure: boolean; maxFileBytes: number | undefined; onAdded: () => void }) {
  const t = useDict(ptBR, en, es).add;
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const paste = useAction();
  const uploads = useFileUploads(
    maxFileBytes,
    (file) => {
      const form = new FormData();
      form.set("file", file);
      return apiForm("/knowledge", form);
    },
    onAdded,
  );
  if (!canConfigure) {
    return (
      <Panel title={t.title}>
        <p className="text-muted">{t.readOnly}</p>
      </Panel>
    );
  }
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    setDragging(false);
    void uploads.run([...event.dataTransfer.files]);
  };

  return (
    <Panel title={t.title}>
      <div className="grid gap-4">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`grid justify-items-start gap-3 rounded-md border border-dashed px-6 py-6 transition-colors duration-[120ms] ${dragging ? "border-accent bg-accent-soft" : "border-line-strong"}`}
        >
          <span className="text-muted">
            <FileArrowUp size={32} weight="duotone" aria-hidden />
          </span>
          <div className="grid gap-1">
            <p className="font-bold">{t.dropTitle}</p>
            <p className="text-muted">{fill(t.dropHint, { mb: maxFileBytes === undefined ? 20 : maxFileBytes / (1024 * 1024) })}</p>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            aria-label={t.fileInput}
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              void uploads.run([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" busy={uploads.busy} icon={<FileArrowUp size={18} weight="bold" aria-hidden />} onClick={() => input.current?.click()}>
              {t.choose}
            </Button>
            <Button aria-expanded={pasting} icon={<TextAa size={18} weight="bold" aria-hidden />} onClick={() => setPasting(!pasting)}>
              {t.paste}
            </Button>
          </div>
        </div>
        <UploadStatus failures={uploads.failures} sent={uploads.sent} />

        {pasting ? (
          <form
            className="grid gap-4 border-t border-line pt-4"
            onSubmit={(submit) => {
              submit.preventDefault();
              void paste.run(async () => {
                await api("/knowledge", { body: { name, text } });
                setName("");
                setText("");
                setPasting(false);
                onAdded();
              });
            }}
          >
            <h3 className="font-bold">{t.pasteTitle}</h3>
            <Field label={t.pasteName} hint={t.pasteNameHint}>
              <TextInput className="max-w-xl" value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label={t.pasteText}>
              <TextArea value={text} required rows={8} onChange={(event) => setText(event.target.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" busy={paste.busy}>
                {t.pasteSubmit}
              </Button>
              <ActionStatus action={paste} />
            </div>
          </form>
        ) : null}
      </div>
    </Panel>
  );
}
