// Só tipos e contas puras da área de plataforma: o compilador apaga os tipos, nada do servidor vem junto.
import type { PlatformTenantStatus } from "@ozavo/core";

export type { PlatformTenantStatus };

export interface TenantRow {
  organizationId: string;
  name: string;
  legalName: string | null;
  tradeName: string | null;
  cnpj: string | null;
  createdAt: string;
  planCode: string | null;
  status: PlatformTenantStatus;
  origin: { kind: "asaas" } | { kind: "panel" } | { kind: "api"; source: string } | { kind: "unknown" };
  usage: { consumedSeconds: number; includedSeconds: number; period: { start: string; end: string } } | null;
  usageAlert: number | null;
  activeBreakers: number;
  lines: number;
  ownerInvite: { ownerActive: boolean; pending: { email: string; expiresAt: string; expired: boolean } | null };
}

export interface TenantDetail extends TenantRow {
  billedByAsaas: boolean;
  finops: {
    subscription: { plan: string; monthlyPriceCents: number; includedMinutes: number; maxConcurrentCalls: number } | null;
    period: { start: string; end: string };
    consumedSeconds: number;
    includedSeconds: number | null;
    answeredCalls: number;
    providerCostUsdCents: number;
    margin: { revenueCents: number; variableCostCents: number | null; grossMarginCents: number | null; grossMarginPercent: number | null };
    alerts: Array<{ threshold: number; at: string }>;
    cadenceBreakers: Array<{ lineE164: string; trippedAt: string }>;
  };
  events: Array<{ id: string; at: string; kind: string; payload: Record<string, unknown> }>;
}

/** "12345678000195" -> "12.345.678/0001-95"; outro formato volta como veio. */
export function formatCnpj(digits: string): string {
  return /^\d{14}$/.test(digits) ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : digits;
}

/** Minutos começados, como a franquia conta. */
export const minutesOf = (seconds: number): number => Math.ceil(Math.max(0, seconds) / 60);

/** Quanto da franquia já foi, de 0 a 100 (para a barra; o texto mostra o número real). */
export function usagePercent(consumedSeconds: number, includedSeconds: number): number {
  if (includedSeconds <= 0) return consumedSeconds > 0 ? 100 : 0;
  return Math.min(100, Math.round((consumedSeconds / includedSeconds) * 100));
}

/** "1.997,00", "1997,5" ou "1997" -> centavos; `null` se não for valor em reais. */
export function reaisToCents(text: string): number | null {
  const clean = text.trim().replace(/\s/g, "");
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(clean)) return null;
  // Ponto seguido de três dígitos, sem vírgula, é milhar ("1.997"), não decimal.
  const thousands = clean.includes(",") || /^\d{1,3}(\.\d{3})+$/.test(clean);
  const normalized = thousands ? clean.replace(/\./g, "").replace(",", ".") : clean;
  return Math.round(Number(normalized) * 100);
}

/** Inteiro não negativo escrito sem separador; `null` se não for. */
export function wholeNumber(text: string): number | null {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
}
