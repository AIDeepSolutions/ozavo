import { z } from "zod";
import { agendaNotWired, agendaUnavailable } from "../agenda-speech";
import { checkWriteAuthorization } from "../authorization";
import { defineTool } from "../define-tool";
import { AgendaBookingFieldProblem, type AgendaBookingField } from "../connectors/agenda";
import { agendaAvailability, agendaOf, settingsAgendaDeps, type ToolDeps } from "../deps";

const FIELD_QUESTION: Record<AgendaBookingField, string> = {
  name: "o nome da pessoa",
  company: "a empresa dela",
  email: "o e-mail dela (peça para soletrar e confirme repetindo)",
  process: "o processo que ela quer melhorar",
};

/** A agenda recusou por um dado da pessoa: nada foi marcado e o modelo sabe o que perguntar. */
function fieldProblemSpeech(problem: AgendaBookingFieldProblem): string {
  const what = FIELD_QUESTION[problem.field];
  const why = problem.kind === "missing" ? "a agenda exige esse dado para marcar" : "a agenda não aceitou esse dado";
  return `Nada foi marcado: ${why}. Pergunte à pessoa ${what}, com naturalidade, e chame agenda_marcar de novo com esse dado. Se ela não quiser informar, ofereça anotar o pedido para a equipe retornar (create_task). NÃO diga que está marcado.`;
}

export function createAgendaMarcar(deps: ToolDeps = {}) {
  return defineTool({
    name: "agenda_marcar",
    ...agendaAvailability(deps),
    // Nome, e-mail, empresa e processo são texto sobre quem ligou: moram na agenda, e a linha do tempo não os guarda.
    personalTextArgs: true,
    description:
      "Marca um horário na agenda, depois que a pessoa confirmou o dia e a hora em voz alta. Chame só depois de ler o dia e a hora e ouvir o sim dela: sem `confirmed: true` nada é gravado. Use o horário exato que agenda_horarios_livres devolveu. " +
      "ANTES de chamar, colete os dados da pessoa PARA A EQUIPE, perguntando UMA coisa por vez, nesta ordem: o nome, a empresa, o e-mail, o processo que ela quer melhorar e, por fim, o melhor horário. " +
      "O e-mail tem de ser confirmado: peça que a pessoa soletre, repita de volta letra por letra (\"arroba\", \"ponto\") e só use depois do sim dela; escreva no argumento já em forma de e-mail (fulano@empresa.com.br), nunca por extenso. " +
      "Mande só o que a pessoa disse: se ela não quis dar um dado, deixe o campo de fora, nunca invente nem preencha com palavra solta. Se a agenda exigir um dado que faltou, a resposta diz qual, e você pergunta e chama de novo. " +
      "NÃO use para trocar um horário já marcado (use agenda_remarcar), nem para marcar sem a confirmação da pessoa, nem para um horário que já passou. NÃO chame duas vezes para o mesmo pedido.",
    inputSchema: z.object({
      name: z.string().trim().max(120).optional().describe("O nome da pessoa, como ela disse. Pergunte primeiro. Não invente."),
      company: z.string().trim().max(200).optional().describe("A empresa da pessoa, como ela disse. Pergunte depois do nome."),
      email: z
        .string()
        .trim()
        .max(254)
        .optional()
        .describe("O e-mail da pessoa, no formato fulano@empresa.com.br, SÓ depois de ela soletrar e confirmar o que você repetiu. Pergunte depois da empresa."),
      process: z.string().trim().max(500).optional().describe("O processo ou a dor que a pessoa quer melhorar, em poucas palavras, como ela disse. Pergunte depois do e-mail."),
      notes: z.string().trim().max(1000).optional().describe("Observação extra que a pessoa pediu para registrar. Só se ela pediu."),
      service_type: z.string().min(1).max(200).describe("O tipo de atendimento, como o operador cadastrou na agenda."),
      starts_at: z.iso
        .datetime({ offset: true })
        .describe("O horário escolhido, em ISO 8601 com fuso, exatamente como veio de agenda_horarios_livres."),
      confirmed: z
        .boolean()
        .describe("Só `true` depois de ler o dia e a hora em voz alta e a pessoa confirmar. Sem isso, nada é gravado."),
    }),
    async run(input, ctx) {
      if (input.confirmed !== true) {
        return {
          ok: false,
          noEffect: true,
          message:
            "Nada foi marcado: falta a confirmação da pessoa. Leia em voz alta o dia e a hora, pergunte se pode marcar e, " +
            "só depois do sim dela, chame de novo com confirmed=true.",
        };
      }

      const email = input.email || undefined;
      if (email !== undefined && !z.email().safeParse(email).success) {
        return {
          ok: false,
          noEffect: true,
          message: "Nada foi marcado: esse e-mail não parece válido. Peça para a pessoa soletrar o e-mail de novo, repita de volta, e chame de novo só depois do sim dela.",
        };
      }

      const client = await agendaOf(deps, ctx.q);
      if (!client) return { ok: false, noEffect: true, message: agendaNotWired("o horário não foi marcado") };

      if (new Date(input.starts_at).getTime() <= ctx.clock.now().getTime()) {
        return {
          ok: false,
          noEffect: true,
          message:
            "Esse horário já passou, e nada foi marcado. Confira o dia e a hora com a pessoa e consulte de novo os horários livres.",
        };
      }

      if (client.timezone) ctx.conversation?.rememberTimezone(client.timezone);

      const authorization = checkWriteAuthorization(ctx.conversation, { verb: "marcar", startsAt: input.starts_at, now: ctx.clock.now() });
      if (!authorization.ok) return { ok: false, noEffect: true, message: authorization.message ?? "Nada foi marcado: falta a autorização da pessoa." };

      ctx.say("Um instante, estou marcando.");
      try {
        // O telefone vem da ligação, nunca do modelo.
        const line = await ctx.q.one<{ phone: string | null }>("select case when direction = 'inbound' then from_e164 else to_e164 end as phone from calls where id = $1", [ctx.callId]);
        const appointment = await client.book({
          serviceType: input.service_type,
          startsAt: input.starts_at,
          callId: ctx.callId,
          ...(line?.phone ? { attendeePhone: line.phone } : {}),
          ...(input.name && { attendeeName: input.name }),
          ...(email && { attendeeEmail: email }),
          ...(input.company && { company: input.company }),
          ...(input.process && { process: input.process }),
          ...(input.notes && { notes: input.notes }),
        });
        ctx.conversation?.rememberAppointment(appointment.id);
        return {
          ok: true,
          message:
            "Horário marcado. Confirme com a pessoa o dia e a hora que ela confirmou e diga que o horário está reservado. " +
            "Guarde o identificador do agendamento para uma remarcação.",
          data: { appointmentId: appointment.id, startsAt: appointment.startsAt },
        };
      } catch (error) {
        if (error instanceof AgendaBookingFieldProblem) return { ok: false, noEffect: true, message: fieldProblemSpeech(error) };
        return { ok: false, message: agendaUnavailable("o horário não foi marcado") };
      }
    },
  });
}

export default createAgendaMarcar(settingsAgendaDeps());
