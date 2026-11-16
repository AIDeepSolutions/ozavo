import { getOperationSettings, operationSettingsInput, saveOperationSettings } from "@ozavo/core";
import { handle } from "../../../../../server/context";

/** Os limites de operação: teto do provedor de síntese, cadência reduzida, custo de telefonia e cotação. */
export const GET = handle({}, ({ q }) => getOperationSettings(q));

/** Só a plataforma: o teto da conta de síntese e a cadência reduzida protegem a instalação inteira. */
export const PUT = handle({ body: operationSettingsInput, platform: true }, ({ q, body, deps }) => saveOperationSettings(q, body, deps.clock.now()));
