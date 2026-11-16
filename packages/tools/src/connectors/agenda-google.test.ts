import { describe, expect, it } from "vitest";
import { createGoogleAgenda, freeSlotsFrom, googleConsentUrl, zonedInstant } from "./agenda-google";

const work = { timezone: "America/Sao_Paulo", workStart: "09:00", workEnd: "11:00", workDays: [1, 2, 3, 4, 5] };

describe("horários livres do Google Agenda", () => {
  it("converte a hora do expediente no fuso da agenda", () => {
    expect(zonedInstant(2026, 11, 18, 9 * 60, "America/Sao_Paulo").toISOString()).toBe("2026-11-18T12:00:00.000Z");
    expect(zonedInstant(2026, 7, 1, 9 * 60, "Europe/Lisbon").toISOString()).toBe("2026-07-01T08:00:00.000Z");
  });

  it("oferece o expediente menos o ocupado, só em dia de atendimento e dentro da janela", () => {
    // 2026-11-21 é sábado; 2026-11-20, sexta.
    const slots = freeSlotsFrom(work, new Date("2026-11-20T12:30:00Z"), new Date("2026-11-23T00:00:00Z"), 30, [{ start: new Date("2026-11-20T13:00:00Z"), end: new Date("2026-11-20T13:30:00Z") }]);
    expect(slots).toEqual([
      { startsAt: "2026-11-20T12:30:00.000Z", endsAt: "2026-11-20T13:00:00.000Z" },
      { startsAt: "2026-11-20T13:30:00.000Z", endsAt: "2026-11-20T14:00:00.000Z" },
    ]);
  });
});

describe("cliente do Google Agenda", () => {
  it("renova o acesso, consulta o ocupado e marca com a duração do atendimento", async () => {
    const seen: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
    const answers: unknown[] = [
      { access_token: "ya29.teste" },
      { calendars: { primary: { busy: [{ start: "2026-11-18T12:00:00Z", end: "2026-11-18T12:30:00Z" }] } } },
      { id: "ev1", start: { dateTime: "2026-11-18T12:30:00Z" }, end: { dateTime: "2026-11-18T13:30:00Z" } },
    ];
    const fetch = (async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      seen.push({ url, method: init.method, body: init.body, headers: init.headers });
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const agenda = createGoogleAgenda(
      { clientId: "cid", clientSecret: "csecret", refreshToken: "rt", calendarId: "primary", slotMinutes: 30, services: [{ name: "Avaliação", durationMinutes: 60 }], ...work },
      { fetch, lookup: async () => ["142.250.0.1"] },
    );
    const free = await agenda.freeSlots({ serviceType: "Consulta", from: "2026-11-18T12:00:00Z", to: "2026-11-18T14:00:00Z", callId: "c1" });
    expect(free.slots.map((slot) => slot.startsAt)).toEqual(["2026-11-18T12:30:00.000Z", "2026-11-18T13:00:00.000Z", "2026-11-18T13:30:00.000Z"]);
    expect(seen[0]).toMatchObject({ url: "https://oauth2.googleapis.com/token", method: "POST" });
    expect(new URLSearchParams(seen[0]?.body)).toEqual(new URLSearchParams({ client_id: "cid", client_secret: "csecret", refresh_token: "rt", grant_type: "refresh_token" }));
    expect(seen[1]).toMatchObject({ url: "https://www.googleapis.com/calendar/v3/freeBusy", headers: { Authorization: "Bearer ya29.teste" } });

    expect(await agenda.book({ serviceType: "avaliação", startsAt: "2026-11-18T12:30:00Z", callId: "c1", attendeePhone: "+5511988887777" })).toEqual({ id: "ev1", startsAt: "2026-11-18T12:30:00Z" });
    expect(seen[2]?.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(JSON.parse(seen[2]?.body ?? "{}")).toMatchObject({ summary: "avaliação — +5511988887777", end: { dateTime: "2026-11-18T13:30:00.000Z" } });
  });

  it("cancela apagando o evento e avisando os convidados; a resposta sem corpo é sucesso", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const answers: Array<{ status: number; body: string }> = [
      { status: 200, body: JSON.stringify({ access_token: "ya29.teste" }) },
      { status: 204, body: "" },
      { status: 404, body: JSON.stringify({ error: { code: 404 } }) },
    ];
    const fetch = (async (url: string, init: { method: string }) => {
      seen.push({ url, method: init.method });
      const answer = answers.shift() ?? { status: 500, body: "" };
      return new Response(answer.status === 204 ? null : answer.body, { status: answer.status });
    }) as unknown as typeof globalThis.fetch;
    const agenda = createGoogleAgenda(
      { clientId: "cid", clientSecret: "csecret", refreshToken: "rt", calendarId: "primary", slotMinutes: 30, services: [], ...work },
      { fetch, lookup: async () => ["142.250.0.1"] },
    );
    await agenda.cancel?.({ appointmentId: "ev 1", callId: "c1" });
    expect(seen[1]).toEqual({ url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/ev%201?sendUpdates=all", method: "DELETE" });
    await expect(agenda.cancel?.({ appointmentId: "sumiu", callId: "c1" })).rejects.toThrow(/404/);
  });

  it("pede o consentimento só com os escopos de eventos e ocupado/livre, e o token de renovação", () => {
    const url = new URL(googleConsentUrl({ clientId: "cid", redirectUri: "https://ozavo.example/api/v1/connectors/google/callback", state: "s" }));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("s");
  });
});
