import { decryptSecret, type OrgQuery } from "@ozavo/core";
import { z } from "zod";
import type { SafeFetchOptions } from "../net/safe-fetch";
import { readSetting } from "../settings";
import type { AgendaClient } from "./agenda";
import { createCalcomAgenda } from "./agenda-calcom";
import { createGoogleAgenda } from "./agenda-google";

/** A configuração da agenda da empresa, gravada pela tela de Integrações. */
export const AGENDA_CONNECTOR_KEY = "agenda.connector";

const service = z.object({ name: z.string().min(1).max(80) });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Como fica em `settings`: os segredos (`*Enc`) cifrados com `encryptSecret`. */
export const storedAgendaConnector = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("calcom"),
    apiKeyEnc: z.string().min(1),
    timezone: z.string().min(1),
    services: z.array(service.extend({ eventTypeId: z.number().int().positive() })).max(30),
  }),
  z.object({
    type: z.literal("google_calendar"),
    clientId: z.string().min(1),
    clientSecretEnc: z.string().min(1),
    // Ausente até a pessoa autorizar no Google: a agenda existe, mas ainda não liga.
    refreshTokenEnc: z.string().min(1).optional(),
    calendarId: z.string().min(1),
    timezone: z.string().min(1),
    workStart: time,
    workEnd: time,
    workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    slotMinutes: z.number().int().min(5).max(480),
    services: z.array(service.extend({ durationMinutes: z.number().int().min(5).max(480) })).max(30),
  }),
]);
export type StoredAgendaConnector = z.infer<typeof storedAgendaConnector>;

export async function readAgendaConnector(q: OrgQuery): Promise<StoredAgendaConnector | null> {
  const value = await readSetting(q, AGENDA_CONNECTOR_KEY);
  if (value === null) return null;
  const parsed = storedAgendaConnector.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A agenda gravada está pronta para uma ligação (no Google, já autorizada). */
export function agendaConnectorReady(stored: StoredAgendaConnector | null): boolean {
  return stored !== null && (stored.type === "calcom" || stored.refreshTokenEnc !== undefined);
}

/** O cliente da agenda desta empresa, ou `null` se ela não configurou nenhuma (ou falta autorizar). */
export async function agendaFromSettings(q: OrgQuery, secretKey: Buffer, net: SafeFetchOptions = {}): Promise<AgendaClient | null> {
  const stored = await readAgendaConnector(q);
  if (!stored || !agendaConnectorReady(stored)) return null;
  if (stored.type === "calcom") {
    return createCalcomAgenda({ apiKey: decryptSecret(stored.apiKeyEnc, secretKey), timezone: stored.timezone, services: stored.services }, net);
  }
  return createGoogleAgenda(
    {
      clientId: stored.clientId,
      clientSecret: decryptSecret(stored.clientSecretEnc, secretKey),
      refreshToken: decryptSecret(stored.refreshTokenEnc ?? "", secretKey),
      calendarId: stored.calendarId,
      timezone: stored.timezone,
      workStart: stored.workStart,
      workEnd: stored.workEnd,
      workDays: stored.workDays,
      slotMinutes: stored.slotMinutes,
      services: stored.services,
    },
    net,
  );
}
