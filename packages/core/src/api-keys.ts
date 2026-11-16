import { randomBytes } from "node:crypto";
import { recordOrgEvent } from "./events";
import { hashToken } from "./password";
import type { Db, OrgQuery } from "./types";
import { withSystem } from "./with-org";

/**
 * O que uma chave de API pode fazer. Fechado aqui e no `check` da tabela `api_keys`: escopo novo
 * entra nos dois lugares, na mesma migration.
 *
 * - `calls:outbound`: pedir uma ligação de saída (`POST /api/v1/calls/outbound`). A ligação passa
 *   pela mesma política de saída de qualquer outra (`checkOutboundAllowed`).
 * - `tenants:provision`: criar uma empresa nova (`POST /api/v1/tenants/provision`). Só a organização
 *   que administra a instalação (`organizations.platform`) emite chave com este escopo.
 */
export const API_KEY_SCOPES = ["calls:outbound", "tenants:provision"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Os escopos que só a organização da plataforma pode ter. */
export const PLATFORM_SCOPES: readonly ApiKeyScope[] = ["tenants:provision"];

const KEY_PREFIX = "ozk_";
// 32 bytes aleatórios: o resumo sha256 sem sal basta, porque não há o que adivinhar por dicionário.
const KEY_BYTES = 32;
// O que a tela mostra para identificar a chave: o prefixo e os primeiros caracteres do segredo.
const VISIBLE_CHARS = 8;
const TOKEN = /^ozk_[A-Za-z0-9_-]{43}$/;

export interface ApiKeyPrincipal {
  id: string;
  organizationId: string;
  name: string;
  scopes: ApiKeyScope[];
  /** A organização da chave administra a instalação. */
  platform: boolean;
}

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Uma chave nova: o texto em claro (mostrado uma vez), o começo visível e o resumo que o banco guarda. */
export function generateApiKey(): { token: string; prefix: string; hash: string } {
  const token = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { token, prefix: token.slice(0, KEY_PREFIX.length + VISIBLE_CHARS), hash: hashToken(token) };
}

/** A organização da transação administra a instalação. */
export async function isPlatformOrganization(q: OrgQuery): Promise<boolean> {
  const row = await q.one<{ platform: boolean }>("select platform from organizations where id = $1", [q.organizationId]);
  return row?.platform === true;
}

/**
 * Cria a chave na organização da transação e devolve o texto em claro, que não volta a existir.
 * Escopo de plataforma em organização que não é a da plataforma é recusado antes de gravar.
 */
export async function createApiKey(
  q: OrgQuery,
  input: { name: string; scopes: readonly ApiKeyScope[]; createdBy: string | null },
  now: Date,
): Promise<{ id: string; token: string; prefix: string } | { refused: "platform_scope" }> {
  const scopes = [...new Set(input.scopes)];
  if (scopes.some((scope) => PLATFORM_SCOPES.includes(scope)) && !(await isPlatformOrganization(q))) return { refused: "platform_scope" };
  const key = generateApiKey();
  const row = await q.one<{ id: string }>(
    "insert into api_keys (organization_id, name, key_prefix, key_hash, scopes, created_by, created_at) values ($1, $2, $3, $4, $5, $6, $7) returning id",
    [q.organizationId, input.name, key.prefix, key.hash, scopes, input.createdBy, now],
  );
  if (!row) throw new Error("API key was not created");
  await recordOrgEvent(q, "api_key_created", { apiKeyId: row.id, name: input.name, prefix: key.prefix, scopes }, now, input.createdBy);
  return { id: row.id, token: key.token, prefix: key.prefix };
}

export function listApiKeys(q: OrgQuery): Promise<ApiKeyView[]> {
  return q.many<ApiKeyView & { [key: string]: unknown }>(
    `select id, name, key_prefix as prefix, scopes, created_at as "createdAt", last_used_at as "lastUsedAt", revoked_at as "revokedAt"
       from api_keys where organization_id = $1 order by revoked_at is not null, created_at desc`,
    [q.organizationId],
  );
}

/** Revoga na hora. Devolve `false` se a chave não existe nesta organização ou já estava revogada. */
export async function revokeApiKey(q: OrgQuery, id: string, actorUserId: string | null, now: Date): Promise<boolean> {
  const row = await q.one<{ name: string; prefix: string }>(
    "update api_keys set revoked_at = $2 where organization_id = $3 and id = $1 and revoked_at is null returning name, key_prefix as prefix",
    [id, now, q.organizationId],
  );
  if (!row) return false;
  await recordOrgEvent(q, "api_key_revoked", { apiKeyId: id, name: row.name, prefix: row.prefix }, now, actorUserId);
  return true;
}

/**
 * A chave que este texto abre, ou `null`. A busca é pelo resumo antes de se saber a organização,
 * por isso atravessa organizações. Revogada, de empresa suspensa ou malformada dão a mesma
 * resposta. Marca o último uso, para a tela mostrar chave esquecida.
 */
export async function findApiKey(db: Db, token: string, now: Date): Promise<ApiKeyPrincipal | null> {
  if (!TOKEN.test(token)) return null;
  return withSystem(db, async (q) => {
    const row = await q.one<{ id: string; organizationId: string; name: string; scopes: ApiKeyScope[]; platform: boolean }>(
      `select k.id, k.organization_id as "organizationId", k.name, k.scopes, o.platform
         from api_keys k join organizations o on o.id = k.organization_id
         left join tenant_profiles p on p.organization_id = k.organization_id
        where k.key_hash = $1 and k.revoked_at is null and coalesce(p.status, 'active') = 'active'`,
      [hashToken(token)],
    );
    if (!row) return null;
    await q.exec("update api_keys set last_used_at = $2 where id = $1", [row.id, now]);
    return row;
  });
}
