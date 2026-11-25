/**
 * Frase de ponte (ADR 0023): uma interjeição curta, sintetizada uma vez com a voz do agente e guardada, que toca quando o modelo
 * demora para o primeiro texto. Cobre a espera sem prometer nada ("Certo.", "Um instante.") e sai do áudio guardado: não passa por
 * modelo nem por síntese na hora.
 *
 * Duas faixas: a curta (até ~0,6 s) é a que toca primeiro e some dentro do tempo que o modelo leva; a longa só entra se, mesmo
 * depois da curta, o primeiro texto não chegou.
 */
export interface BridgePhrase {
  text: string;
  /** PCM16 mono 8 kHz. */
  pcm: Buffer;
  tier: "short" | "long";
}

export const BRIDGE_TEXTS: Record<string, { short: readonly string[]; long: readonly string[] }> = {
  pt: { short: ["Certo.", "Tá bom.", "Ok."], long: ["Um instante.", "Deixa eu ver.", "Só um instante."] },
  en: { short: ["Sure.", "Okay.", "Right."], long: ["One moment.", "Let me check.", "Just a second."] },
  es: { short: ["Claro.", "Vale.", "Bien."], long: ["Un momento.", "Déjeme ver.", "Un segundo."] },
};

/** As frases já sintetizadas, por voz e idioma. Vale para o processo todo: a segunda ligação com a mesma voz não paga a síntese. */
export class BridgeStore {
  private readonly phrases = new Map<string, Map<string, BridgePhrase>>();

  static keyOf(voiceId: string | undefined, language: string): string {
    return `${voiceId ?? ""}|${language}`;
  }

  get(key: string): readonly BridgePhrase[] {
    return [...(this.phrases.get(key)?.values() ?? [])];
  }

  has(key: string, text: string): boolean {
    return this.phrases.get(key)?.has(text) ?? false;
  }

  put(key: string, phrase: BridgePhrase): void {
    const bucket = this.phrases.get(key) ?? new Map<string, BridgePhrase>();
    bucket.set(phrase.text, phrase);
    this.phrases.set(key, bucket);
  }
}

export const sharedBridgeStore = new BridgeStore();

/**
 * Tira o silêncio das pontas do áudio sintetizado (a Cartesia deixa 100 a 180 ms antes e ~100 ms depois): a ponte é curta, e esse
 * silêncio atrasa o som e a resposta que vem atrás dela. Áudio todo silencioso fica como está. Deixa 20 ms de folga.
 */
export function trimEdges(pcm: Buffer): Buffer {
  const frame = 320;
  const frames = Math.floor(pcm.length / frame);
  const loud = (index: number): boolean => {
    let sum = 0;
    for (let i = index * frame; i < (index + 1) * frame; i += 2) {
      const value = pcm.readInt16LE(i) / 32768;
      sum += value * value;
    }
    return 20 * Math.log10(Math.sqrt(sum / (frame / 2)) || 1e-5) > -48;
  };
  let first = 0;
  while (first < frames && !loud(first)) first++;
  if (first === frames) return pcm;
  let last = frames - 1;
  while (last > first && !loud(last)) last--;
  return pcm.subarray(Math.max(0, first - 1) * frame, Math.min(frames, last + 2) * frame);
}

/** A duração do áudio guardado, em ms (PCM16 8 kHz mono: 16 bytes por ms). */
export const durationMs = (phrase: Pick<BridgePhrase, "pcm">): number => phrase.pcm.length / 16;

/**
 * Qual frase tocar: da faixa pedida, a que não tocou há pouco. Guarda as duas últimas para não repetir em sequência.
 * Sem frase pronta da faixa, devolve `undefined` (a ponte simplesmente não toca).
 */
export function pickBridge(phrases: readonly BridgePhrase[], tier: "short" | "long", recent: readonly string[], random: () => number = Math.random): BridgePhrase | undefined {
  const pool = phrases.filter((phrase) => phrase.tier === tier);
  const fresh = pool.filter((phrase) => !recent.includes(phrase.text));
  const choices = fresh.length > 0 ? fresh : pool.filter((phrase) => phrase.text !== recent.at(-1));
  if (choices.length === 0) return undefined;
  return choices[Math.floor(random() * choices.length)];
}

/** Uma pergunta de confirmação do agente, antes de uma ferramenta que grava: a ponte não toca no turno que responde a ela. */
const CONFIRMATION_QUESTION = /(confirm|marc|agend|reserv|cancel|remarc|posso\s|pode\s+ser|fica\s+bem|combinad|fechad|is\s+that\s+ok|shall\s+i|confirmo|cancelo)/i;

/**
 * Nunca antes de uma ferramenta sensível: se o agente tem ferramenta que grava e a última fala dele pedia confirmação, a resposta
 * de quem ligou provavelmente é o "sim" que dispara a escrita, e ali o agente não enche a espera com frase solta.
 */
export function sensitiveTurn(lastAgentText: string | undefined, hasWriteTools: boolean): boolean {
  if (!hasWriteTools || !lastAgentText) return false;
  // Qualquer pergunta da fala vale, não só a última frase ("Posso marcar às 10h? Me confirma.").
  return (lastAgentText.match(/[^.!?]*\?/g) ?? []).some((question) => CONFIRMATION_QUESTION.test(question));
}
