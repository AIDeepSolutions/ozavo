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
 * se soma a ele. Os valores são ponto de partida, não medidos numa ligação real. O `endpointing` da Deepgram subiu de 100 para 250 ms (100 cortava a frase em duas no primeiro respiro) e o prazo daqui desceu na mesma medida: a pausa total de uma frase fechada fica em ~290 ms.
 */

export const ENDPOINT_CLOSED_MS = 40;
export const ENDPOINT_DEFAULT_MS = 250;
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

/**
 * Fim de turno pela PAUSA vista no áudio (ADR 0023). Com o `Finalize` da Deepgram o texto chega ~0,3 s depois do fim da fala,
 * e o prazo deixa de ser "quanto esperar depois do `speech_final`" e passa a ser "quanto de silêncio, contado do fim real da
 * fala, antes de dar o turno por encerrado". Errar para o lado do silêncio custa meio segundo; errar para o outro corta a frase da
 * pessoa, por isso, na dúvida, a classe é a que espera mais.
 */
export type TurnEndKind = "closed" | "short" | "default" | "open" | "hesitation" | "dictation";

export interface TurnEndAssessment {
  kind: TurnEndKind;
  /** Silêncio total, desde o fim real da fala, que o turno espera antes de fechar. */
  silenceMs: number;
}

/**
 * Silêncio-alvo por classe (ms desde o fim real da fala). Com o `Finalize` o texto chega ~300 ms depois do fim da fala, então `closed` e
 * `short` quase não esperam além disso. O piso de 300 a 350 ms vem da bancada: com menos, a pausa entre duas frases seguidas ("Quais
 * modelos vocês usam? É só OpenAI?") já fecha o turno no meio.
 */
export const TURN_END_SILENCE_MS: Record<TurnEndKind, number> = { closed: 350, short: 300, default: 500, open: 850, dictation: 900, hesitation: 1050 };

const normalize = (word: string): string => word.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

// Palavras que nunca terminam uma frase: artigo, preposição, conjunção, pronome relativo e interrogativo (pt, en, es).
const NEVER_LAST = new Set(
  [
    "e", "mas", "ou", "que", "porque", "pois", "se", "quando", "como", "onde", "enquanto", "embora", "caso",
    "o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
    "por", "pelo", "pela", "pelos", "pelas", "para", "pra", "pro", "com", "sem", "sobre", "entre", "ate", "ao", "aos", "num", "numa",
    "qual", "quais", "quanto", "quantos", "quanta", "quantas", "cujo", "cuja", "me", "te", "lhe", "lhes",
    "and", "but", "the", "to", "of", "with", "because", "or", "so", "if", "when", "an", "in", "on", "at", "for",
    "y", "pero", "porque", "el", "la", "los", "las", "con", "para", "sin", "si", "cuando", "una", "uno", "del",
  ].map(normalize),
);
// Palavra interrogativa que fecha uma pergunta curta ("Tem como?", "Quanto?", "Onde?", "Quais?").
const INTERROGATIVE_ENDING = new Set(["como", "quanto", "quantos", "quanta", "quantas", "quando", "onde", "qual", "quais"].map(normalize));
// Possessivo no fim: quase sempre falta o substantivo ("quais são suas… empreitadas"). Vale mesmo com "?" (a Deepgram pontua sozinha).
const POSSESSIVE = new Set(["meu", "minha", "meus", "minhas", "seu", "sua", "seus", "suas", "nosso", "nossa", "nossos", "nossas", "dele", "dela", "deles", "delas", "teu", "tua"]);
// Enchimento de quem pensa: só vale como frase aberta quando a frase não tem pontuação final.
const FILLER = new Set(["entao", "assim", "tipo", "ne", "e", "hum", "humm", "ahn", "ee", "eh", "um", "uh", "este", "hm", "hmm"]);
const SHORT_ANSWER = new Set(
  ["sim", "nao", "ok", "okay", "certo", "claro", "pode", "isso", "ta", "beleza", "obrigado", "obrigada", "tchau", "valeu", "perfeito", "combinado", "exato", "yes", "no", "si"].map(normalize),
);
// Quem pensa em voz alta: "hum, deixa eu pensar." (a Deepgram fecha com ponto, mas a pessoa ainda vai dizer o resto).
const HESITATION = /(?:^|[\s,.])(?:deixa\s+eu\s+(?:ver|pensar|lembrar|olhar)|espera(?:\s+a[ií])?|pera[ií]|um\s+(?:momento|minuto|segundo|instante)|como\s+(?:[eé]|era)\s+que|let\s+me\s+(?:see|think)|hold\s+on|d[eé]jame\s+(?:ver|pensar))[\s.!?…,]*$/i;
// Dado ditado devagar: o que falta de dígitos para o número estar completo.
const DICTATED: Array<{ context: RegExp; digits: number }> = [
  { context: /\b(?:telefone|celular|whats(?:app)?|zap|fone)\b/i, digits: 8 },
  { context: /\bcpf\b/i, digits: 11 },
  { context: /\bcnpj\b/i, digits: 14 },
  { context: /\bcep\b/i, digits: 8 },
];
const NUMBER_WORDS = new Set(["zero", "um", "uma", "dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa", "cem"]);

function missingDigits(text: string): boolean {
  for (const { context, digits } of DICTATED) {
    const at = text.search(context);
    if (at === -1) continue;
    let count = 0;
    for (const token of text.slice(at).split(/\s+/).slice(1)) count += token.replace(/\D/g, "").length || (NUMBER_WORDS.has(normalize(token)) ? 1 : 0);
    // Com o ponto final também: a Deepgram fecha a frase no meio do número quando a pessoa respira.
    if (count > 0 && count < digits) return true;
  }
  return false;
}

/** Classe do fim de turno para o texto final de quem ligou, e o silêncio que ela pede. */
export function assessTurnEnd(text: string, environment: ListeningEnvironment = "normal"): TurnEndAssessment {
  const extra = environment === "noisy" ? ENDPOINT_NOISY_EXTRA_MS : 0;
  const of = (kind: TurnEndKind): TurnEndAssessment => ({ kind, silenceMs: TURN_END_SILENCE_MS[kind] + extra });
  const trimmed = text.trim();
  if (trimmed === "") return of("default");
  if (HESITATION.test(trimmed)) return of("hesitation");
  if (/[,;:]$|\.\.\.$|…$/.test(trimmed)) return of("open");
  const words = trimmed.split(/\s+/);
  const last = normalize(words.at(-1) ?? "");
  // Pergunta curta que termina na própria palavra interrogativa ("Tem como?", "Quanto?", "Quando?") está completa; a lista abaixo só vale
  // para o resto. A Deepgram pontua sozinha, por isso o "?" só conta quando a frase é curta (até 3 palavras) e não termina em possessivo.
  if (/\?$/.test(trimmed) && words.length <= 3 && INTERROGATIVE_ENDING.has(last)) return of("closed");
  if (NEVER_LAST.has(last) || POSSESSIVE.has(last)) return of("open");
  if (missingDigits(trimmed)) return of("dictation");
  const whole = normalize(trimmed.replace(/[.,!?…]+/g, " ").replace(/\s+/g, ""));
  if (words.length <= 3 && SHORT_ANSWER.has(whole)) return of("short");
  if (/[.?!]$/.test(trimmed)) return of("closed");
  if (FILLER.has(last)) return of("open");
  return of("default");
}
