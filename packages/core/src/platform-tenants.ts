import { recordOrgEvent } from "./events";
import { normalizeRcdName, type RcdLogoSet } from "./rcd";
import { getFinopsSummary, type FinopsSummary } from "./finops";
import { DEFAULT_TIMEZONE, getPeriodUsage, localDay } from "./metering";
import { PLAN_IDS, setPlanSubscription, type PlanId, type PlanSubscription, type PlanSubscriptionInput } from "./plans";
import { issueOwnerInvite, provisionTenant, type OwnerInvite, type ProvisionInput, type TenantStatus } from "./tenants";
import type { Db, OrgEventKind, OrgQuery } from "./types";
import { withSystem } from "./with-org";

/**
 * A área de plataforma do painel: a organização que administra a instalação vê, cria, suspende e
 * reativa as empresas clientes. Toda leitura aqui atravessa organizações pelo papel de sistema, e
 * por isso mora no core: cada função confere de novo, na mesma transação, que quem pede é a
 * plataforma. A rota já conferiu (`handle({ platform: true })`); a segunda conferência é o que
 * impede que um chamador esquecido abra os dados de todas as empresas.
 *
 * Só sai daqui o que a plataforma precisa para administrar: cadastro, plano, consumo e o registro
 * da organização. Nenhum dado de ligação, contato ou transcrição de uma empresa cliente.
 */

/** O status que a tela mostra: `cancelled` vem da assinatura do Asaas ligada à empresa. */
export const PLATFORM_TENANT_STATUSES = ["active", "suspended", "cancelled"] as const;
export type PlatformTenantStatus = (typeof PLATFORM_TENANT_STATUSES)[number];

/** A origem: `asaas` (webhook nativo), `panel` (esta tela) ou o nome de quem chamou a API. */
export type TenantOrigin = { kind: "asaas" } | { kind: "panel" } | { kind: "api"; source: string } | { kind: "unknown" };

export class PlatformOnlyError extends Error {
  readonly code = "platform_only";
  constructor() {
    super("Only the organization that runs this installation can manage companies.");
  }
}

export interface OwnerInviteState {
  /** O dono já aceitou: não há convite a renovar. */
  ownerActive: boolean;
  /** O convite de dono em aberto (não aceito, não revogado), se houver. */
  pending: { email: string; expiresAt: Date; expired: boolean } | null;
}

/** Os itens da lista de prontidão, na ordem em que a tela os mostra. */
export const READINESS_KEYS = ["ownerAccepted", "engineKey", "voiceAgent", "line", "outboundPolicy", "plan"] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

/**
 * O que falta para a empresa operar. Cada item é só `configured` ou `missing`: nenhuma chave, e-mail,
 * número ou texto da empresa sai daqui. `required: false` é informativo (a política de saída só vale
 * para quem vai ligar) e não entra em `ready`.
 */
export interface TenantReadiness {
  items: Array<{ key: ReadinessKey; status: "configured" | "missing"; required: boolean }>;
  /** Todos os itens obrigatórios estão configurados. */
  ready: boolean;
  /** Quantos itens obrigatórios faltam. */
  missingRequired: number;
  /** Empresa suspensa ou cancelada: não opera, mesmo com tudo configurado. `null` quando está ativa. */
  blockedBy: "suspended" | "cancelled" | null;
}

export type ReadinessFlags = Record<ReadinessKey, boolean>;

/**
 * Monta a lista a partir de fatos já reduzidos a sim/não. Só a política de saída é informativa.
 * Empresa suspensa ou cancelada nunca fica `ready`: o estado dela vence a configuração.
 */
export function tenantReadiness(flags: ReadinessFlags, status: PlatformTenantStatus = "active"): TenantReadiness {
  const items = READINESS_KEYS.map((key) => ({ key, status: flags[key] ? ("configured" as const) : ("missing" as const), required: key !== "outboundPolicy" }));
  const missingRequired = items.filter((item) => item.required && item.status === "missing").length;
  const blockedBy = status === "active" ? null : status;
  return { items, ready: missingRequired === 0 && blockedBy === null, missingRequired, blockedBy };
}

export interface PlatformTenantRow {
  organizationId: string;
  name: string;
  legalName: string | null;
  tradeName: string | null;
  /** Só os 14 dígitos. */
  cnpj: string | null;
  createdAt: Date;
  /** O plano contratado em `plan_subscriptions`, a fonte única do plano; `null` sem plano. */
  planCode: string | null;
  status: PlatformTenantStatus;
  origin: TenantOrigin;
  /** A franquia do ciclo em curso; `null` quando a empresa não tem plano contratado. */
  usage: { consumedSeconds: number; includedSeconds: number; period: { start: string; end: string } } | null;
  /** O maior limiar de franquia alcançado no ciclo em curso (80 ou 100), ou `null`. */
  usageAlert: number | null;
  /** Quantas linhas da empresa estão com a cadência reduzida hoje pelo disjuntor de chamadas curtas. */
  activeBreakers: number;
  /** Quantos números de telefone a empresa tem. */
  lines: number;
  ownerInvite: OwnerInviteState;
  readiness: TenantReadiness;
}

export interface PlatformTenantEvent {
  id: string;
  at: Date;
  kind: string;
  payload: Record<string, unknown>;
}

export interface PlatformTenantDetail extends PlatformTenantRow {
  /** O cadastro vem do Asaas: o próximo evento de cobrança recalcula o status, salvo a trava abaixo. */
  billedByAsaas: boolean;
  /** Suspensa pela plataforma: o Asaas não reativa até a plataforma reativar. */
  heldByPlatform: boolean;
  finops: FinopsSummary;
  /** A identidade RCD da empresa; as linhas sem valor próprio herdam estes. Nunca leva os bytes do logo. */
  rcd: { displayName: string | null; hasLogo: boolean; logoBytes: { png: number; bmp: number } | null };
  events: PlatformTenantEvent[];
}

export function displayStatus(profileStatus: TenantStatus | null, cancelledInAsaas: boolean): PlatformTenantStatus {
  if (cancelledInAsaas) return "cancelled";
  return profileStatus ?? "active";
}

export function tenantOrigin(source: string | null): TenantOrigin {
  if (source === null) return { kind: "unknown" };
  if (source === "asaas") return { kind: "asaas" };
  if (source === PANEL_SOURCE) return { kind: "panel" };
  return { kind: "api", source };
}

/** A origem gravada em `tenant_profiles.external_source` para a empresa criada nesta tela. */
export const PANEL_SOURCE = "panel";
const EVENT_LIMIT = 50;

/** Recusa com `PlatformOnlyError` quem não é a organização da plataforma. Dentro de `withSystem`. */
export async function assertPlatform(q: OrgQuery, platformId: string): Promise<void> {
  const row = await q.one<{ platform: boolean }>("select platform from organizations where id = $1", [platformId]);
  if (row?.platform !== true) throw new PlatformOnlyError();
}

/** Transação de sistema que só começa depois de conferir que quem pede é a plataforma. */
function asPlatform<T>(db: Db, platformId: string, fn: (q: OrgQuery) => Promise<T>): Promise<T> {
  return withSystem(db, async (q) => {
    await assertPlatform(q, platformId);
    return fn(q);
  });
}

interface RawRow {
  organizationId: string;
  name: string;
  legalName: string | null;
  tradeName: string | null;
  cnpj: string | null;
  createdAt: Date;
  planCode: string | null;
  profileStatus: TenantStatus | null;
  source: string | null;
  cancelled: boolean;
  ownerActive: boolean;
  inviteEmail: string | null;
  inviteExpiresAt: Date | null;
  held: boolean;
  hasPlan: boolean;
  lines: number;
  activeBreakers: number;
  hasEngineKey: boolean;
  hasVoiceAgent: boolean;
  outboundConfigured: boolean;
}

/** Só empresas clientes: a organização da plataforma não aparece como empresa. */
const ROWS_SQL = `
  select o.id as "organizationId", o.name, p.legal_name as "legalName", p.trade_name as "tradeName", p.cnpj, o.created_at as "createdAt",
         s.plan as "planCode", p.status as "profileStatus", p.external_source as source, coalesce(p.suspended_by_platform, false) as held,
         exists(select from asaas_subscriptions a where a.tenant_id = o.id and a.cancelled) as cancelled,
         exists(select from users u where u.organization_id = o.id and u.role = 'owner' and u.disabled_at is null) as "ownerActive",
         i.email as "inviteEmail", i.expires_at as "inviteExpiresAt",
         s.organization_id is not null as "hasPlan",
         -- Prontidão: só booleanos saem daqui, nunca o valor da chave (a coluna do valor nem é lida).
         -- A chave é a do motor de um agente habilitado (a mesma que a chamada lê); motor sem chave ($2) conta como pronto.
         exists(select from agents ag
                 where ag.organization_id = o.id and ag.enabled
                   and (ag.engine = any($2::text[])
                        or exists(select from settings st where st.organization_id = o.id and st.secret and st.key = 'engine.' || ag.engine || '.api_key'))) as "hasEngineKey",
         exists(select from agents ag where ag.organization_id = o.id and ag.enabled) as "hasVoiceAgent",
         coalesce((select op.enabled from outbound_policy op where op.organization_id = o.id), false) as "outboundConfigured",
         (select count(*)::int from phone_numbers n where n.organization_id = o.id) as lines,
         -- O disjuntor vale no dia da organização, no fuso dela (o mesmo critério de activeCadenceBreakers).
         (select count(*)::int from cadence_breakers b
           where b.organization_id = o.id
             and b.day = ($1::timestamptz at time zone coalesce((select timezone from outbound_policy op where op.organization_id = o.id), '${DEFAULT_TIMEZONE}'))::date) as "activeBreakers"
    from organizations o
    left join tenant_profiles p on p.organization_id = o.id
    left join plan_subscriptions s on s.organization_id = o.id
    left join lateral (select email, expires_at from invites
                        where organization_id = o.id and role = 'owner' and accepted_at is null and revoked_at is null
                        order by created_at desc limit 1) i on true
   where not o.platform`;

async function toRow(q: OrgQuery, raw: RawRow, now: Date): Promise<PlatformTenantRow> {
  // As funções de medição filtram pela organização informada: dentro do papel de sistema, é esse
  // filtro que segura cada consulta na empresa da linha.
  // Sem plano não há ciclo a medir: a consulta por empresa só roda para quem tem plano, e as
  // contagens de linhas e do disjuntor já vieram na consulta da lista.
  const usage = raw.hasPlan ? await getPeriodUsage({ ...q, organizationId: raw.organizationId }, now) : null;
  const alert = usage
    ? await q.one<{ threshold: number }>("select max(threshold)::int as threshold from usage_alerts where organization_id = $1 and period_start = $2::date", [raw.organizationId, usage.period.start])
    : null;
  return {
    organizationId: raw.organizationId,
    name: raw.name,
    legalName: raw.legalName,
    tradeName: raw.tradeName,
    cnpj: raw.cnpj,
    createdAt: raw.createdAt,
    planCode: raw.planCode,
    status: displayStatus(raw.profileStatus, raw.cancelled),
    origin: tenantOrigin(raw.source),
    usage: usage && { consumedSeconds: usage.consumedSeconds, includedSeconds: usage.includedSeconds, period: usage.period },
    usageAlert: alert?.threshold ?? null,
    activeBreakers: raw.activeBreakers,
    lines: raw.lines,
    ownerInvite: {
      ownerActive: raw.ownerActive,
      pending:
        raw.ownerActive || raw.inviteEmail === null || raw.inviteExpiresAt === null
          ? null
          : { email: raw.inviteEmail, expiresAt: raw.inviteExpiresAt, expired: raw.inviteExpiresAt.getTime() <= now.getTime() },
    },
    readiness: tenantReadiness(
      { ownerAccepted: raw.ownerActive, engineKey: raw.hasEngineKey, voiceAgent: raw.hasVoiceAgent, line: raw.lines > 0, outboundPolicy: raw.outboundConfigured, plan: raw.hasPlan },
      displayStatus(raw.profileStatus, raw.cancelled),
    ),
  };
}

/** As empresas clientes da instalação, da mais nova para a mais antiga. */
export function listPlatformTenants(db: Db, platformId: string, now: Date, keylessEngines: readonly string[] = []): Promise<PlatformTenantRow[]> {
  return asPlatform(db, platformId, async (q) => {
    const rows = await q.many<RawRow & { [key: string]: unknown }>(`${ROWS_SQL} order by o.created_at desc, o.id`, [now, keylessEngines]);
    const result: PlatformTenantRow[] = [];
    for (const raw of rows) result.push(await toRow(q, raw, now));
    return result;
  });
}

/** Uma empresa cliente com o FinOps do ciclo e o registro da organização; `null` se não existe. */
export function getPlatformTenant(db: Db, platformId: string, tenantId: string, now: Date, keylessEngines: readonly string[] = []): Promise<PlatformTenantDetail | null> {
  return asPlatform(db, platformId, async (q) => {
    const raw = await q.one<RawRow & { [key: string]: unknown }>(`${ROWS_SQL} and o.id = $3`, [now, keylessEngines, tenantId]);
    if (!raw) return null;
    const scoped = { ...q, organizationId: tenantId };
    const events = await q.many<PlatformTenantEvent & { [key: string]: unknown }>(
      "select id::text, at, kind, payload from organization_events where organization_id = $1 order by at desc, id desc limit $2",
      [tenantId, EVENT_LIMIT],
    );
    const rcd = await q.one<{ name: string | null; png: number | null; bmp: number | null }>(
      "select rcd_display_name as name, octet_length(rcd_logo_png) as png, octet_length(rcd_logo_bmp) as bmp from tenant_profiles where organization_id = $1",
      [tenantId],
    );
    return {
      ...(await toRow(q, raw, now)),
      billedByAsaas: raw.source === "asaas",
      heldByPlatform: raw.held,
      finops: await getFinopsSummary(scoped, now),
      rcd: { displayName: rcd?.name ?? null, hasLogo: rcd?.png != null, logoBytes: rcd?.png != null && rcd.bmp != null ? { png: rcd.png, bmp: rcd.bmp } : null },
      events,
    };
  });
}

export interface PanelTenantInput {
  /** Gerado pela tela, um por formulário: o mesmo envio repetido devolve a mesma empresa. */
  requestId: string;
  /** A razão social. */
  companyName: string;
  /** O nome fantasia: quando informado, é o nome da organização no painel. */
  tradeName?: string | null;
  /** Só os 14 dígitos, já conferidos com `normalizeCnpj`. */
  cnpj?: string | null;
  owner: { name: string; email: string };
  plan: PlanId;
  /** Só no plano Personalizado. */
  custom?: { monthlyPriceCents: number; includedMinutes: number; maxConcurrentCalls: number };
  /** `suspended`: a empresa nasce suspensa até o pagamento. */
  initialStatus: TenantStatus;
  agent: ProvisionInput["agent"];
  /** Identidade RCD opcional, com o nome já normalizado. */
  rcd?: ProvisionInput["rcd"];
}

export type PanelTenantResult =
  | { created: boolean; organizationId: string; ownerInvite: OwnerInvite | null }
  | { refused: "email_taken" };

/**
 * Cria a empresa pelo mesmo caminho do provisionamento por API (`provisionTenant`), na mesma
 * transação de sistema em que o plano Personalizado é contratado e o status inicial é gravado.
 * O dono recebe um convite de uso único; nenhuma senha passa pela plataforma.
 */
export function createPlatformTenant(db: Db, platformId: string, actorUserId: string, input: PanelTenantInput, now: Date): Promise<PanelTenantResult> {
  if (!PLAN_IDS.includes(input.plan)) return Promise.reject(new Error(`Unknown plan ${JSON.stringify(input.plan)}`));
  if (input.plan === "custom" && !input.custom) return Promise.reject(new Error("The custom plan needs price, minutes and concurrent calls"));
  return asPlatform(db, platformId, async (q) => {
    const result = await provisionTenant(
      db,
      {
        source: PANEL_SOURCE,
        externalRef: input.requestId,
        company: { legalName: input.companyName, tradeName: input.tradeName ?? null, cnpj: input.cnpj ?? null },
        owner: input.owner,
        plan: { code: input.plan, monthlyMinutes: input.custom?.includedMinutes ?? null },
        agent: input.agent,
        secrets: [],
        requestedBy: platformId,
        rcd: input.rcd,
      },
      now,
      q,
    );
    if ("refused" in result) return result;
    if (result.created) {
      const scoped = { ...q, organizationId: result.organizationId };
      if (input.plan === "custom" && input.custom) {
        const { day } = await localDay(scoped, now);
        await setPlanSubscription(scoped, { plan: "custom", overageRule: "pause_outbound", overagePriceCentsPerMinute: 0, ...input.custom }, now, day);
      }
      if (input.initialStatus !== "active") await writeStatus(q, platformId, actorUserId, result.organizationId, input.initialStatus, false, now);
      await recordOrgEvent({ ...q, organizationId: platformId }, "tenant_provisioned", { tenantId: result.organizationId, source: PANEL_SOURCE, planCode: input.plan }, now, actorUserId);
    }
    return { created: result.created, organizationId: result.organizationId, ownerInvite: result.ownerInvite ?? null };
  });
}

/**
 * Grava o status e registra dos dois lados: na empresa (sem autor, porque quem fez é de outra
 * organização; o id vai no corpo) e na plataforma (com autor).
 *
 * `held`: a suspensão foi decidida pela plataforma e vence o Asaas até a plataforma reativar
 * (`tenant_profiles.suspended_by_platform`). A situação inicial "suspensa até o pagamento" não
 * segura: o pagamento confirmado no Asaas reativa.
 */
async function writeStatus(q: OrgQuery, platformId: string, actorUserId: string, tenantId: string, status: TenantStatus, held: boolean, now: Date): Promise<void> {
  await q.exec(
    `insert into tenant_profiles (organization_id, status, suspended_by_platform, created_at, updated_at) values ($1, $2, $3, $4, $4)
     on conflict (organization_id) do update set status = excluded.status, suspended_by_platform = excluded.suspended_by_platform, updated_at = excluded.updated_at`,
    [tenantId, status, held, now],
  );
  await logBothSides(q, platformId, actorUserId, tenantId, "tenant_status_changed", { status, heldByPlatform: held }, now);
}

async function logBothSides(q: OrgQuery, platformId: string, actorUserId: string, tenantId: string, kind: OrgEventKind, payload: object, now: Date): Promise<void> {
  await recordOrgEvent({ ...q, organizationId: tenantId }, kind, { ...payload, byOrganizationId: platformId, byUserId: actorUserId }, now);
  await recordOrgEvent({ ...q, organizationId: platformId }, kind, { ...payload, tenantId }, now, actorUserId);
}

async function tenantExists(q: OrgQuery, tenantId: string): Promise<boolean> {
  return (await q.one("select 1 as hit from organizations where id = $1 and not platform", [tenantId])) !== null;
}

/**
 * Suspende ou reativa. A suspensão daqui segura a empresa suspensa até a plataforma reativar, mesmo
 * que o Asaas confirme pagamento; reativar solta a trava. Devolve `false` quando a empresa não existe;
 * o mesmo estado não registra de novo.
 */
export function setPlatformTenantStatus(db: Db, platformId: string, actorUserId: string, tenantId: string, status: TenantStatus, now: Date): Promise<boolean> {
  return asPlatform(db, platformId, async (q) => {
    if (!(await tenantExists(q, tenantId))) return false;
    const current = await q.one<{ status: TenantStatus; held: boolean }>("select status, suspended_by_platform as held from tenant_profiles where organization_id = $1 for update", [tenantId]);
    const held = status === "suspended";
    if ((current?.status ?? "active") !== status || (current?.held ?? false) !== held) await writeStatus(q, platformId, actorUserId, tenantId, status, held, now);
    return true;
  });
}

export type RenewInviteResult = { ok: true; invite: OwnerInvite; email: string } | { ok: false; reason: "not_found" | "owner_active" | "no_invite" };

/**
 * Emite um convite de dono novo para a empresa cujo dono ainda não entrou, com o e-mail e o nome
 * do último convite de dono, e revoga o anterior. É o caminho de quem perdeu o link ou deixou
 * vencer: o token volta uma vez, só nesta resposta.
 */
export function renewOwnerInvite(db: Db, platformId: string, actorUserId: string, tenantId: string, now: Date): Promise<RenewInviteResult> {
  return asPlatform(db, platformId, async (q) => {
    if (!(await tenantExists(q, tenantId))) return { ok: false, reason: "not_found" };
    const owner = await q.one("select 1 as hit from users where organization_id = $1 and role = 'owner' and disabled_at is null", [tenantId]);
    if (owner) return { ok: false, reason: "owner_active" };
    const last = await q.one<{ email: string; name: string }>(
      "select email, name from invites where organization_id = $1 and role = 'owner' and accepted_at is null order by created_at desc limit 1",
      [tenantId],
    );
    if (!last) return { ok: false, reason: "no_invite" };
    const invite = await issueOwnerInvite(q, tenantId, last, now);
    await logBothSides(q, platformId, actorUserId, tenantId, "tenant_owner_invite_renewed", { expiresAt: invite.expiresAt.toISOString() }, now);
    return { ok: true, invite, email: last.email };
  });
}

/**
 * Troca o plano de uma empresa cliente, do catálogo ou Personalizado, pelo único caminho que grava
 * plano (`setPlanSubscription`). Na empresa, `plan_changed` leva no corpo quem trocou; na plataforma,
 * `tenant_plan_changed` tem autor. Sem `cycleStartedOn`, o ciclo continua de onde estava.
 * Devolve `null` quando a empresa não existe.
 */
export function setPlatformTenantPlan(db: Db, platformId: string, actorUserId: string, tenantId: string, input: PlanSubscriptionInput, now: Date): Promise<PlanSubscription | null> {
  return asPlatform(db, platformId, async (q) => {
    if (!(await tenantExists(q, tenantId))) return null;
    const scoped = { ...q, organizationId: tenantId };
    const { day } = await localDay(scoped, now);
    const saved = await setPlanSubscription(scoped, input, now, day, null, { byOrganizationId: platformId, byUserId: actorUserId });
    await recordOrgEvent({ ...q, organizationId: platformId }, "tenant_plan_changed", { tenantId, plan: saved.plan, includedMinutes: saved.includedMinutes, overageRule: saved.overageRule }, now, actorUserId);
    return saved;
  });
}

/**
 * Grava ou limpa o nome RCD da empresa. `displayName` chega em qualquer grafia e é normalizado aqui
 * (acento fora, CAIXA ALTA, até 32 ASCII); `null`, vazio ou só espaços limpam. Devolve `invalid` quando não cabe, `false`
 * quando a empresa não existe. Registra `tenant_rcd_changed` dos dois lados, sem o valor do logo.
 */
export function setPlatformTenantRcdName(db: Db, platformId: string, actorUserId: string, tenantId: string, displayName: string | null, now: Date): Promise<{ displayName: string | null } | "invalid" | false> {
  const clearing = displayName === null || displayName.trim() === "";
  const name = clearing ? null : normalizeRcdName(displayName);
  if (!clearing && name === null) return Promise.resolve("invalid");
  return asPlatform(db, platformId, async (q) => {
    if (!(await tenantExists(q, tenantId))) return false;
    await q.exec(
      `insert into tenant_profiles (organization_id, rcd_display_name, created_at, updated_at) values ($1, $2, $3, $3)
       on conflict (organization_id) do update set rcd_display_name = excluded.rcd_display_name, updated_at = excluded.updated_at`,
      [tenantId, name, now],
    );
    await logBothSides(q, platformId, actorUserId, tenantId, "tenant_rcd_changed", { field: "name", action: name === null ? "removed" : "set", displayName: name }, now);
    return { displayName: name };
  });
}

/** Troca (`logo`) ou remove (`null`) o logo RCD da empresa. `false` quando a empresa não existe. */
export function setPlatformTenantRcdLogo(db: Db, platformId: string, actorUserId: string, tenantId: string, logo: RcdLogoSet | null, now: Date): Promise<boolean> {
  return asPlatform(db, platformId, async (q) => {
    if (!(await tenantExists(q, tenantId))) return false;
    await q.exec(
      `insert into tenant_profiles (organization_id, rcd_logo_png, rcd_logo_bmp, created_at, updated_at) values ($1, $2, $3, $4, $4)
       on conflict (organization_id) do update set rcd_logo_png = excluded.rcd_logo_png, rcd_logo_bmp = excluded.rcd_logo_bmp, updated_at = excluded.updated_at`,
      [tenantId, logo?.png ?? null, logo?.bmp ?? null, now],
    );
    await logBothSides(q, platformId, actorUserId, tenantId, "tenant_rcd_changed", { field: "logo", action: logo === null ? "removed" : "set", ...(logo && { pngBytes: logo.png.length, bmpBytes: logo.bmp.length }) }, now);
    return true;
  });
}

/** Os dois arquivos do logo RCD, para download; `null` sem empresa ou sem logo. */
export function getPlatformTenantRcdLogo(db: Db, platformId: string, tenantId: string): Promise<RcdLogoSet | null> {
  return asPlatform(db, platformId, async (q) => {
    const row = await q.one<{ png: Buffer | null; bmp: Buffer | null }>(
      "select p.rcd_logo_png as png, p.rcd_logo_bmp as bmp from tenant_profiles p join organizations o on o.id = p.organization_id where p.organization_id = $1 and not o.platform",
      [tenantId],
    );
    return row?.png && row.bmp ? { png: row.png, bmp: row.bmp } : null;
  });
}
