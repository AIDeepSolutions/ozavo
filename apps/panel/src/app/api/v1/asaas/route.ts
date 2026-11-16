import { ASAAS_SETTING, asaasConfigInput, listAsaasBindings, decryptSecret, hashToken, readAsaasConfig, recordOrgEvent, retryAsaasEvents, storeAsaasConfig } from "@ozavo/core";
import { ApiError, handle } from "../../../../server/context";

export const GET = handle({ platform: true }, async ({ q, deps }) => {
  const config = await readAsaasConfig(q);
  const events = await q.many<{ id: string; event: string; receivedAt: Date; processedAt: Date | null }>(`select id, event_kind as event, received_at as "receivedAt", processed_at as "processedAt" from asaas_events order by received_at desc, id desc limit 50`);
  const bindings = await listAsaasBindings(deps.db, q.organizationId, config?.environment ?? "sandbox");
  return { environment: config?.environment ?? "sandbox", configured: config !== null, mappings: config?.mappings ?? [],
    webhookUrl: `${deps.publicUrl}/api/v1/webhooks/asaas`, events,
    subscriptions: bindings.map(({ ownerInviteEnc, expiresAt, accepted, inviteHash, ...binding }) => ({ ...binding,
      ...(ownerInviteEnc && expiresAt && expiresAt > deps.clock.now() && !accepted && hashToken(decryptSecret(ownerInviteEnc, deps.secretKey)) === inviteHash ? { ownerInviteUrl: `${deps.publicUrl}/invite/${decryptSecret(ownerInviteEnc, deps.secretKey)}` } : {}),
    })),
  };
});
export const PUT = handle({ platform: true, body: asaasConfigInput }, async ({ q, body, session, deps }) => {
  let stored;
  try { stored = storeAsaasConfig(body, await readAsaasConfig(q), deps.secretKey); }
  catch { throw new ApiError(400, "validation_error", "Enter both Asaas secrets when selecting an environment."); }
  await q.exec(`insert into settings (organization_id, key, value, secret, updated_at) values ($1, $2, $3, true, $4)
    on conflict (organization_id, key) do update set value = excluded.value, secret = true, updated_at = excluded.updated_at`, [q.organizationId, ASAAS_SETTING, JSON.stringify(stored), deps.clock.now()]);
  await recordOrgEvent(q, "asaas_config_changed", { environment: body.environment, mappingCount: body.mappings.length }, deps.clock.now(), session.userId);
  return { configured: true };
});
export const POST = handle({ platform: true }, async ({ q, deps }) => ({ queued: await retryAsaasEvents(q, deps.clock.now()) }));
