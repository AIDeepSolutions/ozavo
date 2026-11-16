import type { ListeningEnvironment } from "../types";

/**
 * Endpointing dinâmico: quanto esperar, depois do último trecho final da transcrição, para dar o
 * turno de quem ligou por encerrado.
 *
 * Um prazo fixo erra para os dois lados: curto, corta quem pensa no meio da frase ("quero marcar
 * para... sexta"); longo, deixa silêncio depois de uma pergunta. Aqui o prazo sai do que foi dito:
 * frase fechada responde logo, frase que termina em conjunção ou hesitação espera mais.
 *
 * A Deepgram já espera o próprio `endpointing` antes de mandar `speech_final`: este prazo é o que
 * se soma a ele. Os valores são ponto de partida, não medidos numa ligação real.
 */

export const ENDPOINT_CLOSED_MS = 120;
export const ENDPOINT_DEFAULT_MS = 350;
export const ENDPOINT_OPEN_MS = 900;
/** Ruído de fundo atrasa o fim real da fala que o provedor vê: um pouco mais de folga. */
export const ENDPOINT_NOISY_EXTRA_MS = 200;

// Palavras que, no fim de um trecho, indicam que a frase continua (pt, en, es).
const CONTINUATION = new Set([
  "e", "mas", "que", "então", "entao", "porque", "pois", "ou", "tipo", "né", "ne", "é", "hum", "humm", "ahn", "éé",
  "assim", "com", "de", "do", "da", "para", "pra", "pro", "o", "a", "os", "as", "um", "uma", "no", "na", "em", "se",
  "and", "but", "so", "or", "the", "to", "of", "um", "uh", "with", "because",
  "y", "pero", "o", "porque", "entonces", "el", "la", "con", "para", "eh", "este",
]);

/** O prazo, em ms, para encerrar o turno depois de um trecho final com este texto. */
export function endpointDelayMs(text: string, environment: ListeningEnvironment = "normal"): number {
  const extra = environment === "noisy" ? ENDPOINT_NOISY_EXTRA_MS : 0;
  const trimmed = text.trim();
  if (trimmed === "") return ENDPOINT_DEFAULT_MS + extra;
  // Reticências antes do ponto: "deixa eu ver..." é frase aberta, não fechada.
  if (/[,;:]$|\.\.\.$|…$/.test(trimmed)) return ENDPOINT_OPEN_MS + extra;
  if (/[.?!]$/.test(trimmed)) return ENDPOINT_CLOSED_MS + extra;
  const last = trimmed.split(/\s+/).pop()?.toLowerCase().replace(/[^\p{L}]/gu, "") ?? "";
  if (CONTINUATION.has(last)) return ENDPOINT_OPEN_MS + extra;
  return ENDPOINT_DEFAULT_MS + extra;
}
