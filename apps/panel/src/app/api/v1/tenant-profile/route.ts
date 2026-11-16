import { normalizeCnpj, readTenantProfile, saveTenantProfile } from "@ozavo/core";
import { z } from "zod";
import { handle } from "../../../../server/context";
import { requireAgent } from "../../../../server/shapes";

export const GET = handle({}, ({ q }) => readTenantProfile(q));

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === "" ? null : value));
const cnpj = z
  .string()
  .nullable()
  .transform((value, ctx) => {
    if (value === null || value.trim() === "") return null;
    const digits = normalizeCnpj(value);
    if (digits === null) {
      ctx.addIssue({ code: "custom", message: "not a valid CNPJ" });
      return z.NEVER;
    }
    return digits;
  });

const body = z.object({
  legalName: optional(200),
  cnpj,
  tradeName: optional(200),
  personaName: z.string().trim().min(1).max(60),
  defaultVoiceId: optional(200),
  basePrompt: z.string().max(8000),
  defaultAgentId: z.uuid().nullable(),
});

/** O perfil da empresa. Plano e status não mudam por aqui: são do provisionamento. */
export const PUT = handle({ body, configure: true }, async ({ q, body, session, deps }) => {
  if (body.defaultAgentId !== null) await requireAgent(q, body.defaultAgentId);
  return saveTenantProfile(q, body, session.userId, deps.clock.now());
});
