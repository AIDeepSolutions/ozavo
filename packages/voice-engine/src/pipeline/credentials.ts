import { decryptSecret, encryptSecret } from "@ozavo/core";
import { z } from "zod";

/**
 * As três chaves do motor em pipeline, guardadas como **uma** chave de motor.
 *
 * O resto do sistema conhece uma chave por motor (`connect(config, apiKey)`, a tela da chave, o
 * teste da chave, a cifra em repouso). O pipeline fala com três provedores, então a chave dele é
 * um JSON com as três, e é esse texto inteiro que vai cifrado com `encryptSecret`, como qualquer
 * outra chave de IA. Nenhuma das três aparece em log, evento ou mensagem de erro.
 */
export const pipelineCredentials = z.object({
  deepgram: z.string().trim().min(1),
  cartesia: z.string().trim().min(1),
  openrouter: z.string().trim().min(1),
});
export type PipelineCredentials = z.infer<typeof pipelineCredentials>;

export class InvalidPipelineKeyError extends Error {
  constructor() {
    // A mensagem nunca repete o que foi recebido: pode ser uma chave colada no lugar errado.
    super("Motor em pipeline: a chave precisa ser um JSON com deepgram, cartesia e openrouter");
  }
}

export function encodePipelineKey(credentials: PipelineCredentials): string {
  return JSON.stringify(pipelineCredentials.parse(credentials));
}

/** Lê a chave do motor. Lança `InvalidPipelineKeyError` se faltar uma das três. */
export function parsePipelineKey(apiKey: string): PipelineCredentials {
  let raw: unknown;
  try {
    raw = JSON.parse(apiKey);
  } catch {
    throw new InvalidPipelineKeyError();
  }
  const parsed = pipelineCredentials.safeParse(raw);
  if (!parsed.success) throw new InvalidPipelineKeyError();
  return parsed.data;
}

/** As três chaves cifradas em repouso, no mesmo formato de qualquer segredo de operador. */
export function sealPipelineCredentials(credentials: PipelineCredentials, secretKey: Buffer): string {
  return encryptSecret(encodePipelineKey(credentials), secretKey);
}

export function openPipelineCredentials(sealed: string, secretKey: Buffer): PipelineCredentials {
  return parsePipelineKey(decryptSecret(sealed, secretKey));
}
