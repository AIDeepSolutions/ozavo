import { z } from "zod";
import type { OrgQuery } from "./types";

/**
 * Limites de operação que quem opera escolhe pela tela (`operation_settings`). Nulo é "não
 * informado": sem teto do provedor de síntese não há limite por ele, e sem cotação ou custo de
 * telefonia o painel de FinOps diz que falta o dado.
 */
export interface OperationSettings {
  /** Chamadas simultâneas que a conta do provedor de síntese (Cartesia) aceita. */
  ttsConcurrencyLimit: number | null;
  /** Ligações de saída por hora, por linha, enquanto a cadência está reduzida. */
  reducedCallsPerHour: number;
  /** Custo de telefonia em reais por minuto falado. */
  telephonyBrlPerMinute: number | null;
  /** Cotação do dólar em reais. */
  usdBrlRate: number | null;
  /** Segundos abaixo dos quais a ligação de saída é curta, para o disjuntor (padrão da spec: 6). */
  shortCallSeconds: number;
  /** A ligação de exatamente `shortCallSeconds` também é curta (≤ em vez de <). */
  shortCallInclusive: boolean;
  /** A ligação de saída não completada conta como curta (duração 0). */
  shortCallCountsUnanswered: boolean;
}

export const DEFAULT_REDUCED_CALLS_PER_HOUR = 60;

/** A regra das chamadas curtas da especificação (seção 6): menos de 6 s, e a não completada conta. */
export const OPERATION_DEFAULTS_SHORT = { shortCallSeconds: 6, shortCallInclusive: false, shortCallCountsUnanswered: true } as const;

export const OPERATION_DEFAULTS: OperationSettings = {
  ttsConcurrencyLimit: null,
  reducedCallsPerHour: DEFAULT_REDUCED_CALLS_PER_HOUR,
  telephonyBrlPerMinute: null,
  usdBrlRate: null,
  ...OPERATION_DEFAULTS_SHORT,
};

export const operationSettingsInput = z.object({
  ttsConcurrencyLimit: z.number().int().min(1).max(1000).nullable(),
  reducedCallsPerHour: z.number().int().min(1).max(10_000),
  telephonyBrlPerMinute: z.number().min(0).max(100).nullable(),
  usdBrlRate: z.number().gt(0).max(1000).nullable(),
  // Opcionais: quem gravava os limites antes da regra configurável continua mandando só os quatro.
  shortCallSeconds: z.number().int().min(1).max(60).default(OPERATION_DEFAULTS_SHORT.shortCallSeconds),
  shortCallInclusive: z.boolean().default(OPERATION_DEFAULTS_SHORT.shortCallInclusive),
  shortCallCountsUnanswered: z.boolean().default(OPERATION_DEFAULTS_SHORT.shortCallCountsUnanswered),
});

interface Row {
  tts_concurrency_limit: number | null;
  reduced_calls_per_hour: number;
  // `numeric` chega como texto.
  telephony_brl_per_minute: string | null;
  usd_brl_rate: string | null;
  short_call_seconds: number;
  short_call_inclusive: boolean;
  short_call_counts_unanswered: boolean;
}

const COLUMNS = "tts_concurrency_limit, reduced_calls_per_hour, telephony_brl_per_minute, usd_brl_rate, short_call_seconds, short_call_inclusive, short_call_counts_unanswered";
const numberOrNull = (value: string | null): number | null => (value === null ? null : Number(value));
const shape = (row: Row): OperationSettings => ({
  ttsConcurrencyLimit: row.tts_concurrency_limit,
  reducedCallsPerHour: row.reduced_calls_per_hour,
  telephonyBrlPerMinute: numberOrNull(row.telephony_brl_per_minute),
  usdBrlRate: numberOrNull(row.usd_brl_rate),
  shortCallSeconds: row.short_call_seconds,
  shortCallInclusive: row.short_call_inclusive,
  shortCallCountsUnanswered: row.short_call_counts_unanswered,
});

/** Os limites da organização; sem linha no banco, os padrões (nada informado). */
export async function getOperationSettings(q: OrgQuery): Promise<OperationSettings> {
  const row = await q.one<Row>(`select ${COLUMNS} from operation_settings where organization_id = $1`, [q.organizationId]);
  return row ? shape(row) : OPERATION_DEFAULTS;
}

export async function saveOperationSettings(q: OrgQuery, given: Omit<OperationSettings, keyof typeof OPERATION_DEFAULTS_SHORT> & Partial<OperationSettings>, at: Date): Promise<OperationSettings> {
  if (q.organizationId === "") throw new Error("saveOperationSettings runs inside withOrg: the limits belong to one organization");
  const input: OperationSettings = { ...OPERATION_DEFAULTS_SHORT, ...given };
  const row = await q.one<Row>(
    `insert into operation_settings (organization_id, tts_concurrency_limit, reduced_calls_per_hour, telephony_brl_per_minute, usd_brl_rate, updated_at,
       short_call_seconds, short_call_inclusive, short_call_counts_unanswered)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (organization_id) do update set tts_concurrency_limit = excluded.tts_concurrency_limit, reduced_calls_per_hour = excluded.reduced_calls_per_hour,
       telephony_brl_per_minute = excluded.telephony_brl_per_minute, usd_brl_rate = excluded.usd_brl_rate, updated_at = excluded.updated_at,
       short_call_seconds = excluded.short_call_seconds, short_call_inclusive = excluded.short_call_inclusive, short_call_counts_unanswered = excluded.short_call_counts_unanswered
     returning ${COLUMNS}`,
    [q.organizationId, input.ttsConcurrencyLimit, input.reducedCallsPerHour, input.telephonyBrlPerMinute, input.usdBrlRate, at, input.shortCallSeconds, input.shortCallInclusive, input.shortCallCountsUnanswered],
  );
  if (!row) throw new Error("Operation settings were not saved");
  return shape(row);
}
