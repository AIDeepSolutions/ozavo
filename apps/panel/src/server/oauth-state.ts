import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * O `state` da autorização OAuth: diz para qual empresa e pessoa a volta do provedor vale, até
 * quando, e é assinado com a chave da instalação. Sem tabela: quem forja o `state` não tem a chave.
 */
const STATE_SECONDS = 10 * 60;
const payload = z.object({ o: z.uuid(), u: z.uuid(), e: z.number().int(), n: z.string() });

const sign = (body: string, key: Buffer): string => createHmac("sha256", key).update(`oauth-state:${body}`).digest("base64url");

export function createOAuthState(input: { organizationId: string; userId: string }, key: Buffer, now: Date): string {
  const body = Buffer.from(JSON.stringify({ o: input.organizationId, u: input.userId, e: Math.floor(now.getTime() / 1000) + STATE_SECONDS, n: randomBytes(9).toString("base64url") })).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** A empresa e a pessoa do `state`, ou `null` se ele foi adulterado ou venceu. */
export function readOAuthState(state: string, key: Buffer, now: Date): { organizationId: string; userId: string } | null {
  const [body, signature, ...rest] = state.split(".");
  if (!body || !signature || rest.length > 0) return null;
  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = payload.safeParse(raw);
  if (!parsed.success || parsed.data.e * 1000 < now.getTime()) return null;
  return { organizationId: parsed.data.o, userId: parsed.data.u };
}

/** Para onde o Google devolve a pessoa. Tem de ser cadastrado igual no cliente OAuth do Google. */
export const googleRedirectUri = (publicUrl: string): string => `${publicUrl.replace(/\/+$/, "")}/api/v1/connectors/google/callback`;
