"use client";
import en from "../../../i18n/en/talk-share";
import es from "../../../i18n/es/talk-share";
import { fill } from "../../../i18n/locales";
import ptBR from "../../../i18n/pt-BR/talk-share";
import { useDict, useLocale } from "../../../i18n/provider";
import { useApi } from "../../../ui/api";
import { Badge, Panel, Skeleton } from "../../../ui/kit";

interface TalkShare {
  calls: number;
  share: number | null;
  callsOverTarget: number;
  target: number;
}

/** A fala da IA no período do FinOps: a meta da especificação é ficar abaixo da metade. */
export function TalkSharePanel() {
  const t = useDict(ptBR, en, es);
  const locale = useLocale();
  const state = useApi<TalkShare>("/finops/talk-share");
  const data = state.data;
  return (
    <Panel title={t.title} description={fill(t.lead, { target: Math.round((data?.target ?? 0.5) * 100) })}>
      {!data ? (
        <Skeleton lines={2} />
      ) : data.share === null ? (
        <p className="text-muted">{t.none}</p>
      ) : (
        <div className="grid gap-2">
          <span className="data text-[1.9rem] leading-none font-medium tracking-[-0.03em]">{fill(t.share, { n: Math.round(data.share * 100) })}</span>
          <span className="flex flex-wrap items-center gap-2 text-[0.87rem] text-muted">
            <Badge tone={data.share < data.target ? "ok" : "fail"}>{data.share < data.target ? t.within : t.above}</Badge>
            {fill(t.calls, { n: data.calls.toLocaleString(locale) })}
            {data.callsOverTarget > 0 ? ` · ${fill(t.over, { n: data.callsOverTarget.toLocaleString(locale) })}` : ""}
          </span>
        </div>
      )}
    </Panel>
  );
}
