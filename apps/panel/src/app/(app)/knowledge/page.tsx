"use client";

import { Books } from "@phosphor-icons/react";
import { useEffect } from "react";
import en from "../../../i18n/en/knowledge";
import es from "../../../i18n/es/knowledge";
import ptBR from "../../../i18n/pt-BR/knowledge";
import { useDict } from "../../../i18n/provider";
import { useApi } from "../../../ui/api";
import { ReadOnlyNotice, useErrorText } from "../../../ui/errors";
import { KNOWLEDGE_POLL_MS, hasPendingSource, type KnowledgeSourceView, type KnowledgeUsageView } from "../../../ui/knowledge";
import { EmptyState, Notice, PageHeader, Skeleton } from "../../../ui/kit";
import { useCanConfigure } from "../../../ui/me";
import { AddPanel } from "./add-panel";
import { LimitsPanel } from "./limits-panel";
import { SearchPanel } from "./search-panel";
import { SourceRow } from "./source-row";

export default function KnowledgePage() {
  const t = useDict(ptBR, en, es);
  const errorText = useErrorText();
  const canConfigure = useCanConfigure();
  const list = useApi<{ sources: KnowledgeSourceView[] }>("/knowledge");
  const usage = useApi<KnowledgeUsageView>("/knowledge/usage");
  const sources = list.data?.sources;
  const pending = sources !== undefined && hasPendingSource(sources);
  const { reload: reloadList } = list;
  const { reload: reloadUsage } = usage;
  const reloadAll = (): void => {
    reloadList();
    reloadUsage();
  };

  // O estado muda no servidor (a rotina indexa em segundo plano): enquanto houver fonte na fila ou
  // indexando, a tela pergunta de novo a cada poucos segundos, e para sozinha quando nada espera.
  // A aba escondida não pergunta. O servidor não faz polling; quem consulta é o navegador, por pedido.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        reloadList();
        reloadUsage();
      }
    }, KNOWLEDGE_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, reloadList, reloadUsage]);

  return (
    <>
      <PageHeader title={t.title} lead={t.lead} />
      <ReadOnlyNotice />
      {list.error && !list.data ? <Notice tone="fail">{errorText(list.error)}</Notice> : null}
      <LimitsPanel usage={usage.data} />
      <AddPanel canConfigure={canConfigure} maxFileBytes={usage.data?.limits.maxFileBytes} onAdded={reloadAll} />
      {!sources && !list.error ? <Skeleton lines={3} /> : null}
      {sources?.length === 0 ? (
        <EmptyState icon={<Books size={32} weight="duotone" aria-hidden />} title={t.list.emptyTitle}>
          <p>{t.list.emptyBody}</p>
        </EmptyState>
      ) : null}
      {sources?.length ? (
        <section aria-label={t.list.title}>
          <h2 className="mb-3 text-[1.07rem] font-bold">{t.list.title}</h2>
          <ul className="overflow-hidden rounded-md border border-line bg-surface">
            {sources.map((source) => (
              <SourceRow key={source.id} source={source} usage={usage.data} canConfigure={canConfigure} onChanged={reloadAll} />
            ))}
          </ul>
        </section>
      ) : null}
      <SearchPanel canConfigure={canConfigure} hasReadySource={(sources ?? []).some((source) => source.currentVersionId !== null)} />
    </>
  );
}
