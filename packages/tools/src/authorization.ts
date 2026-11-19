/**
 * Autorização explícita para escrever na agenda (marcar, remarcar, cancelar).
 *
 * O modelo pode mandar `confirmed: true` sem a pessoa ter dito sim. A trava no código confere a conversa:
 * a ÚLTIMA fala de quem ligou precisa ser afirmativa, e a fala do agente que veio antes dela precisa ter lido
 * a hora do horário. Cancelar e remarcar só aceitam compromisso que pertence a quem está na ligação.
 *
 * A conversa chega pelo `ToolContext.conversation`, preenchido por quem roda a ligação a partir dos eventos
 * `transcript` da sessão. Sem `conversation` (um canal que não o declara), nada é conferido aqui.
 */

export interface ConversationView {
  /** O que a pessoa disse por último (texto final transcrito). */
  lastUserUtterance(): string | undefined;
  /** O que o agente disse antes da última fala da pessoa: a leitura do dia e da hora que ela respondeu. */
  agentBeforeLastUserUtterance(): string | undefined;
  /**
   * Os dois últimos blocos de fala do agente antes da última fala da pessoa, do mais recente para o mais antigo. Quem o declara
   * deixa a trava exigir que a ÚLTIMA leitura de horário seja a do horário gravado; sem ele, vale o texto junto de `agentBeforeLastUserUtterance`.
   */
  agentBlocksBeforeLastUserUtterance?(): string[];
  /** O fuso da agenda (vem da consulta de horários), para ler a hora de um instante em UTC como a pessoa a ouve. */
  rememberTimezone(timezone: string): void;
  agendaTimezone(): string | undefined;
  /** O compromisso passa a pertencer a quem está na ligação (marcado nesta ligação). */
  rememberAppointment(id: string): void;
  /**
   * Compromissos que o operador ou uma consulta ao conector da agenda declararam como de quem está na ligação (além dos marcados
   * nesta ligação). É o PONTO DE EXTENSÃO da opção (a): ver `CallerAppointmentsSource`.
   */
  allowAppointments(ids: Iterable<string>): void;
  /** `true` só para id marcado nesta ligação ou declarado por `allowAppointments`/`knownAppointmentIds`. Nega por padrão. */
  ownsAppointment(id: string): boolean;
}

/**
 * Ponto de extensão (opção (a), NÃO implementado): consultar o conector da agenda pelo telefone de quem ligou e devolver os ids dos
 * compromissos dele. Quem o implementar passa a fonte a `call-session` (`CallSessionDeps.callerAppointments`), que a consulta uma
 * vez por ligação e entrega o resultado a `ConversationView.allowAppointments`. Enquanto não existir, valem só os ids marcados
 * nesta ligação e os que o operador informa em `request_context.appointmentIds` (`appointmentIdsFromRequestContext`).
 */
export interface CallerAppointmentsSource {
  appointmentsOf(phoneE164: string): Promise<readonly string[]>;
}

/** Chave de `request_context` em que o operador informa os ids de compromisso da pessoa da ligação de saída. */
export const REQUEST_CONTEXT_APPOINTMENT_IDS = "appointmentIds";
const MAX_CONTEXT_APPOINTMENT_IDS = 50;

/** Lê `request_context.appointmentIds` (lista de textos, até 50, até 200 caracteres cada). Qualquer outra forma é ignorada. */
export function appointmentIdsFromRequestContext(requestContext: unknown): string[] {
  if (typeof requestContext !== "object" || requestContext === null || Array.isArray(requestContext)) return [];
  const raw = (requestContext as Record<string, unknown>)[REQUEST_CONTEXT_APPOINTMENT_IDS];
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.trim() !== "" && id.length <= 200).slice(0, MAX_CONTEXT_APPOINTMENT_IDS);
}

/** O registro da conversa de uma ligação. Quem roda a ligação alimenta `push` com cada `transcript`. */
export class ConversationLog implements ConversationView {
  private readonly turns: { speaker: "user" | "agent"; text: string }[] = [];
  private readonly owned = new Set<string>();
  private readonly known: Set<string>;
  private timezone: string | undefined;

  /** `knownAppointmentIds`: os compromissos que a pessoa já tinha ao ligar. Omitido: nenhum (cancelar e remarcar só valem para o que for marcado nesta ligação). */
  constructor(options: { knownAppointmentIds?: Iterable<string> } = {}) {
    this.known = new Set(options.knownAppointmentIds ?? []);
  }

  push(speaker: "user" | "agent", text: string): void {
    if (text.trim() !== "") this.turns.push({ speaker, text });
  }

  lastUserUtterance(): string | undefined {
    for (let i = this.turns.length - 1; i >= 0; i--) if (this.turns[i]?.speaker === "user") return this.turns[i]?.text;
    return undefined;
  }

  /** As duas últimas falas do agente (blocos entre falas da pessoa) antes da última fala da pessoa: a leitura da hora pode ter vindo uma rodada antes. */
  agentBeforeLastUserUtterance(): string | undefined {
    let i = this.turns.length - 1;
    while (i >= 0 && this.turns[i]?.speaker !== "user") i--;
    if (i < 0) return undefined;
    // Blocos de fala do agente (separados por falas da pessoa), do mais recente para o mais antigo.
    const groups: string[][] = [];
    for (let j = i - 1; j >= 0 && groups.length < 2; j--) {
      const turn = this.turns[j];
      if (turn?.speaker !== "agent") continue;
      const last = this.turns[j + 1];
      if (groups.length === 0 || last?.speaker === "user") groups.push([turn.text]);
      else groups[groups.length - 1]?.unshift(turn.text);
    }
    const text = groups.reverse().flat().join(" ");
    return text === "" ? undefined : text;
  }

  agentBlocksBeforeLastUserUtterance(): string[] {
    let i = this.turns.length - 1;
    while (i >= 0 && this.turns[i]?.speaker !== "user") i--;
    if (i < 0) return [];
    const groups: string[][] = [];
    for (let j = i - 1; j >= 0 && groups.length < 2; j--) {
      const turn = this.turns[j];
      if (turn?.speaker !== "agent") continue;
      const last = this.turns[j + 1];
      if (groups.length === 0 || last?.speaker === "user") groups.push([turn.text]);
      else groups[groups.length - 1]?.unshift(turn.text);
    }
    return groups.map((group) => group.join(" "));
  }

  rememberTimezone(timezone: string): void {
    this.timezone = timezone;
  }

  agendaTimezone(): string | undefined {
    return this.timezone;
  }

  rememberAppointment(id: string): void {
    this.owned.add(id);
  }

  allowAppointments(ids: Iterable<string>): void {
    for (const id of ids) this.known.add(id);
  }

  ownsAppointment(id: string): boolean {
    return this.owned.has(id) || this.known.has(id);
  }
}

const strip = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// ---------------------------------------------------------------------------------------------------------------------
// O "sim" da pessoa
// ---------------------------------------------------------------------------------------------------------------------

/** Palavras de assentimento. "quero" NÃO está aqui: "quero outro horário" e "quero remarcar" pedem coisa, não respondem sim. */
const ASSENT = /\b(sim|pode|podem|confirmo|confirmado|confirma|isso|certo|ok|okay|beleza|fechado|combinado|perfeito|claro|esse mesmo|esta bom|ta bom|tudo bem|otimo|bom|uhum|aham|positivo)\b/;
/** "Pode falar", "pode repetir": dão a vez ao agente, não autorizam nada. */
const NOT_CONSENT = /\bpode\s+(?:me\s+|nos\s+)?(?:repetir|falar|dizer|explicar|informar|ler|passar|mandar|enviar)\b/;
const NEGATIVE = /\b(nao|nunca|jamais|espera|calma|pera|desisto|deixa pra la|esquece|melhor nao)\b/;
/**
 * Mudança de ideia ou pedido diferente: "sim, mas…", "na verdade…", "outro dia". Nada disso é um sim ao que foi lido. "Trocar", "mudar" e
 * "alterar" NÃO entram: são a própria ação que se confirma numa remarcação ("pode confirmar essa troca"); o dia ou a hora diferentes
 * são conferidos à parte, contra o horário gravado.
 */
const CHANGE_OF_MIND = /\b(mas|porem|contudo|todavia|na verdade|outro|outra|outros|outras|diferente)\b/;

/**
 * A fala é um "sim" claro: alguma frase que não é pergunta tem palavra de assentimento, nada na fala nega, e nada na fala muda o
 * pedido ("mas", "na verdade", "outro dia"). "Não, pode sim" e "Não… sim, pode" valem como sim (a negação responde a outra
 * coisa e vem logo seguida do assentimento). Dia e hora ditos pela pessoa são conferidos à parte, em `checkWriteAuthorization`.
 */
export function isAffirmative(text: string | undefined): boolean {
  if (!text) return false;
  const plain = strip(text);
  // "Não preciso de mais nada" e "sem problema" respondem a outra pergunta: não negam o sim.
  const withoutIdioms = plain.replace(/nao tem problema|sem problema|nao (?:preciso|precisa|tenho|quero) (?:de )?mais (?:nada|nenhuma)\w*|nao precisa de mais nada|so isso|e so/g, "");
  // "Não, pode sim" / "Não… sim, pode": a negação é seguida logo do assentimento.
  const withoutRetractedNo = withoutIdioms.replace(/\bnao\b[\s,.…-]+(?=(?:pode\s+sim|sim\b|pode\b))/g, "");
  if (NEGATIVE.test(withoutRetractedNo)) return false;
  if (CHANGE_OF_MIND.test(withoutRetractedNo)) return false;
  return withoutRetractedNo
    .split(/(?<=[.!?…])\s+/)
    .some((sentence) => !/\?\s*$/.test(sentence.trim()) && ASSENT.test(sentence) && !NOT_CONSENT.test(sentence));
}

// ---------------------------------------------------------------------------------------------------------------------
// Hora, minuto e dia do horário que vai ser gravado
// ---------------------------------------------------------------------------------------------------------------------

const HOUR_WORDS = ["meia-noite", "uma", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze"];
const COMPOUND_HOURS = ["", "", "", "", "", "", "", "", "", "", "", "", "", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove", "vinte", "vinte e uma", "vinte e duas", "vinte e tres"];
const WEEKDAY_NAMES = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const MONTH_NAMES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** O horário do jeito que a pessoa o ouve, no fuso da agenda. */
export interface SlotParts {
  hour: number;
  minute: number;
  /** 0 = domingo. */
  weekday: number;
  day: number;
  month: number;
  /** AAAA-MM-DD local. */
  date: string;
}

/**
 * As partes locais de um horário. ISO com deslocamento sem fuso conhecido vale pelo texto (a hora que o deslocamento diz);
 * um instante em UTC ("Z") só tem hora local se o fuso da agenda for conhecido. Sem como saber, devolve `undefined`.
 */
export function localParts(startsAtIso: string, timezone?: string): SlotParts | undefined {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(startsAtIso)) return undefined;
  if (timezone) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(startsAtIso));
    const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    const weekday = SHORT_WEEKDAYS.indexOf(pick("weekday"));
    if (weekday < 0) return undefined;
    return { hour: Number(pick("hour")), minute: Number(pick("minute")), weekday, day: Number(pick("day")), month: Number(pick("month")), date: `${pick("year")}-${pick("month")}-${pick("day")}` };
  }
  if (/Z$/.test(startsAtIso)) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAtIso);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  return { hour: Number(hour), minute: Number(minute), weekday: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay(), day: Number(day), month: Number(month), date: `${year}-${month}-${day}` };
}

/** A hora (0 a 23) em que a pessoa ouve o horário, ou `undefined` quando não há como saber. */
export function localHour(startsAtIso: string, timezone?: string): number | undefined {
  return localParts(startsAtIso, timezone)?.hour;
}

const MINUTE_WORD: Record<string, number> = { meia: 30, trinta: 30, quinze: 15, "vinte e cinco": 25, vinte: 20, "quarenta e cinco": 45, quarenta: 40, cinquenta: 50, cinco: 5, dez: 10, "um quarto": 15 };
const minuteOf = (word: string | undefined): number => (word === undefined ? 0 : (MINUTE_WORD[word.replace(/\s+/g, " ")] ?? (/^\d+$/.test(word) ? Number(word) : 0)));
const MINUTE_WORDS = "vinte\\s+e\\s+cinco|quarenta\\s+e\\s+cinco|um\\s+quarto|meia|trinta|quinze|vinte|quarenta|cinquenta|cinco|dez";

/**
 * O texto lê a hora E o minuto deste horário? Número ("16h30", "16:30", "4 e meia da tarde", "14 horas") ou por extenso
 * ("quatro e meia", "dez", "meio-dia e meia"), em 24 h ou 12 h. "14h" lido para um horário de 14h30 NÃO vale, nem "14h30" para 14h.
 */
function readsClock(plain: string, parts: SlotParts): boolean {
  const { hour, minute } = parts;
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  const digits = new RegExp(
    `(?:\\b0?${hour}|\\b${twelve})\\s*(?:h(?![a-z])\\s*(\\d{2})?|horas?\\b(?:\\s+e\\s+(${MINUTE_WORDS}|\\d{1,2}))?|:(\\d{2})|e\\s+(${MINUTE_WORDS}|\\d{1,2})|\\s*da\\s+(?:manha|tarde|noite|madrugada))`,
    "g",
  );
  for (const match of plain.matchAll(digits)) {
    const said = match[1] ?? match[3] ?? match[2] ?? match[4];
    if (minuteOf(said) === minute) return true;
  }
  const words = new Set<string>();
  if (hour === 0) words.add("meia-noite");
  else if (hour === 12) {
    words.add("meio-dia");
    words.add("doze");
  }
  const spoken = HOUR_WORDS[twelve % 12 === 0 ? 0 : twelve];
  if (spoken && hour !== 0 && hour !== 12) words.add(spoken);
  const compound = hour >= 13 && hour <= 23 ? COMPOUND_HOURS[hour] : undefined;
  if (compound) words.add(compound);
  for (const word of words) {
    const wordForm = new RegExp(`\\b${word}\\b(?:\\s+horas?)?(?:\\s+e\\s+(${MINUTE_WORDS}))?`, "g");
    for (const match of plain.matchAll(wordForm)) if (minuteOf(match[1]) === minute) return true;
  }
  return false;
}

/** O texto cita algum dia (dia da semana, "dia 20", "20/11", "20 de novembro", "amanhã", "hoje")? */
export function mentionsDay(text: string | undefined): boolean {
  if (!text) return false;
  const plain = strip(text);
  return (
    new RegExp(`\\b(?:${WEEKDAY_NAMES.join("|")})\\b`).test(plain) ||
    /\bdia\s+\d{1,2}\b|\b\d{1,2}\s*\/\s*\d{1,2}\b/.test(plain) ||
    new RegExp(`\\b\\d{1,2}\\s+de\\s+(?:${MONTH_NAMES.join("|")})\\b`).test(plain) ||
    /\b(?:amanha|hoje|depois de amanha)\b/.test(plain)
  );
}

/** Dia da semana e dia do mês lidos conferem com o horário? Só confere o que foi lido; "amanhã" e "hoje" só com `now`. */
function dayMatches(plain: string, parts: SlotParts, timezone: string | undefined, now: Date | undefined): boolean {
  const weekdays = WEEKDAY_NAMES.map((name, index) => (new RegExp(`\\b${name}\\b`).test(plain) ? index : -1)).filter((index) => index >= 0);
  if (weekdays.length > 0 && !weekdays.includes(parts.weekday)) return false;
  const dated: Array<{ day: number; month?: number }> = [];
  for (const match of plain.matchAll(/\bdia\s+(\d{1,2})\b/g)) dated.push({ day: Number(match[1]) });
  for (const match of plain.matchAll(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/g)) dated.push({ day: Number(match[1]), month: Number(match[2]) });
  for (const match of plain.matchAll(new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${MONTH_NAMES.join("|")})\\b`, "g"))) dated.push({ day: Number(match[1]), month: MONTH_NAMES.indexOf(match[2] ?? "") + 1 });
  if (dated.length > 0 && !dated.some((item) => item.day === parts.day && (item.month === undefined || item.month === parts.month))) return false;
  // Dia da semana ou data explícitos têm precedência: "hoje é quarta, 18; amanhã, quinta, 19…" cita "hoje" como contexto, não como o dia do horário.
  const explicit = weekdays.length > 0 || dated.length > 0;
  if (now && timezone && !explicit) {
    const dateOf = (offsetDays: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now.getTime() + offsetDays * 86_400_000));
    if (/\bdepois de amanha\b/.test(plain)) return parts.date === dateOf(2);
    if (/\bamanha\b/.test(plain) && parts.date !== dateOf(1)) return false;
    if (/\bhoje\b/.test(plain) && parts.date !== dateOf(0)) return false;
  }
  return true;
}

/**
 * O agente leu a hora, o minuto e (quando leu algum dia) o dia deste horário? Sem como saber a hora local, não bloqueia (quem
 * decide negar é `checkWriteAuthorization`).
 */
export function readsHour(agentText: string | undefined, startsAtIso: string, timezone?: string, now?: Date): boolean {
  const parts = localParts(startsAtIso, timezone);
  if (parts === undefined) return true;
  if (!agentText) return false;
  const plain = strip(agentText);
  return readsClock(plain, parts) && dayMatches(plain, parts, timezone, now);
}

const CLOCK_WORDS = "uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte";
/** O texto cita algum horário do dia ("16h30", "às 14h", "10:30", "meio-dia", "quatro e meia", "duas da tarde")? */
export function mentionsClockTime(text: string | undefined): boolean {
  if (!text) return false;
  const plain = strip(text);
  // Número + "h"/"horas"/":mm"; número + "e meia"/"e quinze"/"da tarde" ("4 e meia da tarde", "2 da tarde"); "meio-dia"; hora por extenso.
  return new RegExp(
    `\\b\\d{1,2}\\s*(?:h\\b|h\\d{2}\\b|horas?\\b|:\\d{2})|\\b\\d{1,2}\\s+(?:e\\s+(?:${MINUTE_WORDS}|\\d{1,2})|da\\s+(?:manha|tarde|noite|madrugada))|meio-dia|meia-noite|(?<!\\bdia\\s)\\b(?:${CLOCK_WORDS})\\s+(?:horas?\\b|e\\s+(?:${MINUTE_WORDS})|da\\s+(?:manha|tarde|noite|madrugada))`,
  ).test(plain);
}

/**
 * A ÚLTIMA leitura do agente é a do horário gravado (hora, minuto e dia)? Do bloco de fala mais recente para o mais antigo: o
 * primeiro que cita algum horário decide (se ele lê outro horário, o sim da pessoa foi a esse outro); um bloco sem horário
 * nenhum ("Posso confirmar?") deixa a conferência da hora para o bloco anterior. O DIA só é conferido quando foi lido: vale o
 * dia do bloco mais recente (até o bloco da hora) que cita algum; se nenhum dos dois últimos blocos cita dia, só a hora e o
 * minuto são exigidos (decisão: a pessoa e o agente já falavam do mesmo dia, e exigir o dia em toda releitura travaria
 * conversas naturais). Sem hora local conhecida, não bloqueia (como `readsHour`).
 */
export function lastReadbackMatches(blocks: readonly string[], startsAtIso: string, timezone?: string, now?: Date): boolean {
  const parts = localParts(startsAtIso, timezone);
  if (parts === undefined) return true;
  for (const [index, block] of blocks.entries()) {
    if (!mentionsClockTime(block)) continue;
    if (!readsClock(strip(block), parts)) return false;
    for (const candidate of blocks.slice(0, index + 1)) if (mentionsDay(candidate)) return dayMatches(strip(candidate), parts, timezone, now);
    return true;
  }
  return false;
}

export interface WriteAuthorization {
  ok: boolean;
  message?: string;
}

/**
 * Confere a autorização de uma escrita. `startsAt`: o horário que será gravado (marcar, remarcar), para conferir a leitura;
 * `appointmentId`: o compromisso afetado (remarcar, cancelar); `now`: o relógio da ligação, para "amanhã" e "hoje".
 *
 * Quando a trava age e quando não:
 * - Sem `conversation`, autoriza (fail-open, de propósito): só `call-session.ts` roda ferramentas (`runTool`) e ele sempre
 *   declara a conversa, em todos os canais de voz e de WhatsApp; quem chama a ferramenta direto (teste de unidade, script)
 *   não tem conversa para conferir.
 * - Com `conversation` e um horário em UTC ("Z") cujo fuso não se conhece (nem a consulta de horários nem o conector da agenda
 *   o registraram), NEGA com uma mensagem ao modelo: sem fuso a hora não tem como ser conferida, e nunca se grava sem conferir.
 */
export function checkWriteAuthorization(
  conversation: ConversationView | undefined,
  what: { verb: "marcar" | "remarcar" | "cancelar"; startsAt?: string; appointmentId?: string; now?: Date },
): WriteAuthorization {
  if (!conversation) return { ok: true };
  const done = what.verb === "marcar" ? "marcado" : what.verb === "remarcar" ? "remarcado" : "cancelado";
  if (what.appointmentId !== undefined && what.verb !== "marcar" && !conversation.ownsAppointment(what.appointmentId)) {
    return {
      ok: false,
      message: `Nada foi ${done}: esse compromisso não está entre os que esta ligação conhece como de quem está na linha (só valem os marcados agora, nesta ligação, e os que a empresa informou ao pedir a ligação). Não tente outro identificador; se não houver, ofereça anotar o pedido para a equipe (create_task) ou transferir para uma pessoa (transfer_to_human).`,
    };
  }
  const lastUser = conversation.lastUserUtterance();
  if (!isAffirmative(lastUser)) {
    return {
      ok: false,
      message: `Nada foi ${done}: a última fala da pessoa não foi um sim claro. Leia em voz alta o dia e a hora, pergunte se pode confirmar e espere o sim dela antes de chamar de novo.`,
    };
  }
  if (what.startsAt !== undefined) {
    const timezone = conversation.agendaTimezone();
    const parts = localParts(what.startsAt, timezone);
    if (parts === undefined) {
      return {
        ok: false,
        message: `Nada foi ${done}: ainda não sei em que fuso a agenda vale, então não consigo conferir a hora. Chame agenda_horarios_livres para esta consulta, leia em voz alta o dia e a hora que ela devolve, peça o sim da pessoa e chame de novo.`,
      };
    }
    // A própria fala da pessoa, quando cita dia ou hora, tem que citar os do horário gravado ("sim, mas às 15h" não autoriza 14h).
    const userPlain = strip(lastUser ?? "");
    if ((mentionsClockTime(lastUser) && !readsClock(userPlain, parts)) || (mentionsDay(lastUser) && !dayMatches(userPlain, parts, timezone, what.now))) {
      return {
        ok: false,
        message: `Nada foi ${done}: a pessoa disse sim, mas na mesma fala citou um dia ou uma hora diferente do que será gravado. Leia em voz alta o dia e a hora exatos, pergunte se pode confirmar e espere o sim dela antes de chamar de novo.`,
      };
    }
    const blocks = conversation.agentBlocksBeforeLastUserUtterance?.();
    const matches = blocks
      ? lastReadbackMatches(blocks, what.startsAt, timezone, what.now)
      : readsHour(conversation.agentBeforeLastUserUtterance(), what.startsAt, timezone, what.now);
    if (!matches) {
      // Leu outro horário (a pessoa disse sim a ele) ou não leu horário nenhum.
      const readAnother = blocks?.some((block) => mentionsClockTime(block) || mentionsDay(block)) ?? false;
      return {
        ok: false,
        message: readAnother
          ? `Nada foi ${done}: a pessoa disse sim, mas a última leitura que você fez a ela foi de outro dia ou hora, não deste horário. Leia em voz alta o dia e a hora exatos que serão gravados, pergunte se pode confirmar e espere o sim dela antes de chamar de novo.`
          : `Nada foi ${done}: a pessoa disse sim, mas você ainda não leu para ela o dia e a hora deste horário. Leia em voz alta o dia e a hora, pergunte se pode confirmar e espere o sim dela antes de chamar de novo.`,
      };
    }
  }
  return { ok: true };
}
