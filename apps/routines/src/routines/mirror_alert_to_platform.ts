import { MIRROR_ALERT_TASK, mirrorAlertToPlatform, platformAlertPayload } from "@ozavo/core";
import type { Routine } from "../types";

/**
 * Leva à organização que administra a instalação o alerta crítico de uma empresa cliente (franquia
 * em 80% e 100%, disjuntor de chamadas curtas): aviso no painel da plataforma e evento
 * `tenant_critical_alert`. A tarefa nasce na transação em que a empresa grava o alerta; repetir não
 * dobra o aviso.
 */
const routine: Routine = {
  kind: MIRROR_ALERT_TASK,
  async run(task, deps) {
    const parsed = platformAlertPayload.safeParse(task.payload);
    if (!parsed.success) throw new Error("Invalid platform alert payload");
    await mirrorAlertToPlatform(deps.db, task.organizationId, parsed.data, deps.clock.now());
  },
};

export default routine;
