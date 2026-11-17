import { DEFAULT_PERSONA_NAME, defaultProvisionInstructions, type ProvisionInput } from "@ozavo/core";
import type { VoiceEngine } from "@ozavo/voice-engine";
import { ApiError } from "./context";
import { defaultToolNames } from "./pieces";

export interface AgentRequest {
  personaName?: string;
  voiceId?: string;
  basePrompt?: string;
  instructions?: string;
  greeting?: string;
  engine?: string;
}

/**
 * O agente com que a empresa nasce, igual pela API de provisionamento e pela tela da plataforma:
 * a persona, a instrução padrão e o motor de voz em cascata quando ele existe, senão o simulado.
 */
export async function provisionAgent(engines: VoiceEngine[], request: AgentRequest, company: string): Promise<ProvisionInput["agent"]> {
  const engine = request.engine ?? (engines.some((candidate) => candidate.id === "deepgram-openrouter-cartesia") ? "deepgram-openrouter-cartesia" : "simulated");
  if (!engines.some((candidate) => candidate.id === engine)) throw new ApiError(400, "validation_error", `agent.engine: unknown voice engine ${JSON.stringify(engine)}`);
  const persona = request.personaName ?? DEFAULT_PERSONA_NAME;
  return {
    name: persona,
    personaName: persona,
    voiceId: request.voiceId ?? null,
    basePrompt: request.basePrompt ?? "",
    instructions: request.instructions ?? defaultProvisionInstructions(persona, company),
    greeting: request.greeting ?? null,
    engine,
    tools: await defaultToolNames(),
  };
}
