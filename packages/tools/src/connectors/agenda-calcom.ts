import { z } from "zod";
import { safeFetch, type SafeFetchOptions } from "../net/safe-fetch";
import { AgendaBookingFieldProblem, type AgendaBookingField, type AgendaClient, type AgendaService, type BookRequest } from "./agenda";

/**
 * A agenda pelo Cal.com (API v2, autenticada por chave de API da conta).
 *
 * Conferido na documentação oficial em 2026-11-16:
 * - `GET /v2/slots?eventTypeId=&start=&end=&timeZone=&format=range`, header `cal-api-version: 2024-09-04`,
 *   devolve `{ status, data: { "<dia>": [{ start, end }] } }`
 *   (https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type).
 * - `POST /v2/bookings` com `{ start, eventTypeId, attendee: { name, email?, timeZone, language, phoneNumber? },
 *   bookingFieldsResponses? }`, header `cal-api-version: 2026-02-25`, devolve `201` com `data.uid` e `data.start`
 *   (https://cal.com/docs/api-reference/v2/bookings/create-a-booking). Medido na conta da ADS em 2026-11-25:
 *   - o e-mail só vale se o campo `email` do tipo de evento estiver visível; escondido, o Cal troca por
 *     `<telefone>@sms.cal.com` sem avisar;
 *   - os campos extras vão em `bookingFieldsResponses` pelo `slug` do campo de reserva: aqui `empresa` (campo de texto
 *     da conta) e `title` (o campo de sistema "sobre o que é a reunião", que a ADS rotulou "Qual processo você quer
 *     melhorar?"). Chave que o tipo de evento não tem é aceita e guardada sem aparecer na tela;
 *   - campo exigido que não veio dá `400`: `Missing required booking field response: <slug>` ou
 *     `responses - {<slug>}error_required_field`; e-mail inválido dá `responses - {email}email_validation_error`, e
 *     domínio que não recebe e-mail dá `email_domain_cannot_receive_mail`.
 * - `POST /v2/bookings/{uid}/reschedule` com `{ start }`, mesma versão, devolve a reserva nova em `data`
 *   (https://cal.com/docs/api-reference/v2/bookings/reschedule-a-booking).
 * - `POST /v2/bookings/{uid}/cancel` com `{ cancellationReason }`, mesma versão, devolve `200` com
 *   `{ status, data }` (https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking, conferido em 2026-11-16).
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
const cancelSchema = z.object({ status: z.string() });
const bookingSchema = z.object({ data: z.object({ uid: z.string().min(1), start: z.string().min(1) }) });

export class AgendaServiceUnknown extends Error {}

/** O slug do campo de reserva do Cal.com → o dado que o modelo pode perguntar. Slug que não está aqui não é dado que a ferramenta tenha. */
const FIELD_OF_SLUG: Record<string, AgendaBookingField> = { name: "name", email: "email", empresa: "company", company: "company", title: "process", processo: "process" };

/** Lê a recusa `400` do Cal.com e, se ela fala de um dado da pessoa, devolve o dado e se faltou ou veio inválido. */
export function bookingFieldProblemOf(body: string): AgendaBookingFieldProblem | undefined {
  if (/email_validation_error|email_domain_cannot_receive_mail|valid email/i.test(body)) return new AgendaBookingFieldProblem("email", "invalid");
  const slug = /Missing required booking field response: (\w+)/.exec(body)?.[1] ?? /responses - \{(\w+)\}error_required_field/.exec(body)?.[1];
  const field = slug === undefined ? undefined : FIELD_OF_SLUG[slug];
  return field === undefined ? undefined : new AgendaBookingFieldProblem(field, "missing");
}

/** Só os dados que a pessoa deu entram; o telefone da ligação e o fuso vêm do sistema. */
function bookingBody(request: BookRequest, timezone: string, eventTypeId: number): object {
  const attendee = {
    name: request.attendeeName ?? "Contato por telefone",
    timeZone: timezone,
    language: "pt",
    ...(request.attendeeEmail && { email: request.attendeeEmail }),
    ...(request.attendeePhone && { phoneNumber: request.attendeePhone }),
  };
  const fields = { ...(request.company && { empresa: request.company }), ...(request.process && { title: request.process }), ...(request.notes && { notes: request.notes }) };
  return { start: new Date(request.startsAt).toISOString(), eventTypeId, attendee, ...(Object.keys(fields).length > 0 && { bookingFieldsResponses: fields }) };
}

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
    if (response.status === 400 && method === "POST" && path === "/v2/bookings") {
      const problem = bookingFieldProblemOf(response.body);
      if (problem) throw problem;
    }
    if (!response.ok || response.truncated) throw new Error(`Cal.com answered HTTP ${response.status}${response.truncated ? " (truncated)" : ""}`);
    return JSON.parse(response.body) as unknown;
  };

  return {
    timezone: config.timezone,
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
      const parsed = bookingSchema.parse(await call("/v2/bookings", BOOKINGS_VERSION, "POST", bookingBody(request, config.timezone, eventTypeOf(request.serviceType))));
      return { id: parsed.data.uid, startsAt: parsed.data.start };
    },
    async reschedule(request) {
      const parsed = bookingSchema.parse(
        await call(`/v2/bookings/${encodeURIComponent(request.appointmentId)}/reschedule`, BOOKINGS_VERSION, "POST", { start: new Date(request.startsAt).toISOString(), reschedulingReason: "Remarcado por telefone" }),
      );
      return { id: parsed.data.uid, startsAt: parsed.data.start };
    },
    async cancel(request) {
      const parsed = cancelSchema.parse(await call(`/v2/bookings/${encodeURIComponent(request.appointmentId)}/cancel`, BOOKINGS_VERSION, "POST", { cancellationReason: "Desmarcado por telefone" }));
      if (parsed.status !== "success") throw new Error("Cal.com did not confirm the cancellation");
    },
  };
}
