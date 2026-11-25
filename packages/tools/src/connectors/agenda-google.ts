import { createSign } from "node:crypto";
import { systemClock, type Clock } from "@ozavo/core";
import { z } from "zod";
import { safeFetch, type SafeFetchOptions } from "../net/safe-fetch";
import type { AgendaClient, AgendaService, AgendaSlot } from "./agenda";

/**
 * A agenda pelo Google Agenda, por um de dois acessos: o consentimento OAuth de quem administra a
 * empresa (o token de renovação fica cifrado em `agenda.connector`), ou uma conta de serviço do Google
 * Cloud, cuja chave privada fica cifrada no mesmo lugar e com quem a agenda foi compartilhada. O Google não tem "horário livre" pronto: os horários
 * saem do expediente configurado na tela menos os períodos ocupados que o `freeBusy` devolve.
 *
 * Endpoints públicos da Calendar API v3 e do OAuth 2.0 do Google:
 * - `POST https://oauth2.googleapis.com/token` (troca do código e renovação do token);
 * - `POST https://www.googleapis.com/calendar/v3/freeBusy` com `{ timeMin, timeMax, items: [{ id }] }`;
 * - `POST /calendar/v3/calendars/{id}/events`, `GET` e `PATCH /calendar/v3/calendars/{id}/events/{eventId}`;
 * - `DELETE /calendar/v3/calendars/{id}/events/{eventId}?sendUpdates=all`, resposta sem corpo
 *   (https://developers.google.com/workspace/calendar/api/v3/reference/events/delete, conferido em 2026-11-16).
 * - Conta de serviço: `POST https://oauth2.googleapis.com/token` com
 *   `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` e `assertion`, um JWT RS256 assinado com a
 *   chave da conta (`iss` = e-mail da conta, `scope`, `aud` = o endereço do token, `iat`, `exp` até 1 h),
 *   como descreve https://developers.google.com/identity/protocols/oauth2/service-account (seção
 *   "Preparing to make an authorized API call", HTTP/REST). Não conferido contra o servidor real em
 *   2026-11-16: os testes usam um servidor falso que confere a assinatura com a chave pública.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_URL = "https://www.googleapis.com/calendar/v3";
/** Só criar e mexer em eventos e ler ocupado/livre: nada de ler o conteúdo dos outros eventos. */
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];

const MAX_BYTES = 256 * 1024;
const MAX_DAYS = 31;
const MAX_SLOTS = 60;

/** Acesso por OAuth (token de renovação de quem autorizou) ou por conta de serviço. */
export type GoogleAgendaAuth =
  | { clientId: string; clientSecret: string; refreshToken: string }
  | { serviceAccount: GoogleServiceAccount; clock?: Clock };

export interface GoogleServiceAccount {
  clientEmail: string;
  /** A chave privada em PEM, como vem no arquivo JSON da conta. */
  privateKey: string;
}

export type GoogleAgendaConfig = GoogleAgendaAuth & GoogleAgendaSchedule;

export interface GoogleAgendaSchedule {
  calendarId: string;
  timezone: string;
  /** Expediente, em `HH:MM` no fuso da agenda, e dias da semana (0 = domingo). */
  workStart: string;
  workEnd: string;
  workDays: number[];
  /** Duração padrão de um atendimento, em minutos. */
  slotMinutes: number;
  /** Tipos de atendimento com duração própria. Sem lista, qualquer nome vale com a duração padrão. */
  services: Array<{ name: string; durationMinutes: number }>;
  /** Endereços; só o teste troca. */
  urls?: { token?: string; calendar?: string };
}

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/**
 * O JWT que a conta de serviço troca por um token de acesso. `aud` é sempre o endereço oficial do
 * token, mesmo quando o teste aponta o pedido para outro lugar: é o valor que o Google confere.
 */
export function serviceAccountAssertion(account: GoogleServiceAccount, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: account.clientEmail, scope: GOOGLE_SCOPES.join(" "), aud: GOOGLE_TOKEN_URL, iat: issuedAt, exp: issuedAt + 3600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** O arquivo JSON que o Google Cloud entrega ao criar a chave de uma conta de serviço. */
export const serviceAccountKeyFile = z.object({
  type: z.literal("service_account"),
  client_email: z.string().email(),
  private_key: z.string().includes("PRIVATE KEY"),
});

const tokenSchema = z.object({ access_token: z.string().min(1) });
const busySchema = z.object({ calendars: z.record(z.string(), z.object({ busy: z.array(z.object({ start: z.string(), end: z.string() })).default([]) })) });
const eventSchema = z.object({ id: z.string().min(1), start: z.object({ dateTime: z.string() }), end: z.object({ dateTime: z.string() }) });

const minutesOf = (time: string): number => {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
};

/** Ano, mês, dia, minutos do dia e dia da semana de um instante, no fuso dado. */
export function zonedParts(at: Date, timeZone: string): { year: number; month: number; day: number; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "0";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), minutes: Number(get("hour")) * 60 + Number(get("minute")), weekday };
}

/** O instante em que o relógio do fuso marca `minutes` no dia `year-month-day`. */
export function zonedInstant(year: number, month: number, day: number, minutes: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = wanted;
  // Duas passadas acertam a diferença do fuso, inclusive perto da troca de horário de verão.
  for (let pass = 0; pass < 2; pass++) {
    const seen = zonedParts(new Date(guess), timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, 0, seen.minutes);
    guess += wanted - seenUtc;
  }
  return new Date(guess);
}

/** Os horários do expediente em `[from, to)` que não encostam em nenhum período ocupado. */
export function freeSlotsFrom(config: Pick<GoogleAgendaConfig, "timezone" | "workStart" | "workEnd" | "workDays">, from: Date, to: Date, durationMinutes: number, busy: Array<{ start: Date; end: Date }>): AgendaSlot[] {
  const slots: AgendaSlot[] = [];
  const first = zonedParts(from, config.timezone);
  const start = minutesOf(config.workStart);
  const end = minutesOf(config.workEnd);
  for (let offset = 0; offset < MAX_DAYS && slots.length < MAX_SLOTS; offset++) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (zonedInstant(year, month, day, 0, config.timezone).getTime() >= to.getTime()) break;
    if (!config.workDays.includes(date.getUTCDay())) continue;
    for (let minute = start; minute + durationMinutes <= end && slots.length < MAX_SLOTS; minute += durationMinutes) {
      const slotStart = zonedInstant(year, month, day, minute, config.timezone);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
      if (slotStart.getTime() < from.getTime() || slotEnd.getTime() > to.getTime()) continue;
      if (busy.some((period) => period.start.getTime() < slotEnd.getTime() && period.end.getTime() > slotStart.getTime())) continue;
      slots.push({ startsAt: slotStart.toISOString(), endsAt: slotEnd.toISOString() });
    }
  }
  return slots;
}

export function createGoogleAgenda(config: GoogleAgendaConfig, net: SafeFetchOptions = {}): AgendaClient {
  const calendarBase = config.urls?.calendar ?? GOOGLE_CALENDAR_URL;
  let accessToken: string | undefined;

  const request = async (url: string, method: string, body?: string, contentType = "application/json"): Promise<unknown> => {
    const response = await safeFetch(url, { method, headers: { ...(accessToken && { Authorization: `Bearer ${accessToken}` }), ...(body && { "Content-Type": contentType }) }, body }, { ...net, maxBytes: MAX_BYTES });
    if (!response.ok || response.truncated) throw new Error(`Google answered HTTP ${response.status}${response.truncated ? " (truncated)" : ""}`);
    // O DELETE do Google responde sem corpo.
    return response.body.trim() === "" ? null : (JSON.parse(response.body) as unknown);
  };
  const authorized = async (): Promise<void> => {
    if (accessToken) return;
    const form =
      "serviceAccount" in config
        ? new URLSearchParams({ grant_type: JWT_BEARER, assertion: serviceAccountAssertion(config.serviceAccount, (config.clock ?? systemClock).now()) })
        : new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: "refresh_token" });
    accessToken = tokenSchema.parse(await request(config.urls?.token ?? GOOGLE_TOKEN_URL, "POST", form.toString(), "application/x-www-form-urlencoded")).access_token;
  };
  const durationOf = (serviceType: string, override?: number): number => {
    if (override !== undefined) return override;
    const wanted = serviceType.trim().toLocaleLowerCase("pt-BR");
    return config.services.find((service) => service.name.trim().toLocaleLowerCase("pt-BR") === wanted)?.durationMinutes ?? config.slotMinutes;
  };
  const events = `${calendarBase}/calendars/${encodeURIComponent(config.calendarId)}/events`;

  return {
    timezone: config.timezone,
    services: (): AgendaService[] => config.services.map((service) => ({ name: service.name })),
    async freeSlots(input) {
      await authorized();
      const parsed = busySchema.parse(await request(`${calendarBase}/freeBusy`, "POST", JSON.stringify({ timeMin: input.from, timeMax: input.to, timeZone: config.timezone, items: [{ id: config.calendarId }] })));
      const busy = Object.values(parsed.calendars).flatMap((calendar) => calendar.busy.map((period) => ({ start: new Date(period.start), end: new Date(period.end) })));
      return { timezone: config.timezone, slots: freeSlotsFrom(config, new Date(input.from), new Date(input.to), durationOf(input.serviceType, input.durationMinutes), busy) };
    },
    async book(input) {
      await authorized();
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(startsAt.getTime() + durationOf(input.serviceType) * 60_000);
      const who = [input.attendeeName, input.attendeePhone].filter(Boolean).join(" · ");
      const body = {
        summary: who ? `${input.serviceType} — ${who}` : input.serviceType,
        description: [
          `Marcado por telefone pelo agente do Ozavo (ligação ${input.callId}).`,
          input.attendeeEmail && `E-mail: ${input.attendeeEmail}`,
          input.company && `Empresa: ${input.company}`,
          input.process && `Processo a melhorar: ${input.process}`,
          input.notes && `Observações: ${input.notes}`,
        ]
          .filter(Boolean)
          .join("\n"),
        start: { dateTime: startsAt.toISOString(), timeZone: config.timezone },
        end: { dateTime: endsAt.toISOString(), timeZone: config.timezone },
      };
      const event = eventSchema.parse(await request(events, "POST", JSON.stringify(body)));
      return { id: event.id, startsAt: event.start.dateTime };
    },
    async reschedule(input) {
      await authorized();
      const url = `${events}/${encodeURIComponent(input.appointmentId)}`;
      // A duração é a do compromisso marcado: remarcar não muda o tipo de atendimento.
      const current = eventSchema.parse(await request(url, "GET"));
      const duration = new Date(current.end.dateTime).getTime() - new Date(current.start.dateTime).getTime();
      const startsAt = new Date(input.startsAt);
      const body = { start: { dateTime: startsAt.toISOString(), timeZone: config.timezone }, end: { dateTime: new Date(startsAt.getTime() + duration).toISOString(), timeZone: config.timezone } };
      const event = eventSchema.parse(await request(url, "PATCH", JSON.stringify(body)));
      return { id: event.id, startsAt: event.start.dateTime };
    },
    async cancel(input) {
      await authorized();
      await request(`${events}/${encodeURIComponent(input.appointmentId)}?sendUpdates=all`, "DELETE");
    },
  };
}

/** O endereço de consentimento do Google para esta empresa. `state` volta no retorno, assinado. */
export function googleConsentUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const query = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // `offline` + `consent`: o Google só entrega o token de renovação assim.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  return `${GOOGLE_AUTH_URL}?${query.toString()}`;
}

const exchangeSchema = z.object({ refresh_token: z.string().min(1) });

/** Troca o código do retorno pelo token de renovação. Sem token de renovação, é erro. */
export async function exchangeGoogleCode(input: { clientId: string; clientSecret: string; code: string; redirectUri: string }, net: SafeFetchOptions & { tokenUrl?: string } = {}): Promise<string> {
  const form = new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri, grant_type: "authorization_code" });
  const response = await safeFetch(net.tokenUrl ?? GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, net);
  if (!response.ok) throw new Error(`Google refused the authorization code (HTTP ${response.status})`);
  return exchangeSchema.parse(JSON.parse(response.body)).refresh_token;
}
