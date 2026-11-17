import { recordOrgEvent } from "./events";
import { DEFAULT_TIMEZONE } from "./metering";
import { notifyPanel } from "./notices";
import { getOperationSettings } from "./operation-settings";
import { queuePlatformAlert } from "./platform-alerts";
import { queueWebhookEvent } from "./webhook-events";
import { enqueueTask } from "./queue";
import type { OrgQuery } from "./types";

/**
 * Disjuntor de chamadas curtas. Uma linha que faz muitas ligações e quase todas duram poucos
 * segundos é o padrão que leva a operadora a bloquear o número. Aqui a cadência das ligações de
 * saída da linha cai antes disso, e quem opera é avisado.
 *
 * Os números vêm da especificação do produto recebida em 2026-11-16 (seção 6), que cita o Despacho
 * 100/2026 da Anatel: "por tenant e por tronco", disparo em 75% de ligações "com duração inferior a
 * 6 segundos" acima de 1.000 chamadas no dia, abaixo do gatilho de bloqueio que ela descreve (85% em
 * 10.000). O texto do despacho NÃO foi conferido por quem escreveu este arquivo. Por isso o que conta
 * como curta é configurável pela plataforma em FinOps (`operation_settings`), com o padrão literal da
 * spec: duração menor que 6 s (fronteira exclusiva), e a ligação de saída não completada conta como
 * curta, com duração 0. A proporção é sobre todas as ligações de saída do dia, por linha e também
 * pela organização inteira (o CNPJ é o que a operadora bloqueia).
 */
export const SHORT_CALL_SECONDS = 6;
/** A linha que representa a organização inteira em `cadence_breakers`: todas as linhas dela juntas. */
export const WHOLE_ORGANIZATION = "*";
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

/** O que conta como ligação curta. O padrão é o da spec; a plataforma ajusta em FinOps. */
export interface ShortCallRule {
  seconds: number;
  inclusive: boolean;
  countsUnanswered: boolean;
}

export const SPEC_SHORT_CALL_RULE: ShortCallRule = { seconds: SHORT_CALL_SECONDS, inclusive: false, countsUnanswered: true };

/**
 * As ligações de saída de hoje (calendário da organização), por linha, e uma linha a mais para a
 * organização inteira (`WHOLE_ORGANIZATION`), quando ela tem mais de uma linha.
 */
export async function shortCallStats(q: OrgQuery, now: Date, rule: ShortCallRule = SPEC_SHORT_CALL_RULE): Promise<LineShortCalls[]> {
  const lines = await q.many<LineShortCalls>(
    `select coalesce(c.from_e164, '') as "lineE164", count(*)::int as total,
            count(*) filter (where (c.answered_at is not null and c.ended_at is not null
                                    and (c.ended_at - c.answered_at < make_interval(secs => $3)
                                         or ($4 and c.ended_at - c.answered_at = make_interval(secs => $3))))
                               or ($5 and c.answered_at is null and c.ended_at is not null))::int as short
       from calls c cross join ${DAY_SQL} d
      where c.organization_id = $1 and c.direction = 'outbound' and c.channel = 'phone' and c.status <> 'refused'
        and (c.started_at at time zone d.zone)::date = d.day
      group by 1 order by 1`,
    [q.organizationId, now, rule.seconds, rule.inclusive, rule.countsUnanswered],
  );
  if (lines.length < 2) return lines;
  const whole = lines.reduce((sum, line) => ({ lineE164: WHOLE_ORGANIZATION, total: sum.total + line.total, short: sum.short + line.short }), { lineE164: WHOLE_ORGANIZATION, total: 0, short: 0 });
  return [...lines, whole];
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
  const { reducedCallsPerHour, shortCallSeconds, shortCallInclusive, shortCallCountsUnanswered } = await getOperationSettings(q);
  const rule: ShortCallRule = { seconds: shortCallSeconds, inclusive: shortCallInclusive, countsUnanswered: shortCallCountsUnanswered };
  for (const line of await shortCallStats(q, now, rule)) {
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
    const whole = line.lineE164 === WHOLE_ORGANIZATION;
    const label = whole ? "A empresa, somando todas as linhas," : line.lineE164 === "" ? "A organização" : `A linha ${line.lineE164}`;
    const threshold = `${shortCallInclusive ? "até" : "menos de"} ${shortCallSeconds} segundos${shortCallCountsUnanswered ? " (contando as não atendidas)" : ""}`;
    await notifyPanel(
      q,
      `ALERTA CRÍTICO: ${label} fez ${line.total} ligações de saída hoje e ${percent}% delas duraram ${threshold}. ` +
        `Esse padrão leva a operadora a bloquear o número. A cadência de saída foi reduzida para ${reducedCallsPerHour} ligações por hora ${whole ? "em cada linha da empresa" : "nesta linha"} até o fim do dia. ` +
        "Confira a lista de contatos e o roteiro do agente antes de voltar ao ritmo normal. O limite reduzido se ajusta em FinOps.",
      now,
    );
    await recordOrgEvent(q, "cadence_reduced", { lineE164: line.lineE164, totalCalls: line.total, shortCalls: line.short, reducedCallsPerHour }, now);
    await queueWebhookEvent(q, q.organizationId, "cadence.reduced", { lineE164: line.lineE164, totalCalls: line.total, shortCalls: line.short, reducedCallsPerHour }, now);
    const today = await q.one<{ day: string }>(`select to_char(d.day, 'YYYY-MM-DD') as day from ${DAY_SQL} d`, [q.organizationId, now]);
    await queuePlatformAlert(q, { kind: "breaker", lineE164: line.lineE164, totalCalls: line.total, shortCalls: line.short, reducedCallsPerHour, day: today?.day ?? "" }, now);
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
