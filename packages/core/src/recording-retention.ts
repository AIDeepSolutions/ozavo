import { z } from "zod";
import { enqueueTask, TASKS_CHANNEL } from "./queue";
import { withOrg, withSystem } from "./with-org";
import type { Db, OrgQuery } from "./types";

export const RECORDING_RETENTION_SETTING = "recordings.retention_days";
export const RECORDING_MAINTENANCE_TASK = "maintain_recordings";
export const recordingRetentionSchema = z.number().int().min(90).max(3650);
export function recordingRetentionOf(stored: unknown): number {
  const value = recordingRetentionSchema.safeParse(stored);
  return value.success ? value.data : 90;
}
export async function scheduleRecordingMaintenance(q: OrgQuery, at: Date, advance = false): Promise<void> {
  // Serializa a criação da corrente por organização, inclusive entre dois processos.
  await q.exec("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`recordings:${q.organizationId}`]);
  const queued = await q.one<{ id: string }>("select id from tasks where kind = $1 and status = 'queued'", [RECORDING_MAINTENANCE_TASK]);
  if (!queued) await enqueueTask(q, { kind: RECORDING_MAINTENANCE_TASK, payload: {}, runAt: at });
  else if (advance) {
    await q.exec("update tasks set run_at = least(run_at, $2) where id = $1", [queued.id, at]);
    // O trigger só notifica INSERT: uma antecipação também precisa acordar o consumidor.
    await q.exec("select pg_notify($1, $2)", [TASKS_CHANNEL, queued.id]);
  }
}
/** Bootstrap só na partida: organizações novas também entram ao abrir uma gravação. */
export async function bootstrapRecordingMaintenance(db: Db, at: Date): Promise<void> {
  const organizations = await withSystem(db, q => q.many<{ id: string }>("select id from organizations"));
  for (const { id } of organizations) await withOrg(db, id, q => scheduleRecordingMaintenance(q, at));
}
