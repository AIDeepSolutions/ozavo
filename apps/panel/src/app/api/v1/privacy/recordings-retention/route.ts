import { z } from "zod";
import { RECORDING_RETENTION_SETTING, recordingRetentionOf, recordingRetentionSchema,
  scheduleRecordingMaintenance, recordOrgEvent } from "@ozavo/core";
import { handle } from "../../../../../server/context";

export const GET = handle({ configure: true }, async ({ q }) => {
  const stored = await q.one<{ value: unknown }>("select value from settings where key = $1", [RECORDING_RETENTION_SETTING]);
  return { days: recordingRetentionOf(stored?.value) };
});
export const PUT = handle({ configure: true, body: z.object({ days: recordingRetentionSchema }) }, async ({ q, body, deps, session }) => {
  const now = deps.clock.now();
  const stored = await q.one<{ value: unknown }>("select value from settings where key = $1", [RECORDING_RETENTION_SETTING]);
  const previous = recordingRetentionOf(stored?.value);
  if (previous !== body.days) {
    await q.exec(`insert into settings (organization_id, key, value, secret, updated_at) values ($1, $2, $3, false, $4)
      on conflict (organization_id, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [q.organizationId, RECORDING_RETENTION_SETTING, JSON.stringify(body.days), now]);
    await recordOrgEvent(q, "recording_retention_changed", { from: previous, to: body.days }, now, session.userId);
  }
  // Reprograma a próxima passagem para agora; nunca cria duas correntes.
  await scheduleRecordingMaintenance(q, now, true);
  return { days: body.days };
});
