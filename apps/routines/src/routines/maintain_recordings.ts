import { readdir, rm } from "node:fs/promises";
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
    // O banco decide a idade das chamadas conhecidas em ambos os armazenamentos. Uma
    // restauração pode alterar mtime; ele só serve de fallback para arquivos órfãos.
    const calls = await withOrg(deps.db, task.organizationId, q => q.many<{ id: string; expired: boolean; ended: boolean }>(
      "select id, (erased_at is not null or coalesce(ended_at < $1, false)) as expired, ended_at is not null as ended from calls", [before]));
    let recordings = await purgeRecordings(deps.recordingsDir, task.organizationId, before, new Set(calls.map(call => call.id)));
    const names = new Set(await readdir(join(deps.recordingsDir, task.organizationId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }));
    try {
      for (const call of calls) {
        const file = recordingPath(deps.recordingsDir, task.organizationId, call.id);
        if (call.expired) {
          // Também corrige apagamentos a pedido cuja tarefa tenha esgotado tentativas.
          for (const target of [`${file}.part`, file]) {
            try { await rm(target); recordings += 1; }
            catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
          }
          await deps.recordingArchive?.remove(task.organizationId, call.id);
        } else if (call.ended && names.has(`${call.id}.wav`)) {
          await withOrg(deps.db, task.organizationId, async q => {
            if ((await lockCall(q, call.id)).erased) return;
            await sealLegacyRecording(file, deps.secretKey);
            await deps.recordingArchive?.put(task.organizationId, call.id, file);
          });
        }
      }
    } finally {
      // Uma falha remota não esconde o que já saiu do disco.
      if (recordings > 0) await withOrg(deps.db, task.organizationId, q => recordOrgEvent(q, "recordings_purged", { recordings, retentionDays: days, before: before.toISOString() }, now));
    }
  },
};
export default routine;
