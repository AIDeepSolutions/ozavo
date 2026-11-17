import { recordOrgEvent } from "./events";
import { getFinopsSummary, type FinopsSummary } from "./finops";
import { DEFAULT_TIMEZONE, getPeriodUsage, localDay } from "./metering";
import { PLAN_IDS, setPlanSubscription, type PlanId } from "./plans";
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

export interface PlatformTenantRow {
  organizationId: string;
  name: string;
  legalName: string | null;
  tradeName: string | null;
  /** Só os 14 dígitos. */
  cnpj: string | null;
  createdAt: Date;
  /** O código do plano vinculado (`starter`, ..., ou um código de fora). */
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

async function assertPlatform(q: OrgQuery, platformId: string): Promise<void> {
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
}

/** Só empresas clientes: a organização da plataforma não aparece como empresa. */
const ROWS_SQL = `
  select o.id as "organizationId", o.name, p.legal_name as "legalName", p.trade_name as "tradeName", p.cnpj, o.created_at as "createdAt",
         p.plan_code as "planCode", p.status as "profileStatus", p.external_source as source, coalesce(p.suspended_by_platform, false) as held,
         exists(select from asaas_subscriptions s where s.tenant_id = o.id and s.cancelled) as cancelled,
         exists(select from users u where u.organization_id = o.id and u.role = 'owner' and u.disabled_at is null) as "ownerActive",
         i.email as "inviteEmail", i.expires_at as "inviteExpiresAt",
         exists(select from plan_subscriptions s where s.organization_id = o.id) as "hasPlan",
         (select count(*)::int from phone_numbers n where n.organization_id = o.id) as lines,
         -- O disjuntor vale no dia da organização, no fuso dela (o mesmo critério de activeCadenceBreakers).
         (select count(*)::int from cadence_breakers b
           where b.organization_id = o.id
             and b.day = ($1::timestamptz at time zone coalesce((select timezone from outbound_policy op where op.organization_id = o.id), '${DEFAULT_TIMEZONE}'))::date) as "activeBreakers"
    from organizations o
    left join tenant_profiles p on p.organization_id = o.id
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
  };
}

/** As empresas clientes da instalação, da mais nova para a mais antiga. */
export function listPlatformTenants(db: Db, platformId: string, now: Date): Promise<PlatformTenantRow[]> {
  return asPlatform(db, platformId, async (q) => {
    const rows = await q.many<RawRow & { [key: string]: unknown }>(`${ROWS_SQL} order by o.created_at desc, o.id`, [now]);
    const result: PlatformTenantRow[] = [];
    for (const raw of rows) result.push(await toRow(q, raw, now));
    return result;
  });
}

/** Uma empresa cliente com o FinOps do ciclo e o registro da organização; `null` se não existe. */
export function getPlatformTenant(db: Db, platformId: string, tenantId: string, now: Date): Promise<PlatformTenantDetail | null> {
  return asPlatform(db, platformId, async (q) => {
    const raw = await q.one<RawRow & { [key: string]: unknown }>(`${ROWS_SQL} and o.id = $2`, [now, tenantId]);
    if (!raw) return null;
    const scoped = { ...q, organizationId: tenantId };
    const events = await q.many<PlatformTenantEvent & { [key: string]: unknown }>(
      "select id::text, at, kind, payload from organization_events where organization_id = $1 order by at desc, id desc limit $2",
      [tenantId, EVENT_LIMIT],
    );
    return { ...(await toRow(q, raw, now)), billedByAsaas: raw.source === "asaas", heldByPlatform: raw.held, finops: await getFinopsSummary(scoped, now), events };
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
