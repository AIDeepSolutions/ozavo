import { listWebhookDeliveries } from "@ozavo/core";
import { handle } from "../../../../../../server/context";

/** As últimas entregas deste destino: evento, tentativa, código de resposta e motivo da falha. */
export const GET = handle({ configure: true }, async ({ q, params }) => ({ deliveries: await listWebhookDeliveries(q, params.id ?? "") }));
