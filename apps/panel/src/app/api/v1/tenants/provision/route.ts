import { DEFAULT_PERSONA_NAME, encryptSecret, normalizeCnpj, provisionTenant } from "@ozavo/core";
import { z } from "zod";
import { ApiError } from "../../../../../server/context";
import { handleApiKey } from "../../../../../server/api-auth";
import { defaultToolNames, engineKeySetting, listEngines } from "../../../../../server/pieces";

const slug = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,39}$/, "use lowercase letters, digits, _ and -");
const cnpj = z.string().transform((value, ctx) => {
  const digits = normalizeCnpj(value);
  if (digits === null) {
    ctx.addIssue({ code: "custom", message: "not a valid CNPJ" });
    return z.NEVER;
  }
  return digits;
});

const body = z.object({
  // Quem pediu e a referência lá (a assinatura no Asaas). O mesmo par devolve a mesma empresa.
  source: slug.default("asaas"),
  externalRef: z.string().trim().min(1).max(200),
  company: z.object({
    legalName: z.string().trim().min(1).max(200),
    tradeName: z.string().trim().min(1).max(200).optional(),
    cnpj: cnpj.optional(),
  }),
  owner: z.object({ name: z.string().trim().min(1).max(120), email: z.email().max(254) }),
  // O plano é gravado como vínculo. Quando o código é do catálogo (starter, pro, growth, scale), o
  // motor de planos já contrata a franquia da empresa no provisionamento.
  plan: z.object({ code: slug, monthlyMinutes: z.number().int().min(0).max(1_000_000).optional() }),
  agent: z
    .object({
      personaName: z.string().trim().min(1).max(60).optional(),
      voiceId: z.string().trim().min(1).max(200).optional(),
      basePrompt: z.string().max(8000).optional(),
      instructions: z.string().max(20000).optional(),
      greeting: z.string().trim().min(1).max(1000).optional(),
      engine: z.string().optional(),
    })
    .default({}),
  // As chaves dos provedores de voz desta empresa, por motor. Cifradas antes de gravar.
  credentials: z.record(z.string(), z.string().trim().min(1).max(500)).default({}),
});

/** A instrução de quem não mandou a dele: a persona, a empresa e o jeito de atender por telefone. */
function defaultInstructions(persona: string, company: string): string {
  return [
    `Você é ${persona}, assistente virtual de ${company}, e atende ligações em português do Brasil.`,
    "Fale de forma calma, cordial e direta, com frases curtas, como numa conversa por telefone.",
    "Descubra o que a pessoa precisa. Se souber responder, responda. Se não souber, não invente: anote o recado e avise a equipe.",
    "Se a pessoa pedir para falar com alguém, transfira a ligação. Antes de encerrar, pergunte se pode ajudar em mais alguma coisa.",
  ].join("\n");
}

/**
 * Provisionamento automático: o n8n chama depois da assinatura do contrato e da confirmação do
 * pagamento no Asaas. Só uma chave `tenants:provision` da organização que administra a instalação
 * serve. Devolve a empresa pronta: o dono (com a senha inicial, só na criação) e o agente.
 */
export const POST = handleApiKey({ scope: "tenants:provision", body }, async ({ key, body, deps }) => {
  if (!key.platform) throw new ApiError(403, "forbidden", "Only the organization that runs this installation can provision companies.");
  const engines = await listEngines();
  const engineId = body.agent.engine ?? (engines.some((engine) => engine.id === "deepgram-openrouter-cartesia") ? "deepgram-openrouter-cartesia" : "simulated");
  if (!engines.some((engine) => engine.id === engineId)) throw new ApiError(400, "validation_error", `agent.engine: unknown voice engine ${JSON.stringify(engineId)}`);
  const unknown = Object.keys(body.credentials).filter((id) => !engines.some((engine) => engine.id === id && !engine.keyless));
  if (unknown.length > 0) throw new ApiError(400, "validation_error", `credentials: no voice engine takes a key named ${unknown.join(", ")}`);

  const persona = body.agent.personaName ?? DEFAULT_PERSONA_NAME;
  const company = body.company.tradeName ?? body.company.legalName;
  const result = await provisionTenant(
    deps.db,
    {
      source: body.source,
      externalRef: body.externalRef,
      company: { legalName: body.company.legalName, tradeName: body.company.tradeName ?? null, cnpj: body.company.cnpj ?? null },
      owner: body.owner,
      plan: { code: body.plan.code, monthlyMinutes: body.plan.monthlyMinutes ?? null },
      agent: {
        name: persona,
        personaName: persona,
        voiceId: body.agent.voiceId ?? null,
        basePrompt: body.agent.basePrompt ?? "",
        instructions: body.agent.instructions ?? defaultInstructions(persona, company),
        greeting: body.agent.greeting ?? null,
        engine: engineId,
        tools: await defaultToolNames(),
      },
      secrets: Object.entries(body.credentials).map(([engine, value]) => ({ key: engineKeySetting(engine), valueEnc: encryptSecret(value, deps.secretKey) })),
      requestedBy: key.organizationId,
    },
    deps.clock.now(),
  );
  if ("refused" in result) throw new ApiError(409, "email_taken", "There is already a user with this owner e-mail in this installation.");
  if (!result.created) return { status: 200, data: { ...result, loginUrl: `${deps.publicUrl}/login` } };
  return { status: 201, data: { ...result, loginUrl: `${deps.publicUrl}/login` } };
});
