import type { Tool } from "@ozavo/tools";
import type { VoiceEngine } from "@ozavo/voice-engine";

// `loadEngines()` e `loadTools()` leem a pasta em tempo de execução, e dentro do pacote compilado
// do Next essa pasta não existe. Aqui a descoberta é a mesma (por pasta, sem lista central), só
// que resolvida pelo empacotador: motor ou ferramenta nova aparece sem editar este arquivo.
// Carga preguiçosa de propósito: as peças importam `@ozavo/core`, que o empacotador trata
// como módulo assíncrono, e a forma `eager` entrega o módulo antes de ele terminar de avaliar.
const engineModules = import.meta.glob<{ default: VoiceEngine }>(["../../../../packages/voice-engine/src/engines/*.ts", "!../../../../packages/voice-engine/src/engines/*.test.ts"]);
const toolModules = import.meta.glob<{ default: Tool }>(["../../../../packages/tools/src/tools/*.ts", "!../../../../packages/tools/src/tools/*.test.ts"]);

const loadAll = <T>(modules: Record<string, () => Promise<{ default: T }>>): Promise<T[]> =>
  Promise.all(Object.values(modules).map(async (load) => (await load()).default));

let engines: Promise<VoiceEngine[]> | undefined;
let tools: Promise<Tool[]> | undefined;

/** Os motores que não pedem chave (o simulado): a prontidão da empresa não cobra chave deles. */
export async function keylessEngineIds(): Promise<string[]> {
  return (await listEngines()).filter((engine) => engine.keyless === true).map((engine) => engine.id);
}

export function listEngines(): Promise<VoiceEngine[]> {
  return (engines ??= loadAll(engineModules));
}

/**
 * As ferramentas que o operador pode marcar no agente. A que declara `available: false` (sem caminho
 * até a peça de que depende) fica de fora: a sessão não a ofereceria ao motor, e a marca sumiria em
 * silêncio. As de agenda entram: a agenda é a que a empresa conectar em Integrações, e sem ela a
 * sessão só deixa de oferecê-las naquela ligação (`ready`).
 */
export async function listTools(): Promise<Array<{ name: string; description: string }>> {
  return (await (tools ??= loadAll(toolModules))).filter((tool) => tool.available !== false).map((tool) => ({ name: tool.name, description: tool.description }));
}

/** As ferramentas com que um agente novo nasce: as que funcionam, menos as que pedem escolha (`offByDefault`). */
export async function defaultToolNames(): Promise<string[]> {
  return (await (tools ??= loadAll(toolModules))).filter((tool) => tool.available !== false && tool.offByDefault !== true).map((tool) => tool.name);
}

export const engineKeySetting = (engineId: string): string => `engine.${engineId}.api_key`;
