import { describe, expect, it } from "vitest";
import { contextoDaAgenda, crmSimulado } from "../../test/agenda";
import { createAgendaCancelar } from "./agenda_cancelar";

const HORARIO = "2026-11-18T09:00:00-03:00";

describe("agenda_cancelar", () => {
  it("desmarca o compromisso depois da confirmação, e devolve o horário que foi desmarcado", async () => {
    const crm = crmSimulado();
    const marcado = await crm.book({ serviceType: "Consulta", startsAt: HORARIO, callId: "call-1" });
    const ctx = contextoDaAgenda();

    const result = await createAgendaCancelar({ agenda: crm }).run({ appointment_id: marcado.id, appointment_starts_at: HORARIO, confirmed: true }, ctx);

    expect(result).toMatchObject({ ok: true, data: { appointmentId: marcado.id, startsAt: HORARIO, cancelled: true } });
    expect(crm.pedidos.cancelamentos).toEqual([{ appointmentId: marcado.id, callId: "call-1" }]);
    expect(crm.compromissos.has(marcado.id)).toBe(false);
    expect(ctx.said).toEqual(["Um instante, estou cancelando."]);
  });

  it("sem a confirmação em voz alta, nada sai da agenda", async () => {
    const crm = crmSimulado();
    const marcado = await crm.book({ serviceType: "Consulta", startsAt: HORARIO, callId: "call-1" });

    const result = await createAgendaCancelar({ agenda: crm }).run({ appointment_id: marcado.id, appointment_starts_at: HORARIO, confirmed: false }, contextoDaAgenda());

    expect(result).toMatchObject({ ok: false, noEffect: true });
    expect(result.message).toContain("falta a confirmação");
    expect(crm.pedidos.cancelamentos).toEqual([]);
    expect(crm.compromissos.has(marcado.id)).toBe(true);
  });

  it("agenda fora do ar ou compromisso desconhecido vira fala, sem prometer o cancelamento", async () => {
    const crm = crmSimulado();
    const result = await createAgendaCancelar({ agenda: crm }).run({ appointment_id: "nao-existe", appointment_starts_at: HORARIO, confirmed: true }, contextoDaAgenda());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("não respondeu");
    expect(result.message).toContain("NÃO diga que foi cancelado");
  });

  it("conector que não sabe cancelar diz isso sem mexer na agenda", async () => {
    const crm = crmSimulado();
    const semCancelar = { freeSlots: crm.freeSlots, book: crm.book, reschedule: crm.reschedule };
    const result = await createAgendaCancelar({ agenda: semCancelar }).run({ appointment_id: "agendamento-1", appointment_starts_at: HORARIO, confirmed: true }, contextoDaAgenda());
    expect(result).toMatchObject({ ok: false, noEffect: true });
    expect(result.message).toContain("não aceita cancelamento");
  });

  it("recusa argumento sem o horário do compromisso: a confirmação nomeia o alvo", () => {
    const tool = createAgendaCancelar({ agenda: crmSimulado() });
    expect(tool.inputSchema.safeParse({ appointment_id: "agendamento-1", confirmed: true }).success).toBe(false);
  });
});
