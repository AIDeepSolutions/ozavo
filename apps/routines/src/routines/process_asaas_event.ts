import { processAsaasEvent } from "@ozavo/core";
import { z } from "zod";
import type { Routine } from "../types";

const payload = z.object({ eventId: z.uuid() });
const routine: Routine = {
  kind: "process_asaas_event",
  async run(task, deps) {
    const parsed = payload.safeParse(task.payload);
    if (!parsed.success) throw new Error("Invalid Asaas task reference");
    await processAsaasEvent({ ...deps, fetch: deps.fetch ?? fetch }, task.organizationId, parsed.data.eventId, deps.clock.now());
  },
};
export default routine;
