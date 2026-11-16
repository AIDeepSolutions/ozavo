import { loadConfig, type OrgQuery } from "@ozavo/core";
import type { AgendaClient } from "./connectors/agenda";
import { agendaConnectorReady, agendaFromSettings, readAgendaConnector } from "./connectors/agenda-settings";
import type { WhatsAppDeps } from "./connectors/whatsapp";

/** O que uma ferramenta que fala com a rede recebe de fora; em teste, tudo falso. */
export interface ToolDeps extends WhatsAppDeps {
  /** Chave que decifra os segredos de `settings`. Padrão: a da configuração do processo. */
  secretKey?: () => Buffer;
  /**
   * Cliente da agenda. Sem ele, as ferramentas de agenda recusam em voz alta e nada é gravado —
   * é o estado de hoje: o conector com o CRM é a fatia seguinte.
   */
  agenda?: AgendaClient;
  /**
   * A agenda da empresa da ligação, montada a partir da configuração dela (`agenda.connector`).
   * `null`: a empresa não configurou agenda. É o caminho de produção; `agenda` é o do teste.
   */
  agendaFor?: (q: OrgQuery) => Promise<AgendaClient | null>;
  /** A empresa tem agenda pronta. Sem ela, a sessão não oferece as ferramentas de agenda ao motor. */
  agendaReady?: (q: OrgQuery) => Promise<boolean>;
}

export const configSecretKey = (): Buffer => loadConfig(process.env).secretKey;

/** As ferramentas de agenda de produção: a agenda vem da configuração de cada empresa. */
export const settingsAgendaDeps = (): ToolDeps => ({
  agendaFor: (q) => agendaFromSettings(q, configSecretKey(), { maxBytes: 256 * 1024 }),
  agendaReady: async (q) => agendaConnectorReady(await readAgendaConnector(q)),
});

/** O cliente da agenda para esta ligação: o injetado, ou o da empresa. */
export async function agendaOf(deps: ToolDeps, q: OrgQuery): Promise<AgendaClient | null> {
  return deps.agenda ?? (await deps.agendaFor?.(q)) ?? null;
}

/** Disponível = existe um caminho até uma agenda; pronta = esta empresa tem uma. */
export const agendaAvailability = (deps: ToolDeps): { available: boolean; ready?: (q: OrgQuery) => Promise<boolean> } => ({
  available: deps.agenda !== undefined || deps.agendaFor !== undefined,
  ...(deps.agenda === undefined && deps.agendaReady !== undefined && { ready: deps.agendaReady }),
});
