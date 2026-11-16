import { z } from "zod";
import { safeFetch, type SafeFetchOptions } from "../net/safe-fetch";
import type { AgendaClient, AgendaService } from "./agenda";

/**
 * A agenda pelo Cal.com (API v2, autenticada por chave de API da conta).
 *
 * Conferido na documentação oficial em 2026-11-16:
 * - `GET /v2/slots?eventTypeId=&start=&end=&timeZone=&format=range`, header `cal-api-version: 2024-09-04`,
 *   devolve `{ status, data: { "<dia>": [{ start, end }] } }`
 *   (https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type).
 * - `POST /v2/bookings` com `{ start, eventTypeId, attendee: { name, timeZone, phoneNumber? } }`,
 *   header `cal-api-version: 2026-02-25`, devolve `201` com `data.uid` e `data.start`
 *   (https://cal.com/docs/api-reference/v2/bookings/create-a-booking). O e-mail do convidado é opcional.
 * - `POST /v2/bookings/{uid}/reschedule` com `{ start }`, mesma versão, devolve a reserva nova em `data`
 *   (https://cal.com/docs/api-reference/v2/bookings/reschedule-a-booking).
 */

export const CALCOM_API_URL = "https://api.cal.com";
const SLOTS_VERSION = "2024-09-04";
const BOOKINGS_VERSION = "2026-02-25";
const MAX_BYTES = 256 * 1024;

export interface CalcomConfig {
  apiKey: string;
  timezone: string;
  /** Tipo de atendimento (como o agente fala) → id do tipo de evento no Cal.com. */
  services: Array<{ name: string; eventTypeId: number }>;
  /** Endereço da API; só o teste troca. */
  baseUrl?: string;
}

const slotsSchema = z.object({ data: z.record(z.string(), z.array(z.object({ start: z.string(), end: z.string().optional() }))) });
const bookingSchema = z.object({ data: z.object({ uid: z.string().min(1), start: z.string().min(1) }) });

export class AgendaServiceUnknown extends Error {}

export function createCalcomAgenda(config: CalcomConfig, net: SafeFetchOptions = {}): AgendaClient {
  const base = config.baseUrl ?? CALCOM_API_URL;
  const eventTypeOf = (serviceType: string): number => {
    const wanted = serviceType.trim().toLocaleLowerCase("pt-BR");
    const service = config.services.find((candidate) => candidate.name.trim().toLocaleLowerCase("pt-BR") === wanted);
    if (service) return service.eventTypeId;
    if (/^\d+$/.test(serviceType.trim())) return Number(serviceType.trim());
    throw new AgendaServiceUnknown(`Unknown service type ${JSON.stringify(serviceType)}`);
  };
  const call = async (path: string, version: string, method: "GET" | "POST", body?: object): Promise<unknown> => {
    const response = await safeFetch(
      `${base}${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${config.apiKey}`, "cal-api-version": version, ...(body && { "Content-Type": "application/json" }) },
        body: body && JSON.stringify(body),
      },
      { ...net, maxBytes: MAX_BYTES },
    );
    if (!response.ok || response.truncated) throw new Error(`Cal.com answered HTTP ${response.status}${response.truncated ? " (truncated)" : ""}`);
    return JSON.parse(response.body) as unknown;
  };

  return {
    services: (): AgendaService[] => config.services.map((service) => ({ name: service.name })),
    async freeSlots(request) {
      const query = new URLSearchParams({ eventTypeId: String(eventTypeOf(request.serviceType)), start: request.from, end: request.to, timeZone: config.timezone, format: "range" });
      if (request.durationMinutes !== undefined) query.set("duration", String(request.durationMinutes));
      const parsed = slotsSchema.parse(await call(`/v2/slots?${query.toString()}`, SLOTS_VERSION, "GET"));
      const slots = Object.keys(parsed.data)
        .sort()
        .flatMap((day) => parsed.data[day] ?? [])
        .map((slot) => ({ startsAt: slot.start, endsAt: slot.end ?? slot.start }));
      return { timezone: config.timezone, slots };
    },
    async book(request) {
      const attendee = { name: request.attendeeName ?? "Contato por telefone", timeZone: config.timezone, language: "pt", ...(request.attendeePhone && { phoneNumber: request.attendeePhone }) };
      const parsed = bookingSchema.parse(await call("/v2/bookings", BOOKINGS_VERSION, "POST", { start: new Date(request.startsAt).toISOString(), eventTypeId: eventTypeOf(request.serviceType), attendee }));
      return { id: parsed.data.uid, startsAt: parsed.data.start };
    },
    async reschedule(request) {
      const parsed = bookingSchema.parse(
        await call(`/v2/bookings/${encodeURIComponent(request.appointmentId)}/reschedule`, BOOKINGS_VERSION, "POST", { start: new Date(request.startsAt).toISOString(), reschedulingReason: "Remarcado por telefone" }),
      );
      return { id: parsed.data.uid, startsAt: parsed.data.start };
    },
  };
}
