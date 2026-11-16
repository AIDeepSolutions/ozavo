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
}

export const DEFAULT_REDUCED_CALLS_PER_HOUR = 60;

export const OPERATION_DEFAULTS: OperationSettings = {
  ttsConcurrencyLimit: null,
  reducedCallsPerHour: DEFAULT_REDUCED_CALLS_PER_HOUR,
  telephonyBrlPerMinute: null,
  usdBrlRate: null,
};

export const operationSettingsInput = z.object({
  ttsConcurrencyLimit: z.number().int().min(1).max(1000).nullable(),
  reducedCallsPerHour: z.number().int().min(1).max(10_000),
  telephonyBrlPerMinute: z.number().min(0).max(100).nullable(),
  usdBrlRate: z.number().gt(0).max(1000).nullable(),
});

interface Row {
  tts_concurrency_limit: number | null;
  reduced_calls_per_hour: number;
  // `numeric` chega como texto.
  telephony_brl_per_minute: string | null;
  usd_brl_rate: string | null;
}

const COLUMNS = "tts_concurrency_limit, reduced_calls_per_hour, telephony_brl_per_minute, usd_brl_rate";
const numberOrNull = (value: string | null): number | null => (value === null ? null : Number(value));
const shape = (row: Row): OperationSettings => ({
  ttsConcurrencyLimit: row.tts_concurrency_limit,
  reducedCallsPerHour: row.reduced_calls_per_hour,
  telephonyBrlPerMinute: numberOrNull(row.telephony_brl_per_minute),
  usdBrlRate: numberOrNull(row.usd_brl_rate),
});

/** Os limites da organização; sem linha no banco, os padrões (nada informado). */
export async function getOperationSettings(q: OrgQuery): Promise<OperationSettings> {
  const row = await q.one<Row>(`select ${COLUMNS} from operation_settings where organization_id = $1`, [q.organizationId]);
  return row ? shape(row) : OPERATION_DEFAULTS;
}

export async function saveOperationSettings(q: OrgQuery, input: OperationSettings, at: Date): Promise<OperationSettings> {
  if (q.organizationId === "") throw new Error("saveOperationSettings runs inside withOrg: the limits belong to one organization");
  const row = await q.one<Row>(
    `insert into operation_settings (organization_id, tts_concurrency_limit, reduced_calls_per_hour, telephony_brl_per_minute, usd_brl_rate, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (organization_id) do update set tts_concurrency_limit = excluded.tts_concurrency_limit, reduced_calls_per_hour = excluded.reduced_calls_per_hour,
       telephony_brl_per_minute = excluded.telephony_brl_per_minute, usd_brl_rate = excluded.usd_brl_rate, updated_at = excluded.updated_at
     returning ${COLUMNS}`,
    [q.organizationId, input.ttsConcurrencyLimit, input.reducedCallsPerHour, input.telephonyBrlPerMinute, input.usdBrlRate, at],
  );
  if (!row) throw new Error("Operation settings were not saved");
  return shape(row);
}
