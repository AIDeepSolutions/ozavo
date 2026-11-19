import { z } from "zod";
import { agendaNotWired, agendaQueryError, groupSlotsByDay, speakSlot } from "../agenda-speech";
import { defineTool } from "../define-tool";
import { agendaAvailability, agendaOf, settingsAgendaDeps, type ToolDeps } from "../deps";

/** Janela padrão quando a pessoa não diz o período: uma semana à frente. */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Janela de reserva quando a pessoa pede um instante só (fim igual ou antes do começo): um dia a partir do começo. */
const MIN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Opções que vão na fala: três já é o bastante ao telefone, e a lista completa fica em `data.slots`. */
const SPOKEN_SLOTS = 3;

/** Opções de apresentação do resultado. O padrão é o de produção; `groupByDay` é um EXPERIMENTO da bancada (R2) e fica desligado. */
export interface HorariosLivresOptions {
  /** Acrescenta à mensagem todos os horários livres agrupados por dia, para o modelo filtrar por dia e período sem raciocinar sobre a lista em ISO. */
  groupByDay?: boolean;
}

export function createAgendaHorariosLivres(deps: ToolDeps = {}, options: HorariosLivresOptions = {}) {
  return defineTool({
    name: "agenda_horarios_livres",
    ...agendaAvailability(deps),
    description:
      "Consulta os horários livres na agenda para um tipo de atendimento, num período. Use quando a pessoa quiser marcar ou remarcar e ainda não souber que horas há vaga. Devolve os horários em ISO 8601 e em palavras, no fuso da agenda: leia em voz alta o dia da semana e a hora de até três opções e peça que a pessoa escolha. NÃO use para gravar nada nem para confirmar horário: para marcar, use agenda_marcar depois que a pessoa confirmar em voz alta; para trocar um horário já marcado, use agenda_remarcar. NÃO ofereça horário que não esteja na lista devolvida.",
    inputSchema: z.object({
      service_type: z
        .string()
        .min(1)
        .max(200)
        .describe("O tipo de atendimento, exatamente como o operador cadastrou na agenda. Ex.: 'Consulta' ou 'Visita de orçamento'."),
      from: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("Começo da janela, em ISO 8601 com fuso. Sem valor, começa agora."),
      to: z.iso
        .datetime({ offset: true })
        .optional()
        .describe("Fim da janela, em ISO 8601 com fuso. Sem valor, sete dias depois do começo."),
      duration_minutes: z
        .number()
        .int()
        .min(5)
        .max(24 * 60)
        .optional()
        .describe("Duração do atendimento em minutos, quando for diferente da duração padrão do tipo."),
    }),
    async run(input, ctx) {
      const client = await agendaOf(deps, ctx.q);
      if (!client) return { ok: false, message: agendaNotWired("os horários não foram consultados") };

      const now = ctx.clock.now();
      const requestedFrom = input.from ? new Date(input.from) : now;
      const requestedTo = input.to ? new Date(input.to) : undefined;
      const notes: string[] = [];

      // Nunca consulta o passado: o começo sobe para agora, e uma janela inteira no passado é recusada.
      let from = requestedFrom;
      if (from.getTime() < now.getTime()) {
        from = now;
        notes.push("o começo pedido já passou, e a consulta começa agora");
      }
      if (requestedTo && requestedTo.getTime() <= now.getTime()) {
        return {
          ok: false,
          noEffect: true,
          message:
            "O período pedido já passou, e nada foi consultado. Confirme com a pessoa para qual dia ela quer e chame de novo com uma data futura.",
        };
      }

      // Janela válida sempre: fim ausente = sete dias; fim igual ou antes do começo = um dia a partir do começo.
      let to = requestedTo ?? new Date(from.getTime() + DEFAULT_WINDOW_MS);
      if (to.getTime() <= from.getTime()) {
        to = new Date(from.getTime() + MIN_WINDOW_MS);
        notes.push("o fim pedido não era depois do começo, e a janela foi ampliada para um dia");
      }
      const window = { from: from.toISOString(), to: to.toISOString() };
      const windowNote = notes.length > 0 ? `Atenção: ${notes.join("; e ")}. Janela consultada: de ${window.from} até ${window.to}. ` : "";

      ctx.say("Um instante, estou conferindo a agenda.");
      try {
        const agenda = await client.freeSlots({
          serviceType: input.service_type,
          from: from.toISOString(),
          to: to.toISOString(),
          durationMinutes: input.duration_minutes,
          callId: ctx.callId,
        });

        ctx.conversation?.rememberTimezone(agenda.timezone);

        if (agenda.slots.length === 0) {
          return {
            ok: true,
            message:
              `${windowNote}Não há horário livre para ${input.service_type} nesse período (a consulta funcionou e voltou vazia). Ofereça outro período, ` +
              "ou anote o pedido para a equipe retornar (create_task). Não invente horário.",
            data: { slots: [], timezone: agenda.timezone, window },
          };
        }

        const spoken = agenda.slots
          .slice(0, SPOKEN_SLOTS)
          .map((slot) => speakSlot(slot.startsAt, agenda.timezone))
          .join("; ");
        return {
          ok: true,
          message:
            `${windowNote}Há ${agenda.slots.length} horário(s) livre(s) para ${input.service_type} (fuso ${agenda.timezone}). ` +
            `Leia em voz alta, uma por vez, e peça que a pessoa escolha: ${spoken}. ` +
            "Depois que ela confirmar o dia e a hora em voz alta, chame agenda_marcar com esse horário e confirmed=true. " +
            "Não ofereça horário fora da lista." +
            (options.groupByDay || ctx.presentation?.groupSlotsByDay
              ? ` Todos os horários livres, por dia: ${groupSlotsByDay(agenda.slots, agenda.timezone)}. Ao oferecer ou confirmar, use só horários desta lista, no dia e no período que a pessoa pediu (manhã até 11:59, tarde a partir de 12:00); se a lista não tem horário no dia ou período pedido, diga isso e ofereça os dias que têm.`
              : ""),
          data: { slots: agenda.slots, timezone: agenda.timezone, window },
        };
      } catch {
        return { ok: false, message: agendaQueryError(), data: { error: "query_failed" } };
      }
    },
  });
}

export default createAgendaHorariosLivres(settingsAgendaDeps());
