import { findApiKey, withOrg, type ApiKeyPrincipal, type ApiKeyScope, type OrgQuery } from "@ozavo/core";
import type { z, ZodType } from "zod";
import { ApiError, failure, serverDeps, type ServerDeps } from "./context";
import { createRateLimiter } from "./rate-limit";

/**
 * A entrada de sistemas de fora (um CRM ou outro integrador): `Authorization: Bearer ozk_…`. A chave é da
 * empresa e só faz o que o escopo dela diz. A resposta tem o mesmo envelope das rotas do painel.
 */

// Por chave, em memória (o painel é um processo só, como no login). Uma ligação por segundo em
// média já é muito mais que a política de saída deixa passar; o teto existe para um laço quebrado
// do lado de lá não martelar o banco.
const MAX_REQUESTS_PER_MINUTE = 60;
const limiter = createRateLimiter(MAX_REQUESTS_PER_MINUTE, 60_000);

/** O texto da chave no cabeçalho, ou `undefined` se não veio `Bearer`. */
export function bearerOf(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export async function requireApiKey(request: Request, deps: ServerDeps, scope: ApiKeyScope): Promise<ApiKeyPrincipal> {
  const token = bearerOf(request);
  if (!token) throw new ApiError(401, "unauthenticated", "Send the API key as Authorization: Bearer <key>.");
  const key = await findApiKey(deps.db, token, deps.clock.now());
  // Inexistente, revogada e de empresa suspensa dão a mesma resposta.
  if (!key) throw new ApiError(401, "unauthenticated", "This API key is not valid.");
  if (!key.scopes.includes(scope)) throw new ApiError(403, "forbidden", `This API key does not have the ${scope} scope.`);
  if (!limiter.take(key.id, deps.clock.now())) throw new ApiError(429, "rate_limited", `Too many requests with this API key: at most ${MAX_REQUESTS_PER_MINUTE} per minute.`);
  return key;
}

export interface ApiKeyArgs<B> {
  key: ApiKeyPrincipal;
  body: B;
  request: Request;
  deps: ServerDeps;
  /** Transação na empresa da chave. */
  org<T>(fn: (q: OrgQuery) => Promise<T>): Promise<T>;
}

/** Lê e valida o corpo; o mesmo formato de erro das rotas do painel. */
export async function parseApiBody<S extends ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
  const parsed = await schema.safeParseAsync(raw);
  if (!parsed.success) throw new ApiError(400, "validation_error", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/** Embrulha uma rota de chave de API: chave, escopo, limite, corpo validado e envelope. */
export function handleApiKey<S extends ZodType>(
  options: { scope: ApiKeyScope; body: S },
  fn: (args: ApiKeyArgs<z.output<S>>) => Promise<{ status?: number; data: unknown }>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const deps = serverDeps();
      const key = await requireApiKey(request, deps, options.scope);
      const body = await parseApiBody(request, options.body);
      const result = await fn({ key, body, request, deps, org: (run) => withOrg(deps.db, key.organizationId, run) });
      return Response.json({ ok: true, data: result.data ?? null }, { status: result.status ?? 200 });
    } catch (error) {
      return failure(error);
    }
  };
}
