import { describe, expect, it } from "vitest";
import { createCalcomAgenda } from "./agenda-calcom";

/**
 * Prova contra o Cal.com de verdade, a mão: cria a reserva 'TESTE Ozavo – pode cancelar' e a cancela em seguida.
 * Só roda quando as variáveis abaixo existem (no CI e no `pnpm test` normal ficam de fora). O tipo de evento
 * tem de ter o e-mail visível, \`empresa\` e \`title\` (veja o comentário de \`agenda-calcom.ts\`) e um e-mail de domínio
 * que recebe mensagem, que o Cal confere.
 *
 *   OZAVO_CAL_REAL_KEY=… OZAVO_CAL_REAL_EVENT_TYPE_ID=… OZAVO_CAL_REAL_EMAIL=… \
 *   OZAVO_CAL_REAL_FROM=2026-12-01T00:00:00Z OZAVO_CAL_REAL_TO=2026-12-05T00:00:00Z \
 *   pnpm exec vitest run agenda-calcom.real
 *
 * O horário é escolhido entre os livres que o próprio Cal devolve dentro da janela FROM–TO (no futuro). A janela
 * vem de fora porque o teste não lê o relógio da máquina.
 */
const key = process.env["OZAVO_CAL_REAL_KEY"];
const eventTypeId = Number(process.env["OZAVO_CAL_REAL_EVENT_TYPE_ID"]);
const email = process.env["OZAVO_CAL_REAL_EMAIL"];
const from = process.env["OZAVO_CAL_REAL_FROM"];
const to = process.env["OZAVO_CAL_REAL_TO"];
const enabled = Boolean(key && email && from && to && Number.isInteger(eventTypeId) && eventTypeId > 0);

describe.skipIf(!enabled)("Cal.com de verdade (manual)", () => {
  it("marca com nome, e-mail, empresa e processo, confere na reserva e cancela", async () => {
    const agenda = createCalcomAgenda({ apiKey: key ?? "", timezone: "America/Sao_Paulo", services: [{ name: "Teste", eventTypeId }] });
    const free = await agenda.freeSlots({ serviceType: "Teste", from: from ?? "", to: to ?? "", callId: "real-1" });
    const slot = free.slots[0];
    expect(slot).toBeDefined();

    const booked = await agenda.book({
      serviceType: "Teste",
      startsAt: slot?.startsAt ?? "",
      callId: "real-1",
      attendeeName: "TESTE Ozavo – pode cancelar",
      attendeeEmail: email ?? "",
      attendeePhone: "+5511988887777",
      company: "Empresa de Teste",
      process: "Processo de teste",
    });
    try {
      const response = await fetch(`https://api.cal.com/v2/bookings/${booked.id}`, { headers: { Authorization: `Bearer ${key}`, "cal-api-version": "2026-02-25" } });
      const body = (await response.json()) as { data: { attendees: Array<{ name: string; email: string; phoneNumber?: string }>; bookingFieldsResponses: Record<string, unknown> } };
      expect(body.data.attendees[0]).toMatchObject({ name: "TESTE Ozavo – pode cancelar", email, phoneNumber: "+5511988887777" });
      expect(body.data.bookingFieldsResponses).toMatchObject({ empresa: "Empresa de Teste", title: "Processo de teste" });
    } finally {
      await agenda.cancel?.({ appointmentId: booked.id, callId: "real-1" });
    }
  });
});
