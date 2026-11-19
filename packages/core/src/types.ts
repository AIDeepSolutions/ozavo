import type { Pool, QueryResultRow } from "pg";

/** Relógio injetável. Código de produto nunca chama `new Date()` direto: recebe um `Clock`. */
export interface Clock {
  now(): Date;
}

export interface Db {
  /** Pool do papel de aplicação (`ozavo_app`), sujeito a RLS. */
  pool: Pool;
  /** Pool do papel de sistema (`ozavo_system`), que atravessa organizações. Só `withSystem` usa. */
  systemPool?: Pool;
  /** Endereços das conexões, para a saúde dizer se alguma atravessa a rede sem TLS verificado. */
  appUrl?: string;
  systemUrl?: string;
  close(): Promise<void>;
}

/**
 * Consulta presa a uma organização. Só existe dentro de `withOrg` (ou de `withSystem`,
 * para o punhado de operações que atravessam organizações: login, fila, roteamento de chamada).
 */
export interface OrgQuery {
  organizationId: string;
  many<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string, params?: unknown[]): Promise<number>;
}

export const CALL_EVENT_KINDS = [
  "call_started",
  "call_answered",
  "recording_notice",
  "transcript_user",
  "transcript_agent",
  "transcription_failed",
  "tool_called",
  "tool_result",
  "approval_requested",
  "approval_decided",
  "human_notified",
  "dtmf_sent",
  "transfer_started",
  "transfer_completed",
  "engine_failed",
  "call_refused",
  "voicemail_left",
  "voicemail_failed",
  "cost_ceiling_reached",
  "recording_skipped",
  "recording_failed",
  "recording_saved",
  "recording_paused",
  "call_ended",
  "task_queued",
  "task_finished",
  "follow_up_created",
  "follow_up_assigned",
  "follow_up_closed",
  "outcome_not_classified",
  "call_analyzed",
  "analysis_not_done",
  "caller_unanswered",
  "turn_latency",
  "llm_call",
  "webhook_queue_failed",
] as const;

export type CallEventKind = (typeof CALL_EVENT_KINDS)[number];

/**
 * O que acontece na organização fora de uma chamada e precisa ficar registrado
 * (`organization_events`). Fechado como o da chamada: acontecimento novo entra aqui.
 */
export const PRIVACY_EVENT_KINDS = ["recording_retention_changed", "recordings_purged", "transcript_retention_changed", "transcripts_purged", "caller_data_exported", "call_recording_changed", "caller_data_erased", "caller_recordings_erased", "share_created", "share_downloaded", "share_revoked", "caller_notes_purged", "caller_notes_retention_changed", "remote_recordings_orphans_purged"] as const;

/**
 * O que a empresa faz com o acesso de sistemas de fora (chaves de API, provisionamento e perfil) e o
 * que a plataforma faz com ela pela área de empresas (suspender, reativar, renovar o convite de dono,
 * trocar o plano).
 */
export const ACCESS_EVENT_KINDS = ["api_key_created", "api_key_revoked", "tenant_provisioned", "tenant_profile_changed", "tenant_status_changed", "tenant_owner_invite_renewed", "tenant_plan_changed", "tenant_rcd_changed"] as const;

/**
 * O plano da organização: troca de plano, aviso de franquia e redução de cadência por chamadas curtas.
 * `tenant_critical_alert` é gravado na plataforma quando uma empresa cliente recebe um desses alertas.
 */
export const PLAN_EVENT_KINDS = ["plan_changed", "plan_usage_alert", "cadence_reduced", "tenant_critical_alert"] as const;

/**
 * Webhooks da empresa: o cadastro de um destino, o resultado de cada entrega e o que entrou por
 * `POST /api/v1/hooks/[slug]`. `webhook_failed` vale por tentativa; o campo `final` diz se foi a última.
 */
export const WEBHOOK_EVENT_KINDS = ["webhook_subscription_created", "webhook_subscription_changed", "webhook_subscription_removed", "webhook_secret_rotated", "webhook_delivered", "webhook_failed", "webhook_queue_failed", "inbound_hook_received"] as const;

export const ORG_EVENT_KINDS = [...PRIVACY_EVENT_KINDS, ...ACCESS_EVENT_KINDS, ...PLAN_EVENT_KINDS, ...WEBHOOK_EVENT_KINDS, "asaas_subscription_changed", "asaas_config_changed"] as const;

export type OrgEventKind = (typeof ORG_EVENT_KINDS)[number];

export type CallStatus = "ringing" | "in_progress" | "transferred" | "completed" | "failed" | "refused";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ApprovalOutcome = Exclude<ApprovalStatus, "pending">;

export interface ClaimedTask {
  id: string;
  organizationId: string;
  callId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface Config {
  databaseUrl: string;
  /** Conexão do papel de sistema (`ozavo_system`); alimenta `withSystem` e a fila. */
  systemDatabaseUrl: string;
  /** Conexão do dono do schema; só o comando de migrations a recebe. */
  migrationDatabaseUrl?: string;
  secretKey: Buffer;
  publicUrl: string;
  ariUrl: string;
  ariApp: string;
  ariUsername: string;
  ariPassword: string;
  audioSocketPort: number;
  panelPort: number;
}
