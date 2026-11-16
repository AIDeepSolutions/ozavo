import { z } from "zod";
import { agendaNotWired, agendaUnavailable } from "../agenda-speech";
import { defineTool } from "../define-tool";
import { agendaAvailability, agendaOf, settingsAgendaDeps, type ToolDeps } from "../deps";

/**
 * Desmarca um compromisso da agenda (Cal.com ou Google Agenda, o conector da empresa).
 *
 * Destrutivo, então a confirmação nomeia o alvo: o modelo manda o dia e a hora do compromisso que
 * leu em voz alta, e a resposta repete esse horário para o agente confirmar com a pessoa. Sem
 * `confirmed: true`, nada sai da agenda.
 */
export function createAgendaCancelar(deps: ToolDeps = {}) {
  return defineTool({
    name: "agenda_cancelar",
    ...agendaAvailability(deps),
    description:
      "Desmarca um compromisso que já existe na agenda, quando a pessoa pede para cancelar e não quer outro horário. Antes, leia em voz alta o dia e a hora do compromisso que vai ser cancelado e pergunte se é esse mesmo; chame só depois do sim dela: sem `confirmed: true` nada é desmarcado. Use só com o identificador do agendamento que agenda_marcar devolveu ou que o operador informou. NÃO use para trocar o horário (use agenda_remarcar) nem quando a pessoa ainda está em dúvida: nesse caso, ofereça remarcar.",
    inputSchema: z.object({
      appointment_id: z
        .string()
        .min(1)
        .describe("O identificador do compromisso que vai ser cancelado, como veio de agenda_marcar ou das instruções do agente."),
      appointment_starts_at: z.iso
        .datetime({ offset: true })
        .describe("O dia e a hora do compromisso, em ISO 8601 com fuso, exatamente como você leu para a pessoa ao pedir a confirmação."),
      confirmed: z
        .boolean()
        .describe("Só `true` depois de ler o dia e a hora do compromisso em voz alta e a pessoa confirmar que quer cancelar esse. Sem isso, nada é desmarcado."),
    }),
    async run(input, ctx) {
      if (input.confirmed !== true) {
        return {
          ok: false,
          noEffect: true,
          message:
            "Nada foi cancelado: falta a confirmação da pessoa. Leia em voz alta o dia e a hora do compromisso, pergunte se é esse que ela quer cancelar " +
            "e, só depois do sim dela, chame de novo com confirmed=true.",
        };
      }

      const client = await agendaOf(deps, ctx.q);
      if (!client) return { ok: false, noEffect: true, message: agendaNotWired("o compromisso não foi cancelado") };
      if (!client.cancel) {
        return {
          ok: false,
          noEffect: true,
          message:
            "A agenda ligada nesta central não aceita cancelamento pelo agente, e o compromisso continua marcado. Ofereça anotar o pedido para a equipe cancelar (create_task) ou transferir para uma pessoa (transfer_to_human).",
        };
      }

      ctx.say("Um instante, estou cancelando.");
      try {
        await client.cancel({ appointmentId: input.appointment_id, callId: ctx.callId });
        return {
          ok: true,
          message: "Compromisso cancelado. Diga à pessoa que o horário que você leu foi desmarcado e pergunte se ela quer marcar outro.",
          data: { appointmentId: input.appointment_id, startsAt: input.appointment_starts_at, cancelled: true },
        };
      } catch {
        return { ok: false, message: agendaUnavailable("o compromisso não foi cancelado", "que foi cancelado") };
      }
    },
  });
}

export default createAgendaCancelar(settingsAgendaDeps());
