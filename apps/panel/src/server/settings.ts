import { createPrivateKey } from "node:crypto";
import {
  DEFAULT_INBOUND_LIMIT,
  DEFAULT_VOICEMAIL_MAX_SECONDS,
  INBOUND_LIMIT_SETTING,
  PLAN_ALERT_WEBHOOK_SETTING,
  PLAN_ALERT_WHATSAPP_SETTING,
  DEFAULT_VOICEMAIL_LANGUAGE,
  VOICEMAIL_ENABLED_SETTING,
  VOICEMAIL_LANGUAGE_SETTING,
  VOICEMAIL_MAX_SECONDS_SETTING,
  encryptSecret,
  inboundLimitSchema,
  voicemailLanguageSchema,
  voicemailMaxSecondsSchema,
} from "@ozavo/core";
import { z, type ZodType } from "zod";
import type { VoiceEngine } from "@ozavo/voice-engine";
import { ANALYSIS_SETTING, AUTO_TRANSCRIPTION_SETTING, OUTCOME_SETTING, TRANSCRIPTION_SETTING, classifyBaseUrlOf, classifyModelOf, engineClassifyTargetSetting, storedClassifyTargetOf } from "@ozavo/voice-engine/types";
import { AGENDA_CONNECTOR_KEY, serviceAccountKeyFile, storedAgendaConnector } from "@ozavo/tools/agenda";
import { ApiError } from "./context";
import { engineKeySetting, listEngines } from "./pieces";

/**
 * Uma configuração conhecida. `store` devolve o que vai para o banco (segredos já cifrados) e
 * `view` o que a API devolve: de um segredo, só `{ configured: true }`, nunca o valor.
 */
interface SettingDefinition<T> {
  schema: ZodType<T>;
  secret: boolean;
  store(value: T, key: Buffer, previous: unknown): unknown;
  view(stored: unknown): unknown;
}

export interface Setting {
  secret: boolean;
  /** O que vale sem nada gravado, quando a tela precisa mostrar o valor em vigor. */
  fallback?: unknown;
  /** Valida a entrada (lança `ZodError`) e devolve o que gravar. */
  store(input: unknown, key: Buffer, previous: unknown): unknown;
  view(stored: unknown): unknown;
  /** Recusa (lançando `ApiError`) trocar ou apagar o valor gravado por esta rota. */
  guard?(previous: unknown): void;
  /** A chave de um motor: ao gravar, ela é testada, e o teste da chave anterior deixa de valer. */
  engine?: VoiceEngine;
}

const setting = <T>(definition: SettingDefinition<T>): Setting => ({
  secret: definition.secret,
  store: (input, key, previous) => definition.store(definition.schema.parse(input), key, previous),
  view: definition.view,
});

const CONFIGURED = { configured: true };
const plain = <T>(schema: ZodType<T>): Setting => setting({ schema, secret: false, store: (value) => value, view: (stored) => stored });
const secretText = setting<string>({
  schema: z.string().trim().min(1).max(500),
  secret: true,
  store: (value, key) => encryptSecret(value, key),
  view: () => CONFIGURED,
});

/** O destino da classificação como a tela o vê: da chave, só se existe. */
export function classifyTargetView(stored: unknown): { baseUrl: string | null; model: string | null; apiKey: { configured: boolean } } {
  const target = storedClassifyTargetOf(stored);
  return { baseUrl: classifyBaseUrlOf(target.baseUrl) ?? null, model: classifyModelOf(target.model) ?? null, apiKey: { configured: target.apiKey !== undefined } };
}

const httpUrl = z.url({ protocol: /^https?$/ });
const storedConnector = z.object({ type: z.string(), url: z.string(), token: z.string() });
const storedHooks = z.array(z.object({ name: z.string(), url: z.string(), token: z.string().optional() }));

// O destino da classificação: `https` e host público (o processo de rotinas alcança a rede interna),
// gravado sem a barra final, porque o caminho do provedor é colado depois. O modelo é o nome que o
// provedor publica. A mesma regra vale na leitura da rotina: endpoint gravado por fora do painel
// que não passe aqui não recebe pedido nenhum, e modelo que não passe fica no padrão do motor.
const classifyBaseUrlSchema = z
  .string()
  .max(500)
  .transform((value) => value.trim())
  .refine((value) => classifyBaseUrlOf(value) !== undefined, "must be a public https URL with no credentials")
  .transform((value) => value.replace(/\/+$/, ""));
const classifyModelSchema = z
  .string()
  .max(200)
  .transform((value) => value.trim())
  .refine((value) => classifyModelOf(value) !== undefined, "model names take letters, digits and . _ : / -");

// Endpoint, modelo e a chave do endpoint juntos, com a regra do conector abaixo: a chave foi dada
// a um endereço, então chave em branco só mantém a gravada se o endpoint for o mesmo; endpoint novo
// pede a chave de novo. A chave do motor nunca serve aqui. Sem endpoint não há chave: só o modelo,
// e a classificação segue no endereço oficial do motor, com a chave do motor — mas só com modelo que
// o motor saiba precificar (`classifyPricing`): quem cobra é ele, e custo sem preço não é medido.
// Com endpoint, o modelo é o que o dono quiser: quem cobra é o provedor do endpoint.
// A configuração é por motor, por isso a função: o preço de cada modelo é do motor.
const classifyTargetOf = (engine: VoiceEngine): Setting =>
  setting<{ baseUrl?: string; model?: string; apiKey?: string }>({
    schema: z.object({ baseUrl: classifyBaseUrlSchema.optional(), model: classifyModelSchema.optional(), apiKey: z.string().trim().min(1).max(500).optional() }),
    secret: true,
    store(value, key, previous) {
      if (value.baseUrl === undefined) {
        if (value.apiKey !== undefined) throw new ApiError(400, "endpoint_required", "The classification key belongs to an endpoint: enter the endpoint too.");
        // Sem endpoint, o pedido vai ao provedor do próprio motor, que cobra por ele: modelo que o
        // motor não sabe precificar seria cobrado com o custo "não medido". Com endpoint, o preço é
        // do provedor do endpoint e o modelo passa.
        if (value.model !== undefined && engine.classifyPricing?.(value.model) === undefined)
          throw new ApiError(
            400,
            "classify_model_unmeasured",
            "Without an endpoint the classification goes to the engine's own provider, which charges for it, and the project does not know this model's price: enter the endpoint, or leave the model empty to use the engine's priced model.",
          );
        return value.model === undefined ? {} : { model: value.model };
      }
      const kept = storedClassifyTargetOf(previous);
      const apiKey = value.apiKey ? encryptSecret(value.apiKey, key) : kept.baseUrl === value.baseUrl ? kept.apiKey : undefined;
      if (apiKey === undefined) throw new ApiError(400, "endpoint_key_required", "When the classification endpoint changes, enter its key again.");
      return { baseUrl: value.baseUrl, ...(value.model !== undefined && { model: value.model }), apiKey };
    },
    view: classifyTargetView,
  });

// Token em branco numa alteração mantém o que já estava gravado: a tela nunca recebe o valor
// para devolver, então "não mexi" precisa ser representável. Mas só para o MESMO destino: o token
// foi dado a um endereço, e mantê-lo ao trocar a URL o entregaria a quem responde no endereço novo.
// O tipo `waha` (número conectado por QR Code) não se grava nem se apaga por aqui: ele entra ao
// conectar e sai ao desconectar, em Configurações > WhatsApp. Trocar o conector por baixo deixaria
// um número pareado e sem uso, e a tela dizendo "conectado" enquanto o envio sai por outro lugar.
const isWaha = (stored: unknown): boolean => z.object({ type: z.literal("waha") }).safeParse(stored).success;
const connector: Setting = {
  guard(previous) {
    if (isWaha(previous)) throw new ApiError(409, "whatsapp_connected", "A WhatsApp number is connected by QR code: disconnect it before saving another connector.");
  },
  ...setting<{ type: "deskcomm" | "webhook"; url: string; token?: string }>({
  schema: z.object({ type: z.enum(["deskcomm", "webhook"]), url: httpUrl, token: z.string().trim().min(1).max(500).optional() }),
  secret: true,
  store(value, key, previous) {
    const kept = storedConnector.safeParse(previous);
    const sameDestination = kept.success && kept.data.type === value.type && kept.data.url === value.url;
    const token = value.token ? encryptSecret(value.token, key) : sameDestination ? kept.data.token : undefined;
    if (token === undefined) throw new ApiError(400, "token_required", "When the connector address or type changes, enter the token again.");
    return { type: value.type, url: value.url, token };
  },
  view(stored) {
    if (isWaha(stored)) return { type: "waha" };
    const parsed = z.object({ type: z.string(), url: z.string() }).safeParse(stored);
    return parsed.success ? { type: parsed.data.type, url: parsed.data.url, token: CONFIGURED } : null;
  },
  }),
};

const webhooks = setting<Array<{ name: string; url: string; token?: string }>>({
  schema: z
    .array(z.object({ name: z.string().trim().min(1).max(60), url: httpUrl, token: z.string().trim().min(1).max(500).optional() }))
    .max(50)
    .refine((hooks) => new Set(hooks.map((hook) => hook.name)).size === hooks.length, "webhook names must be unique"),
  secret: true,
  store(value, key, previous) {
    const kept = storedHooks.safeParse(previous);
    // Por item, com nome E endereço iguais. Endereço novo (ou item renomeado) sem token fica sem
    // token: é opcional aqui, e o antigo nunca é copiado para outro destino.
    const before = kept.success ? kept.data : [];
    return value.map((hook) => {
      const token = hook.token ? encryptSecret(hook.token, key) : before.find((old) => old.name === hook.name && old.url === hook.url)?.token;
      return { name: hook.name, url: hook.url, ...(token !== undefined && { token }) };
    });
  },
  view(stored) {
    const parsed = storedHooks.safeParse(stored);
    return (parsed.success ? parsed.data : []).map((hook) => ({ name: hook.name, url: hook.url, token: { configured: hook.token !== undefined } }));
  },
});

const timeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "unknown time zone");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const serviceName = z.string().trim().min(1).max(80);

// A agenda da empresa: Cal.com por chave de API, ou Google Agenda por OAuth ou por conta de serviço. Como no conector, o
// segredo em branco mantém o gravado só para o MESMO destino (a mesma conta do Cal.com, o mesmo
// cliente OAuth do Google); o token de renovação do Google só vem pela autorização, nunca da tela.
const agendaConnector = setting<
  | { type: "calcom"; apiKey?: string; timezone: string; services: Array<{ name: string; eventTypeId: number }> }
  | {
      type: "google_calendar";
      clientId: string;
      clientSecret?: string;
      calendarId: string;
      timezone: string;
      workStart: string;
      workEnd: string;
      workDays: number[];
      slotMinutes: number;
      services: Array<{ name: string; durationMinutes: number }>;
    }
  | {
      type: "google_service_account";
      /** O arquivo JSON da chave da conta, colado inteiro. Em branco mantém a chave gravada, se a conta é a mesma. */
      keyFile?: string;
      clientEmail?: string;
      calendarId: string;
      timezone: string;
      workStart: string;
      workEnd: string;
      workDays: number[];
      slotMinutes: number;
      services: Array<{ name: string; durationMinutes: number }>;
    }
>({
  schema: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("calcom"),
      apiKey: z.string().trim().min(1).max(500).optional(),
      timezone: timeZone,
      services: z.array(z.object({ name: serviceName, eventTypeId: z.number().int().positive() })).min(1).max(30),
    }),
    z.object({
      type: z.literal("google_calendar"),
      clientId: z.string().trim().min(1).max(300),
      clientSecret: z.string().trim().min(1).max(500).optional(),
      calendarId: z.string().trim().min(1).max(300),
      timezone: timeZone,
      workStart: hhmm,
      workEnd: hhmm,
      workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      slotMinutes: z.number().int().min(5).max(480),
      services: z.array(z.object({ name: serviceName, durationMinutes: z.number().int().min(5).max(480) })).max(30),
    }),
    z.object({
      type: z.literal("google_service_account"),
      keyFile: z.string().trim().min(1).max(10_000).optional(),
      clientEmail: z.string().trim().email().optional(),
      calendarId: z.string().trim().min(1).max(300),
      timezone: timeZone,
      workStart: hhmm,
      workEnd: hhmm,
      workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      slotMinutes: z.number().int().min(5).max(480),
      services: z.array(z.object({ name: serviceName, durationMinutes: z.number().int().min(5).max(480) })).max(30),
    }),
  ]),
  secret: true,
  store(value, key, previous) {
    const kept = storedAgendaConnector.safeParse(previous);
    if (value.type === "calcom") {
      const apiKeyEnc = value.apiKey ? encryptSecret(value.apiKey, key) : kept.success && kept.data.type === "calcom" ? kept.data.apiKeyEnc : undefined;
      if (apiKeyEnc === undefined) throw new ApiError(400, "token_required", "Enter the Cal.com API key.");
      return { type: "calcom", apiKeyEnc, timezone: value.timezone, services: value.services };
    }
    if (value.workStart >= value.workEnd) throw new ApiError(400, "validation_error", "workEnd: the working day must end after it starts.");
    if (value.type === "google_service_account") {
      const { keyFile, clientEmail: _email, ...schedule } = value;
      if (keyFile !== undefined) {
        const account = readServiceAccountFile(keyFile);
        return { ...schedule, clientEmail: account.client_email, privateKeyEnc: encryptSecret(account.private_key, key) };
      }
      // Sem arquivo novo, vale a chave gravada, se a tela ainda fala da mesma conta.
      const same = kept.success && kept.data.type === "google_service_account" && kept.data.clientEmail === value.clientEmail ? kept.data : undefined;
      if (!same) throw new ApiError(400, "token_required", "Paste the service account key file (JSON).");
      return { ...schedule, clientEmail: same.clientEmail, privateKeyEnc: same.privateKeyEnc };
    }
    const sameClient = kept.success && kept.data.type === "google_calendar" && kept.data.clientId === value.clientId ? kept.data : undefined;
    const clientSecretEnc = value.clientSecret ? encryptSecret(value.clientSecret, key) : sameClient?.clientSecretEnc;
    if (clientSecretEnc === undefined) throw new ApiError(400, "token_required", "When the OAuth client changes, enter its secret again.");
    // A autorização vale para o cliente OAuth que a pediu: outro cliente pede autorizar de novo.
    const refreshTokenEnc = value.clientSecret === undefined ? sameClient?.refreshTokenEnc : undefined;
    const { clientSecret: _secret, ...rest } = value;
    return { ...rest, clientSecretEnc, ...(refreshTokenEnc !== undefined && { refreshTokenEnc }) };
  },
  view(stored) {
    const parsed = storedAgendaConnector.safeParse(stored);
    if (!parsed.success) return null;
    if (parsed.data.type === "calcom") {
      const { apiKeyEnc: _key, ...rest } = parsed.data;
      return { ...rest, apiKey: CONFIGURED };
    }
    if (parsed.data.type === "google_service_account") {
      const { privateKeyEnc: _key, ...rest } = parsed.data;
      return { ...rest, keyFile: CONFIGURED };
    }
    const { clientSecretEnc: _secret, refreshTokenEnc, ...rest } = parsed.data;
    return { ...rest, clientSecret: CONFIGURED, authorized: refreshTokenEnc !== undefined };
  },
});

/** O arquivo de chave da conta de serviço. A mensagem de erro nunca repete o que foi colado. */
function readServiceAccountFile(text: string): { client_email: string; private_key: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "validation_error", "keyFile: paste the whole JSON file of the service account key.");
  }
  const parsed = serviceAccountKeyFile.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "validation_error", "keyFile: this is not a service account key file (type service_account, client_email, private_key).");
  try {
    createPrivateKey(parsed.data.private_key);
  } catch {
    throw new ApiError(400, "validation_error", "keyFile: the private key in the file is not readable.");
  }
  return parsed.data;
}

/** A definição da chave, ou `undefined` se a chave não for conhecida. Não existe configuração livre. */
export async function settingDefinition(key: string): Promise<Setting | undefined> {
  const engines = await listEngines();
  const definitions: Record<string, Setting> = {
    "engine.default": plain(z.string().refine((id) => engines.some((engine) => engine.id === id), "unknown voice engine")),
    "whatsapp.connector": connector,
    // Ausente vale `false`: o envio para quem ligou pede confirmação humana (o número exibido é forjável).
    "whatsapp.trust_caller_id": plain(z.boolean()),
    // Ausente vale `false`: o aviso de fim de ligação pelo WhatsApp nasce desligado.
    "whatsapp.notify_owner_on_call_end": plain(z.boolean()),
    "webhooks.allowed": webhooks,
    // O aviso de franquia (80% e 100%) também pelo WhatsApp do dono e por um webhook cadastrado.
    // Ausentes: só o aviso no painel.
    [PLAN_ALERT_WHATSAPP_SETTING]: { ...plain(z.boolean()), fallback: false },
    [PLAN_ALERT_WEBHOOK_SETTING]: plain(z.string().trim().min(1).max(100)),
    // A agenda que as ferramentas de agenda usam. Ausente: elas não são oferecidas na ligação.
    [AGENDA_CONNECTOR_KEY]: agendaConnector,
    // O que vale quando ninguém responde a um pedido de aprovação. Ausente vale `denied`: é escolha
    // do operador, não do modelo de IA.
    "approvals.default_on_timeout": plain(z.enum(["denied", "approved"])),
    "recording_notice.text": plain(z.string().trim().min(1).max(500)),
    // Classificar o desfecho de cada ligação com o motor do agente. Ausente vale desligado: é uma
    // chamada paga ao provedor por ligação, e o dono decide.
    [OUTCOME_SETTING]: { ...plain(z.boolean()), fallback: false },
    // Analisar cada ligação no fim (nota pela régua, temperatura, objeções). Ausente vale desligado:
    // a análise vem na mesma chamada paga do desfecho, mais longa, e o dono decide.
    [ANALYSIS_SETTING]: { ...plain(z.boolean()), fallback: false },
    // Transcrever a gravação de uma chamada sem texto, a pedido. Ausente vale desligado: o áudio
    // gravado vai ao provedor do motor, e cada transcrição é paga.
    [TRANSCRIPTION_SETTING]: { ...plain(z.boolean()), fallback: false },
    // Transcrever sozinho, no fim, toda chamada que terminou sem fala. Ausente vale desligado: cada
    // uma é um pedido pago ao provedor, sem ninguém pedir. Só age com a transcrição acima ligada.
    [AUTO_TRANSCRIPTION_SETTING]: { ...plain(z.boolean()), fallback: false },
    "network.public_ip": plain(z.ipv4()),
    // Ligações recebidas pela operadora ao mesmo tempo. Ausente vale o teto de fábrica.
    [INBOUND_LIMIT_SETTING]: { ...plain(inboundLimitSchema), fallback: DEFAULT_INBOUND_LIMIT },
    // Caixa postal: desligada de fábrica, o teto do recado em segundos e o idioma do aviso gravado.
    // Ausentes valem os de fábrica.
    [VOICEMAIL_ENABLED_SETTING]: { ...plain(z.boolean()), fallback: false },
    [VOICEMAIL_MAX_SECONDS_SETTING]: { ...plain(voicemailMaxSecondsSchema), fallback: DEFAULT_VOICEMAIL_MAX_SECONDS },
    [VOICEMAIL_LANGUAGE_SETTING]: { ...plain(voicemailLanguageSchema), fallback: DEFAULT_VOICEMAIL_LANGUAGE },
  };
  // Uma chave por motor que pede chave: motor novo na pasta ganha a configuração sem editar aqui.
  for (const engine of engines) if (!engine.keyless) definitions[engineKeySetting(engine.id)] = { ...secretText, engine };
  // Onde a classificação do desfecho acontece, por motor, para quem paga um provedor compatível com
  // OpenAI em vez da OpenAI. A voz em tempo real não muda. Ausente vale o endereço, o modelo e a
  // chave do motor, que é o de hoje: quem não configura nada não vê diferença no pedido.
  for (const engine of engines) if (!engine.keyless && engine.classifyTarget) definitions[engineClassifyTargetSetting(engine.id)] = classifyTargetOf(engine);
  return Object.hasOwn(definitions, key) ? definitions[key] : undefined;
}
