import { SHORT_CALL_WATCH_INTERVAL_MS, WATCH_SHORT_CALLS_TASK, scheduleShortCallWatch, watchShortCalls, withOrg } from "@ozavo/core";
import type { Routine } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Confere as chamadas curtas de UMA organização e reduz a cadência das linhas que passaram do
 * limite (`watchShortCalls`: aviso no painel e evento `cadence_reduced`).
 *
 * Roda a cada 15 minutos, reagendando a si mesma pela fila (`run_at`), sem timer nem polling. A
 * corrente começa na primeira ligação de saída (`checkPacingAllowed`) e para quando a organização
 * passa um dia sem ligar: quem não faz ligação de saída não tem tarefa na fila.
 */
const routine: Routine = {
  kind: WATCH_SHORT_CALLS_TASK,
  async run(task, deps) {
    const now = deps.clock.now();
    // A próxima passagem entra antes da conferência, em transação própria: se a conferência falhar
    // até esgotar as tentativas, a seguinte continua de pé.
    await withOrg(deps.db, task.organizationId, async (q) => {
      const calling = await q.one("select 1 from calls where organization_id = $1 and direction = 'outbound' and channel = 'phone' and started_at > $2 limit 1", [
        task.organizationId,
        new Date(now.getTime() - DAY_MS),
      ]);
      // A própria tarefa está `running`, e não `queued`: a próxima entra sem esbarrar nela.
      if (calling) await scheduleShortCallWatch(q, new Date(now.getTime() + SHORT_CALL_WATCH_INTERVAL_MS));
    });
    await withOrg(deps.db, task.organizationId, (q) => watchShortCalls(q, now));
  },
};

export default routine;
