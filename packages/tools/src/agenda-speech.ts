/**
 * As falas da agenda. As três ferramentas dizem a mesma coisa quando a agenda não está ligada ou
 * quando ela não responde; a fala mora aqui para não divergir entre elas.
 *
 * `outcome` é o que deixou de acontecer, na voz do resultado: "o horário não foi marcado",
 * "os horários não foram consultados".
 */

/** A agenda ainda não tem cliente ligado nesta central (o conector é a fatia seguinte). */
export function agendaNotWired(outcome: string): string {
  return (
    `A agenda não está ligada nesta central, e ${outcome}. Diga à pessoa, com naturalidade, ` +
    "que você não consegue mexer na agenda agora e ofereça anotar o pedido para a equipe retornar " +
    "(create_task) ou transferir para uma pessoa (transfer_to_human)."
  );
}

/** A agenda respondeu com erro ou não respondeu: a ligação continua, sem promessa falsa. */
export function agendaUnavailable(outcome: string, neverSay = "que está marcado"): string {
  return (
    `O sistema de agenda não respondeu agora, e ${outcome}. Diga à pessoa que não foi possível ` +
    "concluir neste momento e ofereça anotar o pedido para a equipe retornar (create_task) ou transferir " +
    `para uma pessoa (transfer_to_human). NÃO diga ${neverSay}.`
  );
}

/**
 * A consulta de horários deu ERRO (a agenda não respondeu, ou recusou o pedido): não é falta de vaga.
 * A fala diz isso em voz alta ao modelo, para ele nunca transformar erro em "não há horário".
 */
export function agendaQueryError(): string {
  return (
    "ERRO DE CONSULTA: a agenda não respondeu e os horários NÃO foram consultados, então não se sabe se há vaga. " +
    "NÃO diga que não há horário livre nem que a agenda está cheia. Diga à pessoa que não foi possível consultar a agenda neste momento " +
    "e ofereça anotar o pedido para a equipe retornar (create_task) ou transferir para uma pessoa (transfer_to_human)."
  );
}

/**
 * Todos os horários livres agrupados por dia, no fuso da agenda: "segunda-feira, 23/11: 09:00, 11:00, 17:00; terça-feira, 24/11: ...".
 * Dá ao modelo a lista inteira já filtrável por dia e período, em vez de só os três primeiros horários lidos em voz alta.
 */
export function groupSlotsByDay(slots: ReadonlyArray<{ startsAt: string }>, timezone: string, max = 40): string {
  const dayOf = new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, weekday: "long", day: "2-digit", month: "2-digit" });
  const timeOf = new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
  const days = new Map<string, string[]>();
  for (const slot of slots.slice(0, max)) {
    const at = new Date(slot.startsAt);
    const day = dayOf.format(at);
    days.set(day, [...(days.get(day) ?? []), timeOf.format(at)]);
  }
  return [...days].map(([day, times]) => `${day}: ${times.join(", ")}`).join("; ");
}

/**
 * O horário em palavras, para o agente ler ao telefone: dia da semana, data e hora no fuso da regra
 * da agenda. Datas vêm do CRM em ISO; a conversão é só de apresentação e não lê o relógio.
 */
export function speakSlot(startsAt: string, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(startsAt));
}

/** Pedaços de texto que parecem segredo ou dado da pessoa: chave de API do Cal.com, token Bearer, sequência longa de letras e números, e-mail e telefone. */
const SECRETISH = /\bcal_(?:live|test)_[\w-]+|Bearer\s+\S+|[A-Za-z0-9_-]{32,}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\+?\d[\d\s().-]{8,}\d/g;

/**
 * O motivo técnico de uma falha da agenda, em uma linha, para o operador ver na linha do tempo (`tool_result.diagnostic`):
 * a cadeia de erros (tipo, mensagem e código de rede) sem chave nem trecho longo. O modelo nunca recebe isto.
 */
export function agendaFailureDiagnostic(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    parts.push(`${current.name}: ${current.message}${typeof code === "string" ? ` [${code}]` : ""}`);
    current = current.cause;
  }
  return parts.join(" <- ").replace(SECRETISH, "<oculto>").slice(0, 400);
}
