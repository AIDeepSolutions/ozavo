"use client";

import { useRef, useState } from "react";
import enCommon from "../../../../../i18n/en/common";
import esCommon from "../../../../../i18n/es/common";
import { fill } from "../../../../../i18n/locales";
import ptBRCommon from "../../../../../i18n/pt-BR/common";
import { useDict, useLocale } from "../../../../../i18n/provider";
import { api } from "../../../../../ui/api";
import { Button, Field, Notice, Panel, TextInput } from "../../../../../ui/kit";
import type { TenantDetail } from "../../../../../ui/platform-tenants";
import { useTenantsDict, useTenantsError } from "../shared";

const kilobytes = (bytes: number, locale: string): string => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} KB`;

/** O arquivo escolhido, em base64 puro (sem o prefixo `data:`). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function save(base64: string, type: string, name: string): void {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type Pending = { kind: "replace"; image: string; file: string } | { kind: "remove" } | null;

/** Nome e logo RCD da empresa. Só a plataforma chega aqui (a rota confere de novo). */
export function RcdPanel({ tenant, reload }: { tenant: TenantDetail; reload(): void }) {
  const t = useTenantsDict();
  const locale = useLocale();
  const cancel = useDict(ptBRCommon, enCommon, esCommon).actions.cancel;
  const errorText = useTenantsError();
  const picker = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(tenant.rcd.displayName ?? "");
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const base = `/platform/tenants/${tenant.organizationId}`;

  const run = (work: () => Promise<string>): void => {
    setBusy(true);
    setError("");
    setDone("");
    work()
      .then((message) => {
        setDone(message);
        setPending(null);
        reload();
      }, (failure: unknown) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  const saveName = (): void =>
    run(async () => {
      const saved = await api<{ displayName: string | null }>(`${base}/rcd`, { method: "PUT", body: { displayName: name.trim() === "" ? null : name } });
      setName(saved.displayName ?? "");
      return saved.displayName === null ? t.rcd.nameCleared : fill(t.rcd.nameSaved, { name: saved.displayName });
    });

  const apply = (): void => {
    if (!pending) return;
    run(async () => {
      if (pending.kind === "remove") {
        await api(`${base}/rcd-logo`, { method: "DELETE" });
        return t.rcd.logoRemoved;
      }
      await api(`${base}/rcd-logo`, { method: "PUT", body: { image: pending.image } });
      return t.rcd.logoSaved;
    });
  };

  const download = (format: "png" | "bmp"): void => {
    setError("");
    void api<{ png: string; bmp: string }>(`${base}/rcd-logo`).then(
      (files) => save(files[format], format === "png" ? "image/png" : "image/bmp", `rcd-logo.${format}`),
      (failure: unknown) => setError(errorText(failure)),
    );
  };

  const choose = (file: File | undefined): void => {
    if (!file) return;
    setError("");
    void readBase64(file).then(
      (image) => setPending({ kind: "replace", image, file: file.name }),
      () => setError(errorText(null)),
    );
    if (picker.current) picker.current.value = "";
  };

  const sizes = tenant.rcd.logoBytes;
  const confirmText = pending?.kind === "remove" ? fill(t.rcd.confirmRemove, { name: tenant.name }) : fill(t.rcd.confirmReplace, { name: tenant.name });
  const confirmYes = pending?.kind === "remove" ? fill(t.rcd.confirmRemoveYes, { name: tenant.name }) : fill(t.rcd.confirmReplaceYes, { name: tenant.name });
  return (
    <Panel title={t.rcd.title} description={t.rcd.lead}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <Field label={t.rcd.name} hint={t.rcd.nameHint}>
            <TextInput mono value={name} onChange={(event) => setName(event.target.value)} maxLength={200} autoComplete="off" />
          </Field>
          {tenant.rcd.displayName === null ? <p className="text-[0.87rem] text-muted">{t.rcd.nameNone}</p> : null}
          <div>
            <Button variant="secondary" busy={busy && pending === null} onClick={saveName}>
              {t.rcd.saveName}
            </Button>
          </div>
        </div>
        <div className="grid content-start gap-3">
          <h3 className="font-bold">{t.rcd.logo}</h3>
          <p className={sizes ? "" : "text-muted"}>{sizes ? fill(t.rcd.logoHave, { png: kilobytes(sizes.png, locale), bmp: kilobytes(sizes.bmp, locale) }) : t.rcd.logoNone}</p>
          <p className="text-[0.87rem] text-muted">{t.rcd.logoHint}</p>
          <input ref={picker} type="file" accept="image/png,image/jpeg,image/bmp" className="sr-only" tabIndex={-1} aria-label={t.rcd.upload} onChange={(event) => choose(event.target.files?.[0])} />
          {pending === null ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => picker.current?.click()}>
                {sizes ? t.rcd.replace : t.rcd.upload}
              </Button>
              {sizes ? (
                <>
                  <Button variant="ghost" onClick={() => download("png")}>
                    {t.rcd.downloadPng}
                  </Button>
                  <Button variant="ghost" onClick={() => download("bmp")}>
                    {t.rcd.downloadBmp}
                  </Button>
                  <Button variant="danger" onClick={() => setPending({ kind: "remove" })}>
                    {t.rcd.remove}
                  </Button>
                </>
              ) : null}
            </div>
          ) : (
            <Notice tone={pending.kind === "remove" ? "fail" : "warn"}>
              {pending.kind === "replace" ? <p className="data text-[0.87rem]">{fill(t.rcd.chosen, { file: pending.file })}</p> : null}
              <p>{confirmText}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button variant={pending.kind === "remove" ? "danger" : "primary"} busy={busy} onClick={apply}>
                  {confirmYes}
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)}>
                  {cancel}
                </Button>
              </div>
            </Notice>
          )}
        </div>
      </div>
      {done ? <Notice tone="ok">{done}</Notice> : null}
      {error ? <Notice tone="fail">{error}</Notice> : null}
    </Panel>
  );
}
