/**
 * Limitador suave do turno do agente. A síntese de voz cobra por caractere, e resposta longa ao
 * telefone cansa quem ouve: o alvo é de 120 a 160 caracteres por turno. A instrução pede isso ao
 * modelo; aqui fica a garantia para quando ele não obedece.
 *
 * "Suave" porque não corta no meio da palavra nem no meio de uma frase que está acabando:
 *   - até o alvo máximo, o texto passa como chega;
 *   - passado o alvo, a frase em curso ainda pode terminar, até a tolerância;
 *   - se a frase não termina dentro da tolerância, o turno acaba na última palavra inteira antes
 *     do alvo máximo, e o resto é descartado.
 */
export const TURN_TARGET_MIN_CHARACTERS = 120;
export const TURN_TARGET_MAX_CHARACTERS = 160;
/** Até onde uma frase que passou do alvo ainda pode terminar. */
export const TURN_TOLERANCE_CHARACTERS = 200;

export interface TurnLimiter {
  /** Recebe um pedaço do texto do modelo e devolve o que pode ir para a síntese agora. */
  push(delta: string): string;
  /** O modelo terminou de escrever: devolve o que ainda estava retido e cabe no turno. */
  flush(): string;
  /** Texto do modelo foi descartado por passar do limite. */
  readonly truncated: boolean;
}

const SENTENCE_END = /[.!?…](?=\s|$)/g;

export function createTurnLimiter(max = TURN_TARGET_MAX_CHARACTERS, tolerance = TURN_TOLERANCE_CHARACTERS): TurnLimiter {
  /** Tudo o que o modelo escreveu até o corte. */
  let raw = "";
  /** Quanto de `raw` já foi liberado. */
  let released = 0;
  let closed = false;
  let truncated = false;

  const release = (end: number): string => {
    const piece = raw.slice(released, end);
    released = end;
    return piece;
  };

  return {
    push(delta) {
      if (closed) {
        if (delta.trim() !== "") truncated = true;
        return "";
      }
      raw += delta;
      if (raw.length <= max) return release(raw.length);

      // Passou do alvo: a frase em curso termina dentro da tolerância?
      SENTENCE_END.lastIndex = Math.max(0, released - 1);
      for (let match = SENTENCE_END.exec(raw); match; match = SENTENCE_END.exec(raw)) {
        const end = match.index + 1;
        if (end > tolerance) break;
        if (end < max) continue;
        // Pontuação no fim do que chegou ainda pode ser reticências ou número: espera o próximo pedaço.
        if (end === raw.length) break;
        closed = true;
        if (raw.slice(end).trim() !== "") truncated = true;
        return release(end);
      }
      if (raw.length > tolerance) {
        // Não terminou a tempo: o turno acaba na última palavra inteira antes do alvo.
        closed = true;
        truncated = true;
        const space = raw.lastIndexOf(" ", max);
        return space > released ? release(space) : "";
      }
      // Ainda dentro da tolerância: libera só até a última palavra inteira antes do alvo e retém o resto.
      const space = raw.lastIndexOf(" ", max);
      return space > released ? release(space) : "";
    },
    flush() {
      if (closed) return "";
      closed = true;
      // O modelo terminou dentro da tolerância: a resposta está completa e vai inteira.
      return release(raw.length);
    },
    get truncated() {
      return truncated;
    },
  };
}
