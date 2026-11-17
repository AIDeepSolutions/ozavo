import { PLAN_IDS, TENANT_STATUSES, createPlatformTenant, listPlatformTenants, normalizeCnpj } from "@ozavo/core";
import { z } from "zod";
import { ApiError, handle } from "../../../../../server/context";
import { listEngines } from "../../../../../server/pieces";
import { provisionAgent } from "../../../../../server/tenant-agent";

/** As empresas clientes da instalação. Só dono ou administrador da plataforma. */
export const GET = handle({ platform: true }, ({ deps, session }) => listPlatformTenants(deps.db, session.organizationId, deps.clock.now()));

const cnpj = z.string().transform((value, ctx) => {
  const digits = normalizeCnpj(value);
  if (digits === null) {
    ctx.addIssue({ code: "custom", message: "not a valid CNPJ" });
    return z.NEVER;
  }
  return digits;
});

const body = z
  .object({
    // Um por formulário, gerado pela tela: repetir o envio devolve a mesma empresa.
    requestId: z.uuid(),
    // A razão social; o nome fantasia e o CNPJ são opcionais, como no provisionamento por API.
    companyName: z.string().trim().min(1).max(200),
    tradeName: z.string().trim().min(1).max(200).optional(),
    cnpj: cnpj.optional(),
    owner: z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(254) }),
    plan: z.enum(PLAN_IDS),
    custom: z
      .object({
        monthlyPriceCents: z.number().int().min(0).max(100_000_000),
        includedMinutes: z.number().int().min(0).max(10_000_000),
        maxConcurrentCalls: z.number().int().min(1).max(500),
      })
      .optional(),
    initialStatus: z.enum(TENANT_STATUSES),
  })
  .superRefine((input, ctx) => {
    if (input.plan === "custom" && !input.custom) ctx.addIssue({ code: "custom", path: ["custom"], message: "required for the custom plan" });
  });

/**
 * Cria a empresa pelo mesmo caminho do provisionamento por API. O link do convite de dono volta só
 * nesta resposta: a tela mostra uma vez, e quem perder pede um novo no detalhe da empresa.
 */
export const POST = handle({ body, platform: true }, async ({ body, deps, session }) => {
  const agent = await provisionAgent(await listEngines(), {}, body.tradeName ?? body.companyName);
  const result = await createPlatformTenant(
    deps.db,
    session.organizationId,
    session.userId,
    { requestId: body.requestId, companyName: body.companyName, tradeName: body.tradeName ?? null, cnpj: body.cnpj ?? null, owner: body.owner, plan: body.plan, custom: body.plan === "custom" ? body.custom : undefined, initialStatus: body.initialStatus, agent },
    deps.clock.now(),
  );
  if ("refused" in result) throw new ApiError(409, "email_taken", "There is already a user with this owner e-mail in this installation.");
  return {
    created: result.created,
    organizationId: result.organizationId,
    ownerInviteUrl: result.ownerInvite ? `${deps.publicUrl}/invite/${result.ownerInvite.token}` : null,
    ownerInviteExpiresAt: result.ownerInvite?.expiresAt.toISOString() ?? null,
  };
});
