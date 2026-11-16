import { describe, expect, it } from "vitest";
import { createCalcomAgenda } from "./agenda-calcom";

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeCalcom(answers: Array<{ status: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof globalThis.fetch;
  return { seen, net: { fetch, lookup: async () => ["93.184.216.34"] } };
}

const config = { apiKey: "cal_live_teste", timezone: "America/Sao_Paulo", services: [{ name: "Consulta", eventTypeId: 42 }] };

describe("agenda pelo Cal.com", () => {
  it("consulta os horários do tipo de evento do atendimento, na versão de API documentada", async () => {
    const { seen, net } = fakeCalcom([
      { status: 200, body: { status: "success", data: { "2026-11-18": [{ start: "2026-11-18T09:00:00.000-03:00", end: "2026-11-18T09:30:00.000-03:00" }], "2026-11-17": [{ start: "2026-11-17T14:00:00.000-03:00", end: "2026-11-17T14:30:00.000-03:00" }] } } },
    ]);
    const agenda = createCalcomAgenda(config, net);
    const result = await agenda.freeSlots({ serviceType: "consulta", from: "2026-11-17T00:00:00.000Z", to: "2026-11-20T00:00:00.000Z", callId: "c1" });
    expect(result).toEqual({
      timezone: "America/Sao_Paulo",
      slots: [
        { startsAt: "2026-11-17T14:00:00.000-03:00", endsAt: "2026-11-17T14:30:00.000-03:00" },
        { startsAt: "2026-11-18T09:00:00.000-03:00", endsAt: "2026-11-18T09:30:00.000-03:00" },
      ],
    });
    const url = new URL(seen[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.cal.com/v2/slots");
    expect(Object.fromEntries(url.searchParams)).toEqual({ eventTypeId: "42", start: "2026-11-17T00:00:00.000Z", end: "2026-11-20T00:00:00.000Z", timeZone: "America/Sao_Paulo", format: "range" });
    expect(seen[0]?.headers).toMatchObject({ Authorization: "Bearer cal_live_teste", "cal-api-version": "2024-09-04" });
  });

  it("marca com o telefone da ligação e remarca pelo uid da reserva", async () => {
    const { seen, net } = fakeCalcom([
      { status: 201, body: { status: "success", data: { uid: "bk_1", start: "2026-11-18T12:00:00.000Z" } } },
      { status: 201, body: { status: "success", data: { uid: "bk_2", start: "2026-11-19T12:00:00.000Z" } } },
    ]);
    const agenda = createCalcomAgenda(config, net);
    expect(await agenda.book({ serviceType: "Consulta", startsAt: "2026-11-18T09:00:00-03:00", callId: "c1", attendeePhone: "+5511988887777" })).toEqual({ id: "bk_1", startsAt: "2026-11-18T12:00:00.000Z" });
    expect(seen[0]).toMatchObject({
      url: "https://api.cal.com/v2/bookings",
      method: "POST",
      headers: { "cal-api-version": "2026-02-25" },
      body: { start: "2026-11-18T12:00:00.000Z", eventTypeId: 42, attendee: { name: "Contato por telefone", timeZone: "America/Sao_Paulo", language: "pt", phoneNumber: "+5511988887777" } },
    });
    expect(await agenda.reschedule({ appointmentId: "bk_1", startsAt: "2026-11-19T09:00:00-03:00", callId: "c1" })).toEqual({ id: "bk_2", startsAt: "2026-11-19T12:00:00.000Z" });
    expect(seen[1]).toMatchObject({ url: "https://api.cal.com/v2/bookings/bk_1/reschedule", body: { start: "2026-11-19T12:00:00.000Z" } });
  });

  it("cancela pelo uid da reserva, na versão de API documentada, e recusa resposta sem sucesso", async () => {
    const { seen, net } = fakeCalcom([
      { status: 200, body: { status: "success", data: { uid: "bk_1", status: "cancelled" } } },
      { status: 200, body: { status: "error", data: {} } },
    ]);
    const agenda = createCalcomAgenda(config, net);
    await agenda.cancel?.({ appointmentId: "bk_1", callId: "c1" });
    expect(seen[0]).toMatchObject({ url: "https://api.cal.com/v2/bookings/bk_1/cancel", method: "POST", headers: { "cal-api-version": "2026-02-25" }, body: { cancellationReason: "Desmarcado por telefone" } });
    await expect(agenda.cancel?.({ appointmentId: "bk_2", callId: "c1" })).rejects.toThrow(/did not confirm/);
  });

  it("erro do Cal.com e tipo de atendimento desconhecido viram falha, para a ferramenta falar que não deu", async () => {
    const { net } = fakeCalcom([{ status: 401, body: { status: "error" } }]);
    const agenda = createCalcomAgenda(config, net);
    await expect(agenda.freeSlots({ serviceType: "Consulta", from: "2026-11-17T00:00:00Z", to: "2026-11-18T00:00:00Z", callId: "c1" })).rejects.toThrow(/401/);
    await expect(agenda.freeSlots({ serviceType: "Exame", from: "2026-11-17T00:00:00Z", to: "2026-11-18T00:00:00Z", callId: "c1" })).rejects.toThrow(/Unknown service/);
  });
});
