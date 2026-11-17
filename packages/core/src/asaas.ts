import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ASAAS_EVENTS, asaasClient, asaasEnvironment, asaasEvent, type AsaasEvent } from "./asaas-client";
import { recordOrgEvent } from "./events";
import { localDay } from "./metering";
import { PLAN_CATALOG, getPlanSubscription, setPlanSubscription, type PlanId } from "./plans";
import { enqueueTask } from "./queue";
import { decryptSecret, encryptSecret } from "./secrets";
import { DEFAULT_PERSONA_NAME, defaultProvisionInstructions, provisionTenant } from "./tenants";
import type { Db, OrgQuery } from "./types";
import { withOrg, withSystem } from "./with-org";

export const ASAAS_SETTING = "asaas.config";
const mapping = z.object({ subscriptionId: z.string().min(1).max(200), plan: z.enum(["starter", "pro", "growth", "scale", "custom"]), includedMinutes: z.number().int().min(0).max(10_000_000).optional(), maxConcurrentCalls: z.number().int().min(1).max(500).optional() }).superRefine((value, ctx) => {
  if (value.plan === "custom" && (value.includedMinutes === undefined || value.maxConcurrentCalls === undefined)) ctx.addIssue({ code: "custom", message: "Custom plans require includedMinutes and maxConcurrentCalls" });
});
export const asaasConfigInput = z.object({
  environment: asaasEnvironment,
  webhookToken: z.string().min(32).max(500).optional(),
  apiKey: z.string().min(1).max(500).optional(),
  mappings: z.array(mapping).max(500).refine((values) => new Set(values.map((v) => v.subscriptionId)).size === values.length, "Duplicate subscription mapping"),
});
const storedConfig = asaasConfigInput.extend({ webhookToken: z.string(), apiKey: z.string() });
export type AsaasConfig = z.output<typeof storedConfig>;
export function storeAsaasConfig(input: z.output<typeof asaasConfigInput>, previous: unknown, key: Buffer): AsaasConfig {
  const kept = storedConfig.safeParse(previous);
  const same = kept.success && kept.data.environment === input.environment ? kept.data : undefined;
  const webhookToken = input.webhookToken ? encryptSecret(input.webhookToken, key) : same?.webhookToken;
  const apiKey = input.apiKey ? encryptSecret(input.apiKey, key) : same?.apiKey;
  if (!webhookToken || !apiKey) throw new Error("Enter both Asaas secrets when selecting an environment");
  return { environment: input.environment, mappings: input.mappings, webhookToken, apiKey };
}
export async function readAsaasConfig(q: OrgQuery): Promise<AsaasConfig | null> {
  const row = await q.one<{ value: unknown }>("select value from settings where key = $1", [ASAAS_SETTING]);
  const parsed = storedConfig.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}
/** A rota pública descobre a plataforma sem usar uma organização enviada pelo pagador. */
export async function asaasPlatform(db: Db): Promise<string | null> {
  return withSystem(db, async (q) => (await q.one<{ id: string }>("select id from organizations where platform order by created_at, id limit 1"))?.id ?? null);
}
export function validAsaasToken(received: string, encrypted: string, key: Buffer): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(decryptSecret(encrypted, key)));
}
/** Validação remove todos os campos de dados pessoais antes da persistência. ACK só após commit. */
export async function receiveAsaasEvent(q: OrgQuery, environment: AsaasConfig["environment"], event: AsaasEvent, now: Date): Promise<{ repeated: boolean }> {
  const inserted = await q.one<{ id: string }>(`insert into asaas_events (organization_id, environment, event_id, event_kind, payload, received_at)
    values ($1, $2, $3, $4, $5, $6) on conflict (organization_id, environment, event_id) do nothing returning id`,
  [q.organizationId, environment, event.id, event.event, JSON.stringify(event), now]);
  if (inserted) await enqueueTask(q, { kind: "process_asaas_event", payload: { eventId: inserted.id }, runAt: now });
  return { repeated: !inserted };
}
export async function retryAsaasEvents(q: OrgQuery, now: Date): Promise<number> {
  await q.one("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`asaas-retry:${q.organizationId}`]);
  // A caixa mantém eventos mesmo depois do limite de tentativas da fila. Só a plataforma reenvia.
  const rows = await q.many<{ id: string }>(`select e.id from asaas_events e where e.processed_at is null
    and not exists (select from tasks t where t.organization_id = e.organization_id and t.kind = 'process_asaas_event'
      and t.payload->>'eventId' = e.id::text and t.status in ('queued', 'running')) for update`);
  for (const row of rows) await enqueueTask(q, { kind: "process_asaas_event", payload: { eventId: row.id }, runAt: now });
  return rows.length;
}

/** Consulta rede antes da transação. Aplicação, convite e recibo confirmam ou desfazem juntos. */
export async function processAsaasEvent(deps: { db: Db; secretKey: Buffer; fetch: typeof fetch }, platformId: string, eventId: string, now: Date): Promise<void> {
  try {
    const input = await withOrg(deps.db, platformId, async (q) => ({
      row: await q.one<{ payload: unknown; environment: AsaasConfig["environment"]; processed_at: Date | null }>("select payload, environment, processed_at from asaas_events where id = $1", [eventId]),
      config: await readAsaasConfig(q),
      bindings: await q.many<{ subscription_id: string; cancelled: boolean; tenant_id: string | null; revision: number }>("select subscription_id, cancelled, tenant_id, revision from asaas_subscriptions where environment = (select environment from asaas_events where id = $1)", [eventId]),
    }));
    if (!input.row || input.row.processed_at) return;
    const event = asaasEvent.parse(input.row.payload);
    const supported = (ASAAS_EVENTS as readonly string[]).includes(event.event);
    const subscriptionId = event.subscription?.id ?? event.payment?.subscription;
    if (!supported || !subscriptionId) {
      await withOrg(deps.db, platformId, (q) => q.exec("update asaas_events set processed_at = $2 where id = $1", [eventId, now]));
      return;
    }
    const known = input.bindings.find((row) => row.subscription_id === subscriptionId);
    if (known?.cancelled) {
      await withOrg(deps.db, platformId, (q) => q.exec("update asaas_events set processed_at = $2 where id = $1", [eventId, now]));
      return;
    }
    const config = input.config;
    if (!config || config.environment !== input.row.environment) throw new Error("Asaas configuration unavailable for event environment");
    const client = asaasClient(config.environment, decryptSecret(config.apiKey, deps.secretKey), deps.fetch);
    const deleting = event.event === "SUBSCRIPTION_DELETED";
    const subscription = deleting ? null : await client.subscription(subscriptionId);
    const customer = subscription && !known?.tenant_id ? await client.customer(subscription.customer) : null;
    await withSystem(deps.db, async (system) => {
      // Uma assinatura por vez, inclusive entre runners; locks por evento também evitam retries simultâneos.
      await system.one("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`asaas:${platformId}:${config.environment}:${subscriptionId}`]);
      const q = { ...system, organizationId: platformId };
      const receipt = await q.one<{ processed_at: Date | null }>("select processed_at from asaas_events where organization_id = $1 and id = $2 for update", [platformId, eventId]);
      if (!receipt || receipt.processed_at) return;
      let binding = await q.one<{ tenant_id: string | null; cancelled: boolean; inactive: boolean; subscription_event_at: string }>("select tenant_id, cancelled, inactive, subscription_event_at from asaas_subscriptions where organization_id = $1 and environment = $2 and subscription_id = $3 for update", [platformId, config.environment, subscriptionId]);
      if (!deleting && binding) {
        const current = await q.one<{ revision: number }>("select revision from asaas_subscriptions where organization_id = $1 and environment = $2 and subscription_id = $3", [platformId, config.environment, subscriptionId]);
        if (!known || known.revision !== current?.revision) throw new Error("Asaas snapshot changed; retry with current API state");
      }
      if (deleting && !binding && config.environment === "production") {
        const legacy = await system.one<{ organization_id: string }>("select organization_id from tenant_profiles where external_source = 'asaas' and external_ref = $1", [subscriptionId]);
        if (legacy) {
          await q.exec("insert into asaas_subscriptions (organization_id, environment, subscription_id, tenant_id) values ($1, $2, $3, $4)", [platformId, config.environment, subscriptionId, legacy.organization_id]);
          binding = { tenant_id: legacy.organization_id, cancelled: false, inactive: false, subscription_event_at: "" };
        }
      }
      if (deleting && !binding) {
        // Tombstone impede um evento antigo de criar/ativar depois de uma exclusão.
        await q.exec("insert into asaas_subscriptions (organization_id, environment, subscription_id, cancelled) values ($1, $2, $3, true)", [platformId, config.environment, subscriptionId]);
        await recordOrgEvent(q, "asaas_subscription_changed", { status: "cancelled", event: event.event }, now);
        await q.exec("update asaas_events set processed_at = $3 where organization_id = $1 and id = $2", [platformId, eventId, now]);
        return;
      }
      const explicit = config.mappings.find((value) => value.subscriptionId === subscriptionId);
      const cents = Math.round((subscription?.value ?? 0) * 100);
      const plan: PlanId | undefined = explicit?.plan ?? (Object.entries(PLAN_CATALOG).find(([, value]) => value.monthlyPriceCents === cents)?.[0] as PlanId | undefined);
      if (!deleting && !plan) throw new Error("Asaas plan mapping required");
      if (!binding && customer && plan) {
        // Fase 2 usava sub_… sem prefixo: adota esse vínculo apenas em produção.
        const legacy = config.environment === "production" && await system.one("select 1 from tenant_profiles where external_source = 'asaas' and external_ref = $1", [subscriptionId]);
        const result = await provisionTenant(deps.db, {
          source: "asaas", externalRef: legacy ? subscriptionId : `${config.environment}:${subscriptionId}`,
          company: { legalName: customer.name, tradeName: null, cnpj: null }, owner: { name: customer.name, email: customer.email.toLowerCase() },
          plan: { code: plan, monthlyMinutes: explicit?.includedMinutes ?? null },
          agent: { name: DEFAULT_PERSONA_NAME, personaName: DEFAULT_PERSONA_NAME, voiceId: null, basePrompt: "", instructions: defaultProvisionInstructions(DEFAULT_PERSONA_NAME, customer.name), greeting: null, engine: "simulated", tools: [] },
          secrets: [], requestedBy: platformId,
        }, now, system);
        if ("refused" in result) throw new Error("Asaas owner email already in use");
        await q.exec(`insert into asaas_subscriptions (organization_id, environment, subscription_id, tenant_id, owner_invite_enc, owner_invite_expires_at)
          values ($1, $2, $3, $4, $5, $6)`, [platformId, config.environment, subscriptionId, result.organizationId, result.ownerInvite ? encryptSecret(result.ownerInvite.token, deps.secretKey) : null, result.ownerInvite?.expiresAt ?? null]);
        binding = { tenant_id: result.organizationId, cancelled: false, inactive: false, subscription_event_at: "" };
      }
      if (!binding) throw new Error("Asaas binding missing");
      if (!binding.tenant_id || binding.cancelled) {
        await q.exec("update asaas_events set processed_at = $3 where organization_id = $1 and id = $2", [platformId, eventId, now]);
        return;
      }
      const scoped = { ...system, organizationId: binding.tenant_id };
      // SUBSCRIPTION_UPDATED pode chegar fora de ordem; consulta acima traz estado e valor atuais.
      // Cancelamento é terminal: pagamentos atrasados não ressuscitam uma assinatura excluída.
      const subscriptionEvent = event.event.startsWith("SUBSCRIPTION_");
      if (subscriptionEvent && !deleting && event.dateCreated < binding.subscription_event_at) {
        await q.exec("update asaas_events set processed_at = $3 where organization_id = $1 and id = $2", [platformId, eventId, now]);
        return;
      }
      if (deleting || (subscriptionEvent && event.dateCreated >= binding.subscription_event_at)) {
        binding.cancelled ||= deleting;
        binding.inactive = event.event === "SUBSCRIPTION_INACTIVATED" || subscription?.status !== "ACTIVE" || subscription.deleted;
        await q.exec("update asaas_subscriptions set cancelled = $4, inactive = $5, subscription_event_at = $6 where organization_id = $1 and environment = $2 and subscription_id = $3", [platformId, config.environment, subscriptionId, binding.cancelled, binding.inactive, event.dateCreated]);
      }
      if (event.payment) {
        const status = ["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(event.event) ? "paid" : event.event === "PAYMENT_OVERDUE" ? "overdue" : "refunded";
        await q.exec(`insert into asaas_payments (organization_id, environment, subscription_id, payment_id, status) values ($1, $2, $3, $4, $5)
          on conflict (organization_id, environment, payment_id) do update set status = case
            when asaas_payments.status = 'refunded' then 'refunded'
            when excluded.status = 'overdue' and asaas_payments.status = 'paid' then 'paid' else excluded.status end`, [platformId, config.environment, subscriptionId, event.payment.id, status]);
      }
      if (plan && !binding.cancelled && (subscriptionEvent || !known)) {
        const previous = await getPlanSubscription(scoped);
        if (previous?.plan !== plan || (plan === "custom" && (previous.monthlyPriceCents !== cents || previous.includedMinutes !== explicit?.includedMinutes || previous.maxConcurrentCalls !== explicit?.maxConcurrentCalls))) {
          const { day } = await localDay(scoped, now);
          await setPlanSubscription(scoped, { plan, overageRule: previous?.overageRule ?? "pause_outbound", overagePriceCentsPerMinute: previous?.overagePriceCentsPerMinute ?? 0,
            monthlyPriceCents: cents, includedMinutes: explicit?.includedMinutes, maxConcurrentCalls: explicit?.maxConcurrentCalls }, now, day);
        }
      }
      const payments = await q.one<{ paid: boolean; blocked: boolean }>(`select coalesce(bool_or(status = 'paid'), false) as paid, coalesce(bool_or(status <> 'paid'), false) as blocked
        from asaas_payments where organization_id = $1 and environment = $2 and subscription_id = $3`, [platformId, config.environment, subscriptionId]);
      const status = !binding.cancelled && !binding.inactive && subscription?.status === "ACTIVE" && !subscription.deleted && payments?.paid && !payments.blocked ? "active" : "suspended";
      await q.exec("update asaas_subscriptions set revision = revision + 1 where organization_id = $1 and environment = $2 and subscription_id = $3", [platformId, config.environment, subscriptionId]);
      await scoped.exec("update tenant_profiles set status = $2, updated_at = $3 where organization_id = $1", [binding.tenant_id, status, now]);
      await recordOrgEvent(scoped, "asaas_subscription_changed", { status: binding.cancelled ? "cancelled" : status, event: event.event, plan: plan ?? null }, now);
      await q.exec("update asaas_events set processed_at = $3 where organization_id = $1 and id = $2", [platformId, eventId, now]);
    });
  } catch {
    // Erros de banco e validação podem conter e-mail/valores; só este código vai à fila e aos logs.
    throw new Error("Asaas event processing failed; review configuration and retry retained events");
  }
}

/** A plataforma precisa saber se o dono de outra organização já aceitou, sem expor seus dados. */
export async function listAsaasBindings(db: Db, platformId: string, environment: AsaasConfig["environment"]) {
  return withSystem(db, (q) => q.many<{ subscriptionId: string; tenantId: string | null; cancelled: boolean; ownerInviteEnc: string | null; expiresAt: Date | null; accepted: boolean; inviteHash: string | null }>(`select s.subscription_id as "subscriptionId", s.tenant_id as "tenantId", s.cancelled, s.owner_invite_enc as "ownerInviteEnc", s.owner_invite_expires_at as "expiresAt",
    (select token_hash from invites i where i.organization_id = s.tenant_id and i.provisioned and i.revoked_at is null and i.accepted_at is null order by i.created_at desc limit 1) as "inviteHash",
    exists(select from users u where u.organization_id = s.tenant_id and u.role = 'owner') as accepted
    from asaas_subscriptions s where s.organization_id = $1 and s.environment = $2`, [platformId, environment]));
}
