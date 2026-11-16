import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { RECORDING_MAINTENANCE_TASK, RECORDING_RETENTION_SETTING, recordingRetentionOf, recordingPath, sealLegacyRecording, lockCall,
  scheduleRecordingMaintenance, purgeRecordings, recordOrgEvent, withOrg } from "@ozavo/core";
import type { Routine } from "../types";

const DAY = 86400000;
const FILE = /^([0-9a-f-]{36})\.wav(\.part)?$/i;

/**
 * Expurgo e cópia das gravações de uma organização, uma vez por dia.
 *
 * O trabalho é proporcional ao que mudou, não ao acervo: lê só as chamadas que têm arquivo local
 * e as vencidas cuja cópia remota ainda não foi apagada. A chamada guarda quando a gravação foi
 * copiada (`recording_archived_at`) e quando a cópia remota foi apagada
 * (`recording_remote_purged_at`), e o S3 só é chamado para o que falta.
 */
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
    const failures: unknown[] = [];

    let names: string[] = [];
    try { names = await readdir(join(deps.recordingsDir, task.organizationId)); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) failures.push(error);
    }
    const local = [...new Set(names.flatMap(name => FILE.exec(name)?.[1]?.toLowerCase() ?? []))];

    // O banco decide a idade das chamadas conhecidas em ambos os armazenamentos. Uma
    // restauração pode alterar mtime; ele só serve de fallback para arquivos órfãos.
    const calls = await withOrg(deps.db, task.organizationId, q => q.many<{ id: string; expired: boolean; ended: boolean; archived: boolean; remotePending: boolean }>(
      `select id, expired, ended, archived, remote_pending as "remotePending" from (
         select id, (erased_at is not null or coalesce(ended_at < $1, false)) as expired, ended_at is not null as ended,
                recording_archived_at is not null as archived, recording_remote_purged_at is null as remote_pending
           from calls where id = any($2::uuid[]) or (recording_remote_purged_at is null and (erased_at is not null or ended_at < $1))) c`,
      [before, local]));

    // Primeiro termina TODAS as exclusões locais. Nem uma cópia recente nem uma remoção
    // remota podem impedir o expurgo seguinte, inclusive na reexecução da tarefa.
    const present = new Set(local);
    let recordings = 0;
    for (const call of calls) {
      if (!call.expired || !present.has(call.id)) continue;
      const file = recordingPath(deps.recordingsDir, task.organizationId, call.id);
      for (const target of [`${file}.part`, file]) {
        try { await rm(target); recordings += 1; }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) failures.push(error);
        }
      }
    }
    try {
      recordings += await purgeRecordings(deps.recordingsDir, task.organizationId, before, new Set(calls.map(call => call.id)));
    } catch (error) { failures.push(error); }
    if (recordings > 0) {
      try {
        await withOrg(deps.db, task.organizationId, q => recordOrgEvent(q, "recordings_purged", { recordings, retentionDays: days, before: before.toISOString() }, now));
      } catch (error) { failures.push(error); }
    }

    const wav = new Set(names.filter(name => name.endsWith(".wav")).map(name => name.slice(0, -4).toLowerCase()));
    for (const call of calls) {
      try {
        if (call.expired) {
          if (!call.remotePending) continue;
          await deps.recordingArchive?.remove(task.organizationId, call.id);
          // Sem destino remoto não há cópia a apagar: marcar mesmo assim evita reler a chamada todo dia.
          await withOrg(deps.db, task.organizationId, q => q.exec("update calls set recording_remote_purged_at = $2 where id = $1", [call.id, now]));
        } else if (call.ended && !call.archived && wav.has(call.id)) {
          const file = recordingPath(deps.recordingsDir, task.organizationId, call.id);
          await withOrg(deps.db, task.organizationId, async q => {
            if ((await lockCall(q, call.id)).erased) return;
            await sealLegacyRecording(file, deps.secretKey);
            if (!deps.recordingArchive) return;
            await deps.recordingArchive.put(task.organizationId, call.id, file);
            await q.exec("update calls set recording_archived_at = $2 where id = $1", [call.id, now]);
          });
        }
      } catch (error) { failures.push(error); }
    }
    // A fila tenta novamente, sem perder o expurgo já concluído nem deixar um item
    // inacessível impedir a tentativa dos demais objetos remotos.
    if (failures.length > 0) {
      const details = failures.map(error => error instanceof Error ? error.message : String(error)).join("; ");
      throw new AggregateError(failures, `Recording maintenance failed (${failures.length} operations): ${details}`);
    }
  },
};
export default routine;
