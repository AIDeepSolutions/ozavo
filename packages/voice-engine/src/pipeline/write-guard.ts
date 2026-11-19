/**
 * Confirmação antes da hora. O modelo às vezes fala "pronto, está marcado" no mesmo turno em que chama a ferramenta de
 * escrita, ou logo depois de ela falhar. Quem ouve acredita, e a agenda não gravou nada.
 *
 * Esta peça só reconhece a frase. A sessão (`session.ts`) a segura enquanto o turno tem ou pode ter uma escrita ainda sem
 * resultado: se o turno chama a ferramenta de escrita, ou se a escrita anterior falhou, a frase não é falada.
 */

/** As ferramentas que gravam ou desfazem um compromisso. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["agenda_marcar", "agenda_remarcar", "agenda_cancelar"]);

const CLAIM: Record<string, RegExp> = {
  pt: /(\b(marquei|agendei|reservei|remarquei|cancelei|confirmei)\b|\b(est[aá]|ficou|fica|foi|j[aá] est[aá]|agora est[aá])\s+(agora\s+)?(marcad|agendad|reservad|remarcad|cancelad|confirmad))/i,
  en: /\b(i(?:'ve| have)?\s+(booked|scheduled|rescheduled|cancel(?:l)?ed|confirmed)|(?:is|are|has been|have been|it's)\s+(now\s+)?(booked|scheduled|rescheduled|cancel(?:l)?ed|confirmed))\b/i,
  es: /\b(agend[eé]|reserv[eé]|cancel[eé]|confirm[eé]|reprogram[eé]|qued[oó]\s+(agendad|reservad|cancelad|confirmad|reprogramad))/i,
};
/** A frase inteira é pergunta: não afirma nada feito. */
const QUESTION = /\?\s*$/;
/** O trecho do verbo não afirma nada feito: promessa, hipótese ou negação ("não marquei", "vou marcar", "se marcar"). */
const NOT_A_CLAIM = /(\bn[ãa]o\b|\bvou\b|\bposso\b|\bgostaria\b|\bquer\b|\bse\b|\bcaso\b|\bassim que\b|\bdepois que\b|\bi'?ll\b|\bwill\b|\bnot\b|\bpuedo\b|\bvoy\b|\bno\b)/i;
/** Onde uma frase muda de assunto: vírgula, ponto e vírgula, dois-pontos e conjunções ("e", "mas", "and", "but", "y", "pero"). */
const CLAUSE_SPLIT = /[,;:]|\s+(?:e|mas|por[ée]m|and|but|y|pero)\s+/i;

/**
 * A fala afirma que marcou, remarcou, cancelou ou confirmou? Em português, inglês ou espanhol.
 *
 * A negação ou a condição só vale no TRECHO do verbo: "Não marquei nada" e "Se eu marcar, aviso" não afirmam; "Marquei, e
 * não precisa fazer nada" e "Marquei para segunda, se precisar remarcar é só ligar" afirmam (o "não" e o "se" são de outro
 * trecho). Uma frase que termina em pergunta nunca afirma.
 */
export function claimsDone(text: string, language: string): boolean {
  if (text.trim() === "") return false;
  const pattern = CLAIM[language] ?? CLAIM.en;
  if (!pattern?.test(text)) return false;
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (!pattern.test(sentence) || QUESTION.test(sentence)) continue;
    if (sentence.split(CLAUSE_SPLIT).some((clause) => pattern.test(clause) && !NOT_A_CLAIM.test(clause))) return true;
  }
  return false;
}

/** Quantas respostas do agente, depois de uma escrita que falhou, ainda seguram a confirmação do mesmo tipo. Não é permanente. */
export const WRITE_FAILURE_RESPONSES = 2;

/** A escrita que falhou: o tipo, o horário alvo (quando a chamada o trazia) e quantas respostas ainda valem. */
export interface WriteFailure {
  kind: "book" | "cancel";
  startsAt?: string;
  responsesLeft: number;
}

/** O tipo da escrita pelo nome da ferramenta: cancelar é um tipo; marcar e remarcar são o outro. */
export const writeKindOf = (toolName: string): "book" | "cancel" => (toolName === "agenda_cancelar" ? "cancel" : "book");

/** O horário alvo de uma chamada de escrita, lido dos argumentos em JSON (`starts_at` ou `appointment_starts_at`). */
export function startsAtOfCall(rawArguments: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (parsed && typeof parsed === "object") {
      const { starts_at: startsAt, appointment_starts_at: appointmentStartsAt } = parsed as Record<string, unknown>;
      const value = typeof startsAt === "string" ? startsAt : appointmentStartsAt;
      return typeof value === "string" ? value : undefined;
    }
  } catch {
    // Argumento que não é JSON: sem horário alvo, e a retenção vale para o tipo todo.
  }
  return undefined;
}

/**
 * A confirmação segurada fala do que falhou? Só quando é do MESMO TIPO (marcar/remarcar ou cancelar) e não cita um horário
 * diferente do alvo. Uma fala sobre outro compromisso ("sua consulta de sexta às 10h já está marcada", depois de falhar uma
 * remarcação para as 14h) é legítima e não é segurada.
 */
export function failureCovers(piece: string, failure: WriteFailure): boolean {
  if ((/cancel/i.test(piece) ? "cancel" : "book") !== failure.kind) return false;
  const target = failure.startsAt ? /T(\d{2}):(\d{2})(?!.*Z$)/.exec(failure.startsAt) : null;
  if (!target) return true;
  const said = [...piece.matchAll(/\b(\d{1,2})\s*(?:h|:)\s*(\d{2})?/gi)].map((match) => Number(match[1]));
  return said.length === 0 || said.includes(Number(target[1]));
}

/** O que se diz quando a escrita não aconteceu e o modelo não deixou outra fala que sirva. */
export const WRITE_UNAVAILABLE: Record<string, string> = {
  pt: "Não consegui concluir isso na agenda agora. Posso anotar o pedido para a equipe retornar?",
  en: "I could not complete that in the calendar just now. Can I take a note for the team to call you back?",
  es: "No pude completar eso en la agenda ahora. ¿Puedo anotar el pedido para que el equipo la llame?",
};
