import { recordOrgEvent } from "./events";
import { DEFAULT_TIMEZONE } from "./metering";
import { notifyPanel } from "./notices";
import { getOperationSettings } from "./operation-settings";
import { enqueueTask } from "./queue";
import type { OrgQuery } from "./types";

/**
 * Disjuntor de chamadas curtas. Uma linha que faz muitas ligações e quase todas duram poucos
 * segundos é o padrão que leva a operadora a bloquear o número. Aqui a cadência das ligações de
 * saída da linha cai antes disso, e quem opera é avisado.
 *
 * Os números vêm da especificação do produto recebida em 2026-11-16 (seção 6), que cita o Despacho
 * 100/2026 da Anatel: disparo em 75% de chamadas com menos de 6 s acima de 1.000 chamadas no dia,
 * abaixo do gatilho de bloqueio que ela descreve (85% em 10.000). O texto do despacho NÃO foi
 * conferido por quem escreveu este arquivo; inclusive o que conta como "chamada curta". Aqui
 * conta a ligação de saída atendida que durou menos de 6 s, sobre todas as ligações de saída
 * feitas pela linha no dia.
 */
export const SHORT_CALL_SECONDS = 6;
export const SHORT_CALL_RATIO = 0.75;
export const SHORT_CALL_MIN_DAILY_CALLS = 1000;

export const WATCH_SHORT_CALLS_TASK = "watch_short_calls";
/** De quanto em quanto a rotina confere, enquanto a organização faz ligações de saída. */
export const SHORT_CALL_WATCH_INTERVAL_MS = 15 * 60 * 1000;

/** A regra, sem banco: muitas ligações no dia e a maior parte delas curta. */
export function shortCallsTripped(stats: { total: number; short: number }): boolean {
  return stats.total > SHORT_CALL_MIN_DAILY_CALLS && stats.short >= stats.total * SHORT_CALL_RATIO;
}

export interface LineShortCalls {
  /** Número de origem da linha; vazio para ligações sem número de origem. */
  lineE164: string;
  total: number;
  short: number;
}

const DAY_SQL = `(select ($2::timestamptz at time zone z.zone)::date as day, z.zone
                    from (select coalesce((select timezone from outbound_policy where organization_id = $1), '${DEFAULT_TIMEZONE}') as zone) z)`;

/** As ligações de saída de hoje (calendário da organização), por linha. */
export function shortCallStats(q: OrgQuery, now: Date): Promise<LineShortCalls[]> {
  return q.many<LineShortCalls>(
    `select coalesce(c.from_e164, '') as "lineE164", count(*)::int as total,
            count(*) filter (where c.answered_at is not null and c.ended_at is not null
                               and c.ended_at - c.answered_at < make_interval(secs => $3))::int as short
       from calls c cross join ${DAY_SQL} d
      where c.organization_id = $1 and c.direction = 'outbound' and c.channel = 'phone' and c.status <> 'refused'
        and (c.started_at at time zone d.zone)::date = d.day
      group by 1 order by 1`,
    [q.organizationId, now, SHORT_CALL_SECONDS],
  );
}

/** As linhas com a cadência reduzida hoje. */
export function activeCadenceBreakers(q: OrgQuery, now: Date): Promise<Array<{ lineE164: string; totalCalls: number; shortCalls: number; trippedAt: Date }>> {
  return q.many(
    `select b.line_e164 as "lineE164", b.total_calls as "totalCalls", b.short_calls as "shortCalls", b.tripped_at as "trippedAt"
       from cadence_breakers b cross join ${DAY_SQL} d
      where b.organization_id = $1 and b.day = d.day order by b.tripped_at`,
    [q.organizationId, now],
  );
}

/**
 * Confere as linhas e reduz a cadência das que passaram do limite: grava `cadence_breakers` para o
 * dia, avisa no painel e registra `cadence_reduced`. Devolve as linhas reduzidas AGORA; a que já
 * estava reduzida hoje não avisa de novo. A redução vale até o fim do dia da organização.
 */
export async function watchShortCalls(q: OrgQuery, now: Date): Promise<LineShortCalls[]> {
  if (q.organizationId === "") throw new Error("watchShortCalls runs inside withOrg, never withSystem: the count is per organization");
  const tripped: LineShortCalls[] = [];
  const { reducedCallsPerHour } = await getOperationSettings(q);
  for (const line of await shortCallStats(q, now)) {
    if (!shortCallsTripped(line)) continue;
    const inserted = await q.exec(
      `insert into cadence_breakers (organization_id, line_e164, day, total_calls, short_calls, tripped_at)
       select $1, $3, d.day, $4, $5, $2 from ${DAY_SQL} d
       on conflict (organization_id, line_e164, day) do nothing`,
      [q.organizationId, now, line.lineE164, line.total, line.short],
    );
    if (inserted !== 1) continue;
    tripped.push(line);
    const percent = Math.round((line.short / line.total) * 100);
    const label = line.lineE164 === "" ? "A organização" : `A linha ${line.lineE164}`;
    await notifyPanel(
      q,
      `ALERTA CRÍTICO: ${label} fez ${line.total} ligações de saída hoje e ${percent}% delas duraram menos de ${SHORT_CALL_SECONDS} segundos. ` +
        `Esse padrão leva a operadora a bloquear o número. A cadência de saída foi reduzida para ${reducedCallsPerHour} ligações por hora até o fim do dia. ` +
        "Confira a lista de contatos e o roteiro do agente antes de voltar ao ritmo normal. O limite reduzido se ajusta em FinOps.",
      now,
    );
    await recordOrgEvent(q, "cadence_reduced", { lineE164: line.lineE164, totalCalls: line.total, shortCalls: line.short, reducedCallsPerHour }, now);
  }
  return tripped;
}

/**
 * Põe a rotina que confere as chamadas curtas na fila, se ainda não houver uma. A corrente é uma só
 * por organização, começa na primeira ligação de saída e para sozinha quando a organização passa
 * um dia sem ligar: quem não liga não tem tarefa na fila.
 */
export async function scheduleShortCallWatch(q: OrgQuery, runAt: Date): Promise<boolean> {
  const queued = await q.one("select 1 from tasks where kind = $1 and status = 'queued'", [WATCH_SHORT_CALLS_TASK]);
  if (queued) return false;
  await enqueueTask(q, { kind: WATCH_SHORT_CALLS_TASK, payload: {}, runAt });
  return true;
}
