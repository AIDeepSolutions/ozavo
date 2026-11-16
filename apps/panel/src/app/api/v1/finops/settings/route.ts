import { getOperationSettings, operationSettingsInput, saveOperationSettings } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/** Os limites de operação: teto do provedor de síntese, cadência reduzida, custo de telefonia e cotação. */
export const GET = handle({}, ({ q }) => getOperationSettings(q));

export const PUT = handle({ body: operationSettingsInput, configure: true }, ({ q, body, deps }) => saveOperationSettings(q, body, deps.clock.now()));
