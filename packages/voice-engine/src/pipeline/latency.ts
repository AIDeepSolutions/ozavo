/**
 * Ajustes de latência do pipeline por agente (ADR 0023). Tudo aqui nasce LIGADO: o operador desliga na tela do agente
 * (convenção 7: configuração de operador tem tela). Os campos opcionais só existem para a bancada e os testes.
 */
export interface LatencyOptions {
  /** Chamada leve ao modelo, com o mesmo prefixo, quando a ligação abre (esquenta conexão e cache do provedor). */
  warmup: boolean;
  /** Frase curta pré-sintetizada com a voz do agente quando o modelo demora para o primeiro texto. */
  bridge: boolean;
  /** Começa o pedido ao modelo antes de o fim de turno estar decidido, e descarta se a pessoa continuar. */
  speculation: boolean;
  /** Fim de turno pela pausa local + `Finalize` do STT, em vez de esperar só o `speech_final` do provedor. */
  fastEndpoint: boolean;
  /** Pausa local (ms) que dispara o `Finalize`. */
  pauseMs: number;
  /** Quanto esperar (ms) pelo primeiro texto do modelo antes de tocar a frase de ponte. */
  bridgeAfterMs: number;
}

export const DEFAULT_LATENCY: LatencyOptions = { warmup: true, bridge: true, speculation: true, fastEndpoint: true, pauseMs: 100, bridgeAfterMs: 100 };

/** Os ajustes do agente por cima do padrão. Chave desconhecida ou de tipo errado é ignorada: nunca derruba a ligação. */
export function resolveLatency(overrides: unknown): LatencyOptions {
  const result: LatencyOptions = { ...DEFAULT_LATENCY };
  if (typeof overrides !== "object" || overrides === null) return result;
  const given = overrides as Record<string, unknown>;
  for (const key of ["warmup", "bridge", "speculation", "fastEndpoint"] as const) {
    const value = given[key];
    if (typeof value === "boolean") result[key] = value;
  }
  for (const key of ["pauseMs", "bridgeAfterMs"] as const) {
    const value = given[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5000) result[key] = value;
  }
  return result;
}

/** Marcador do bloco que varia de ligação para ligação (o contexto do pedido de saída). Ver `composeCallInstructions`. */
const CONTEXT_MARKER = "\n\nContexto desta ligação, enviado pelo sistema que pediu que você ligasse.";

/**
 * Prefixo estável: tudo o que é igual entre turnos e entre ligações vem primeiro (instrução, vocabulário, idioma, estilo de
 * telefone), e o que varia por ligação (o contexto do pedido de saída) vem por último. Os provedores reaproveitam o cache pelo
 * prefixo byte a byte: qualquer coisa variável no começo derruba o cache da ligação inteira.
 */
export function withStablePrefix(instructions: string, stableTail: string): string {
  const at = instructions.indexOf(CONTEXT_MARKER);
  if (at === -1) return `${instructions}\n\n${stableTail}`;
  return `${instructions.slice(0, at)}\n\n${stableTail}${instructions.slice(at)}`;
}
