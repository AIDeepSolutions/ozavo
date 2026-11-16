import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { RECORDING_MAINTENANCE_TASK, RECORDING_RETENTION_SETTING, recordingRetentionOf, recordingPath, sealLegacyRecording, lockCall,
  scheduleRecordingMaintenance, purgeRecordings, recordOrgEvent, withOrg } from "@ozavo/core";
import type { Routine } from "../types";

const DAY = 86400000;
const routine: Routine = {
  kind: RECORDING_MAINTENANCE_TASK,
  async run(task, deps) {
    if (!deps.recordingsDir) throw new Error("Recording maintenance needs a recordings directory");
    const now = deps.clock.now();
    const days = await withOrg(deps.db, task.organizationId, async q => {
      const stored = await q.one<{ value: unknown }>("select value from settings where key = $1", [RECORDING_RETENTION_SETTING]);
      await scheduleRecordingMaintenance(q, new Date(now.getTime() + DAY));
      return recordingRetentionOf(stored?.value);
    });
    const before = new Date(now.getTime() - days * DAY);
    const recordings = await purgeRecordings(deps.recordingsDir, task.organizationId, before);
    const archive = deps.recordingArchive;
    {
      // O banco é a autoridade também quando o arquivo local se perdeu. Apagamento do titular
      // ganha de qualquer prazo. Chamadas ainda ativas nunca entram na cópia.
      const calls = await withOrg(deps.db, task.organizationId, q => q.many<{ id: string; expired: boolean }>(
        "select id, (erased_at is not null or ended_at < $1) as expired from calls where ended_at is not null", [before]));
      const names = new Set(await readdir(join(deps.recordingsDir, task.organizationId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }));
      for (const call of calls) {
        if (call.expired) await archive?.remove(task.organizationId, call.id);
        else if (names.has(`${call.id}.wav`)) {
          const file = recordingPath(deps.recordingsDir, task.organizationId, call.id);
          await withOrg(deps.db, task.organizationId, async q => {
            if ((await lockCall(q, call.id)).erased) return;
            await sealLegacyRecording(file, deps.secretKey);
            await archive?.put(task.organizationId, call.id, file);
          });
        }
      }
    }
    if (recordings > 0) await withOrg(deps.db, task.organizationId, q => recordOrgEvent(q, "recordings_purged", { recordings, retentionDays: days, before: before.toISOString() }, now));
  },
};
export default routine;
